import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { constantTimeEqual, decryptSecret, digestToken, encryptSecret, hashPassword, signSession, verifySession } from "./crypto.js";
import { db } from "./db.js";
import { authenticateCustomer, customerMailDetail, grantById, grantByPublicToken, listCustomerMails, type GrantRecord } from "./repository.js";
import { fetchOutlookMessage, fetchSharedMessage } from "./upstream-mail.js";
import { customerHtml, customerScript } from "./customer-assets.js";
import { customerLoginCss, customerLoginPage, customerLoginScript } from "./customer-login-theme.js";
import { fetchExternalMessage } from "./external-mailbox.js";

export interface CustomerRouteContext {
  consumeRate(request: FastifyRequest, scope: string, max: number): boolean;
  sameOrigin(request: FastifyRequest): boolean;
  requireWrite(reply: FastifyReply): boolean;
  setSessionCookie(reply: FastifyReply, name: string, value: string, request: FastifyRequest): void;
}

export function customerSessionSummary(grant: GrantRecord) {
  const row = db.prepare(`SELECT g.login_identifier_enc,a.lifecycle_status,a.admin_deactivated_at FROM access_grants g
    JOIN gpt_accounts a ON a.id=g.account_id WHERE g.id=?`).get(grant.id) as any;
  const administratorStopped = Boolean(String(row.admin_deactivated_at || ""));
  const historical = grant.scope === "historical" || Boolean(grant.visibleTo);
  // Mail classification is evidence only and is deliberately absent here.
  // The customer warning is emitted only after an administrator action.
  const statusMessage = administratorStopped
    ? "管理员已停用该账号；仅显示停用前且在授权范围内的邮件，之后的新邮件不再显示。"
    : historical ? "邮箱历史授权仍有效，仅可查看授权时间范围内的邮件。" : "";
  const groupWarning = sourceMailboxDeactivationWarning(grant);
  return { ok: true, label: grant.label, email: decryptSecret(String(row.login_identifier_enc || "")),
    lifecycleStatus: String(row.lifecycle_status), hidePromotion: grant.hidePromotion,
    statusMessage: [statusMessage, groupWarning].filter(Boolean).join(" ") };
}

function sourceMailboxDeactivationWarning(grant: GrantRecord): string {
  const binding = db.prepare("SELECT local_part,domain FROM email_bindings WHERE id=?").get(grant.bindingId) as any;
  const domain = String(binding?.domain || "").toLowerCase();
  const localPart = String(binding?.local_part || "").toLowerCase();
  if (!(domain === "icloud.com" || domain.endsWith(".icloud.com")) || !localPart) return "";
  const poolLocalPart = localPart.replace(/\+oai[a-z0-9]+$/i, "");
  const bindings = (db.prepare(`SELECT b.id,b.local_part FROM email_bindings b
    JOIN gpt_accounts a ON a.id=b.account_id
    WHERE b.domain=? AND b.is_current=1 AND a.deleted_at=''`).all(domain) as any[])
    .filter((item) => String(item.local_part || "").toLowerCase().replace(/\+oai[a-z0-9]+$/i, "") === poolLocalPart);
  const bindingIds = bindings.map((item) => String(item.id || "")).filter(Boolean);
  if (!bindingIds.length) return "";
  const placeholders = bindingIds.map(() => "?").join(",");
  const row = db.prepare(`SELECT COUNT(DISTINCT m.id) AS count, MAX(m.received_at) AS latest
    FROM mail_messages m JOIN mail_ownership_claims c ON c.message_id=m.id
    WHERE m.category='deactivation' AND c.binding_id IN (${placeholders})`).get(...bindingIds) as any;
  const count = Number(row?.count || 0);
  if (!count) return "";
  const latest = String(row?.latest || "");
  const latestLabel = latest ? `（最近一封：${latest}）` : "";
  return `源邮箱组检测到 ${count} 封疑似封禁邮件${latestLabel}；邮件未明确对应哪个子邮箱，暂不能据此判定当前子邮箱已封号。`;
}

function customerPasswordVersion(grantId: string): string {
  const row = db.prepare("SELECT password_hash FROM access_grants WHERE id=? AND active=1 AND scope!='admin_only'").get(grantId) as any;
  return row ? digestToken(JSON.stringify([grantId, String(row.password_hash || "")])) : "";
}

function signCustomerSession(grant: GrantRecord): string {
  return signSession("customer", JSON.stringify([grant.id, customerPasswordVersion(grant.id)]));
}

function customerSessionGrant(token: string): GrantRecord | null {
  const session = verifySession(token);
  if (session?.type !== "customer") return null;
  try {
    const [id, version] = JSON.parse(session.id);
    if (typeof id !== "string" || typeof version !== "string" || !version
      || !constantTimeEqual(version, customerPasswordVersion(id))) return null;
    return grantById(id);
  } catch { return null; }
}

function customerAddressRedactor(grant: GrantRecord, messageIds: string[]) {
  const login = customerSessionSummary(grant).email;
  const addresses: string[] = [];
  if (messageIds.length) {
    const rows = db.prepare(`SELECT recipient_enc FROM mail_messages WHERE id IN (${messageIds.map(() => "?").join(",")})`).all(...messageIds) as any[];
    addresses.push(...rows.map((row) => decryptSecret(String(row.recipient_enc || ""))));
  }
  const connections = db.prepare("SELECT manager_email_enc FROM mailbox_connections WHERE binding_id=?").all(grant.bindingId) as any[];
  addresses.push(...connections.map((row) => decryptSecret(String(row.manager_email_enc || ""))));
  const binding = db.prepare("SELECT source_json,local_part,domain FROM email_bindings WHERE id=?").get(grant.bindingId) as any;
  try {
    const metadata = JSON.parse(String(binding?.source_json || "{}"))?.compatibility;
    addresses.push(String(metadata?.sourceEmail || ""), String(metadata?.toEmail || ""));
  } catch {}
  const domain = String(binding?.domain || "").toLowerCase();
  const localPart = String(binding?.local_part || "").toLowerCase();
  if ((domain === "icloud.com" || domain.endsWith(".icloud.com")) && localPart) {
    const poolLocalPart = localPart.replace(/\+oai[a-z0-9]+$/i, "");
    const siblings = db.prepare(`SELECT email_enc,local_part FROM email_bindings
      WHERE domain=? AND id<>?`).all(domain, grant.bindingId) as any[];
    for (const sibling of siblings) {
      const siblingLocalPart = String(sibling.local_part || "").toLowerCase();
      if (siblingLocalPart.replace(/\+oai[a-z0-9]+$/i, "") !== poolLocalPart) continue;
      addresses.push(decryptSecret(String(sibling.email_enc || "")));
    }
  }
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match literal, URI-encoded and HTML numeric-entity forms without decoding markup.
  const patterns = [...new Set(addresses.map((address) => address.trim().toLowerCase()))]
    .filter((address) => address && address !== login.toLowerCase())
    .map((address) => new RegExp([...address].map((character) => {
      const code = character.charCodeAt(0);
      const alternatives = [escapeRegex(character), `%${code.toString(16).padStart(2, "0")}`, `&#0*${code};`, `&#x0*${code.toString(16)};`];
      if (character === "@") alternatives.push("&commat;");
      if (character === ".") alternatives.push("&period;");
      return `(?:${alternatives.join("|")})`;
    }).join(""), "gi"));
  return (value: string) => patterns.reduce((content, pattern) => content.replace(pattern,
    (matched) => matched.includes("%") ? encodeURIComponent(login) : login), value);
}

export async function readCustomerMail(grant: GrantRecord, messageId: string, passwordVersion = customerPasswordVersion(grant.id)) {
  const row = customerMailDetail(grant, messageId);
  if (!row) return null;
  let detail;
  if (row.provider === "shared-mail-api") {
    const recipient = db.prepare("SELECT recipient_enc FROM mail_messages WHERE id=?").get(messageId) as any;
    detail = await fetchSharedMessage(String(row.provider_message_id), decryptSecret(String(recipient?.recipient_enc || "")));
  } else if (String(row.provider).startsWith("outlook:")) {
    const connection = db.prepare("SELECT manager_email_enc FROM mailbox_connections WHERE binding_id=?").get(grant.bindingId) as any;
    const mailbox = decryptSecret(String(connection?.manager_email_enc || ""));
    if (!mailbox) throw Object.assign(new Error("邮箱连接未配置"), { statusCode: 503 });
    detail = await fetchOutlookMessage(mailbox, String(row.provider_message_id), String(row.folder || "inbox"));
  } else if (String(row.provider).startsWith("external:")) {
    detail = await fetchExternalMessage(grant.accountId, messageId, grant.bindingId);
  } else {
    throw Object.assign(new Error("该邮件来源尚未配置按 ID 读取"), { statusCode: 503 });
  }
  if (!detail) return null;
  // Authorization may have changed while the upstream request was in flight.
  const currentGrant = grantById(grant.id);
  if (!currentGrant || !constantTimeEqual(passwordVersion, customerPasswordVersion(grant.id))
    || !customerMailDetail(currentGrant, messageId)) return null;
  const receivedAt = Date.parse(detail.receivedAt);
  if (!Number.isFinite(receivedAt) || (currentGrant.visibleFrom && receivedAt < Date.parse(currentGrant.visibleFrom))
    || (currentGrant.visibleTo && receivedAt >= Date.parse(currentGrant.visibleTo))) return null;
  const sanitize = customerAddressRedactor(currentGrant, [messageId]);
  return { ok: true, mail: { id: row.id, from: sanitize(detail.from), subject: sanitize(detail.subject),
    created_at: detail.receivedAt, folder: row.folder || "inbox", text: sanitize(detail.text), html: sanitize(detail.html) } };
}

export async function registerCustomerRoutes(app: FastifyInstance, context: CustomerRouteContext) {
  const { consumeRate, sameOrigin, requireWrite, setSessionCookie } = context;
  function access(request: FastifyRequest, reply: FastifyReply) {
    const grant = customerSessionGrant(String(request.cookies.mail_opus_v2_customer || ""));
    if (!grant) reply.code(401).send({ error: "未登录" });
    return grant;
  }
  const page = async (_request: FastifyRequest, reply: FastifyReply) => reply.type("text/html; charset=utf-8").send(customerLoginPage(customerHtml));
  app.get("/customer", page);
  app.get("/customer-login.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(customerLoginCss));
  app.get("/customer.js", async (_request, reply) => reply.type("application/javascript; charset=utf-8").send(
    `${customerScript}\n${customerLoginScript}\n`,
  ));
  app.get("/api/preset", async (request, reply) => {
    if (!consumeRate(request, "customer-preset", 60)) return reply.code(429).send({ error: "请求过多" });
    const grant = grantByPublicToken(String((request.query as any)?.m || ""));
    if (!grant) return reply.code(404).send({ error: "账号不存在" });
    const row = db.prepare("SELECT login_identifier_enc,password_plain_enc FROM access_grants WHERE id=?").get(grant.id) as any;
    const password = decryptSecret(String(row.password_plain_enc || ""));
    if (!password) return reply.code(404).send({ error: "账号不存在" });
    return { email: decryptSecret(row.login_identifier_enc), password, label: grant.label };
  });
  app.post("/api/login", async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
    if (!consumeRate(request, "customer-login", 20)) return reply.code(429).send({ error: "登录尝试过多" });
    const body = request.body as any;
    const grant = authenticateCustomer(String(body?.email || body?.login || ""), String(body?.password || ""));
    if (!grant) return reply.code(401).send({ error: "邮箱或密码不正确" });
    setSessionCookie(reply, "mail_opus_v2_customer", signCustomerSession(grant), request);
    return customerSessionSummary(grant);
  });
  app.post("/api/logout", async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
    reply.clearCookie("mail_opus_v2_customer", { path: "/" });
    return { ok: true };
  });
  app.get("/api/session", async (request, reply) => {
    const grant = access(request, reply);
    return grant ? customerSessionSummary(grant) : undefined;
  });
  app.post("/api/change-password", async (request, reply) => {
    const grant = access(request, reply);
    if (!grant || !requireWrite(reply)) return;
    if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
    const password = String((request.body as any)?.password || "");
    if (!password || password.length > 4096) return reply.code(400).send({ error: "新密码无效" });
    db.prepare("UPDATE access_grants SET password_hash=?,password_plain_enc=?,updated_at=? WHERE id=? AND active=1")
      .run(hashPassword(password), encryptSecret(password), new Date().toISOString(), grant.id);
    setSessionCookie(reply, "mail_opus_v2_customer", signCustomerSession(grant), request);
    return { ok: true };
  });
  app.get("/api/mails", async (request, reply) => {
    const grant = access(request, reply);
    if (!grant) return;
    if (!consumeRate(request, "customer-list", 120)) return reply.code(429).send({ error: "请求过多" });
    const query = request.query as any;
    const clamp = (value: unknown, fallback: number, max: number) => Number.isFinite(Number(value))
      ? Math.min(max, Math.max(0, Math.trunc(Number(value)))) : fallback;
    const mails = listCustomerMails(grant, clamp(query.offset, 0, 5000), Math.max(1, clamp(query.limit, 30, 30)));
    const sanitize = customerAddressRedactor(grant, mails.results.map((mail) => String(mail.id)));
    return { ...customerSessionSummary(grant), ...mails,
      results: mails.results.map((mail) => ({ ...mail, from: sanitize(String(mail.from || "")), subject: sanitize(String(mail.subject || "")) })) };
  });
  app.get("/api/mail-detail", async (request, reply) => {
    const grant = access(request, reply);
    if (!grant) return;
    if (!consumeRate(request, "customer-detail", 60)) return reply.code(429).send({ error: "请求过多" });
    const id = String((request.query as any)?.id || "");
    if (!id || id.length > 4096) return reply.code(400).send({ error: "邮件 ID 无效" });
    return await readCustomerMail(grant, id) || reply.code(404).send({ error: "邮件不存在或不属于当前邮箱身份" });
  });
}
