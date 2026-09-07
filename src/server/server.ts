import fs from "node:fs";
import path from "node:path";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { config } from "./config.js";
import { constantTimeEqual, signSession, verifySession } from "./crypto.js";
import {
  authenticateCustomer,
  applyBulkAction,
  createRebind,
  createCustomerGrant,
  deactivateAccount,
  customerMailDetail,
  getAccountDetail,
  getCurrentCustomerExport,
  grantById,
  grantByPublicToken,
  ingestPaymentExposureChecks,
  listAccounts,
  listAccountGrants,
  listCustomerMails,
  listPendingReviews,
  listRedGroups,
  importAccounts,
  migrationReport,
  overview,
  primaryEmailForAccount,
  recycleAccount,
  resolvePendingReview,
  revealCredentials,
  revokeCustomerGrant,
  updateAccount,
} from "./repository.js";
import {
  getPaymentExposureCheckStatus,
  listPaymentExposureRoutes,
  startPaymentExposureCheck,
  startTrialCheck,
} from "./payment-exposure.js";
import { fetchOutlookMessage, fetchSharedMessage } from "./upstream-mail.js";

const app = Fastify({ logger: true, disableRequestLogging: true, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
await app.register(cookie);

const webRoot = path.join(config.projectRoot, "dist/web");
const releaseManifestPath = path.join(config.projectRoot, "dist", "release-manifest.json");
function releaseManifest(): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
app.get("/assets/:file", async (request, reply) => {
  const requested = String((request.params as any).file || "");
  if (!requested || path.basename(requested) !== requested) return reply.code(404).send({ error: "资源不存在" });
  const assetPath = path.join(webRoot, "assets", requested);
  if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) return reply.code(404).send({ error: "资源不存在" });
  const extension = path.extname(assetPath).toLowerCase();
  const contentType = extension === ".js" ? "application/javascript; charset=utf-8" : extension === ".css" ? "text/css; charset=utf-8" : "application/octet-stream";
  reply.type(contentType).header("cache-control", "public, max-age=31536000, immutable");
  return reply.send(fs.createReadStream(assetPath));
});

app.addHook("onSend", async (_request, reply, payload) => {
  reply.header("cache-control", "no-store");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  reply.header("x-robots-tag", "noindex, nofollow, noarchive");
  return payload;
});

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function consumeRate(request: FastifyRequest, scope: string, max: number): boolean {
  const key = `${scope}:${request.ip}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

function sameOrigin(request: FastifyRequest): boolean {
  const origin = String(request.headers.origin || "");
  if (!origin) return true;
  const proto = String(request.headers["x-forwarded-proto"] || request.protocol).split(",")[0];
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "").split(",")[0];
  return origin === `${proto}://${host}`;
}

function adminSession(request: FastifyRequest): boolean {
  const session = verifySession(String(request.cookies.mail_opus_v2_admin || ""));
  return Boolean(session && session.type === "admin" && session.id === "administrator");
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (adminSession(request)) return true;
  reply.code(401).send({ error: "未登录" });
  return false;
}

function requireWrite(reply: FastifyReply): boolean {
  if (!config.readOnly) return true;
  reply.code(409).send({ error: "V2当前处于只读影子验证阶段，写入仍由V1负责" });
  return false;
}

function customerGrant(request: FastifyRequest) {
  const session = verifySession(String(request.cookies.mail_opus_v2_session || ""));
  return session?.type === "customer" ? grantById(session.id) : null;
}

function setSessionCookie(reply: FastifyReply, name: string, value: string): void {
  reply.setCookie(name, value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 12 * 60 * 60 });
}

app.get("/health", async () => ({ ok: true, service: "mail-opus-viewer-v2", readOnly: config.readOnly, release: releaseManifest() }));
app.get("/api/v2/version", async () => ({ ok: true, release: releaseManifest() }));
app.get("/api/v2/status", async (request, reply) => requireAdmin(request, reply) ? overview() : undefined);

app.post("/api/v2/admin/login", async (request, reply) => {
  if (!consumeRate(request, "admin-login", 8)) return reply.code(429).send({ error: "登录尝试过多" });
  if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
  const body = request.body as any;
  if (!config.adminPassword || !constantTimeEqual(String(body?.password || ""), config.adminPassword)) return reply.code(401).send({ error: "后台口令不正确" });
  setSessionCookie(reply, "mail_opus_v2_admin", signSession("admin", "administrator"));
  return { ok: true };
});

app.post("/api/v2/admin/logout", async (_request, reply) => {
  reply.clearCookie("mail_opus_v2_admin", { path: "/" });
  return { ok: true };
});
app.get("/api/v2/admin/session", async (request, reply) => adminSession(request) ? { ok: true, readOnly: config.readOnly } : reply.code(401).send({ error: "未登录" }));

app.get("/api/v2/admin/overview", async (request, reply) => requireAdmin(request, reply) ? overview() : undefined);
app.get("/api/v2/admin/accounts", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const query = request.query as any;
  return listAccounts({
    search: String(query.search || ""), range: query.range || "all", status: String(query.status || ""),
    provider: String(query.provider || ""), billingChannel: String(query.billingChannel || ""), sold: String(query.sold || ""), plan: String(query.plan || ""),
    credential: String(query.credential || ""), sourceStatus: String(query.sourceStatus || ""), unused: String(query.unused || ""),
    redGroup: String(query.redGroup || ""), markColor: String(query.markColor || ""), pending: String(query.pending || ""),
    limit: Number(query.limit || 80), offset: Number(query.offset || 0),
  });
});
app.get("/api/v2/admin/red-groups", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return { results: listRedGroups() };
});
app.get("/api/v2/admin/pending-reviews", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return { results: listPendingReviews() };
});
app.post("/api/v2/admin/pending-reviews/:id/resolve", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireWrite(reply)) return;
  try {
    return resolvePendingReview(String((request.params as any).id), String((request.body as any)?.action || ""));
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/migration-report", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return migrationReport();
});
app.get("/api/v2/admin/payment-exposure/routes", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return { routes: listPaymentExposureRoutes() };
});
// This diagnostic starts an AutoMyAI read-only probe. It intentionally bypasses
// V2's shadow-write gate; the only V2 write is the sanitized callback result.
app.post("/api/v2/admin/accounts/:id/payment-exposure-check", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  if (!consumeRate(request, "payment-exposure-start", 30)) return reply.code(429).send({ error: "支付检查请求过多" });
  try {
    const body = request.body as any;
    const routeKey = String(body?.routeKey || body?.route || "").trim().toLowerCase();
    return await startPaymentExposureCheck(String((request.params as any).id), routeKey);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "支付检查启动失败" });
  }
});
app.post("/api/v2/admin/accounts/:id/trial-check", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  if (!consumeRate(request, "trial-check-start", 30)) return reply.code(429).send({ error: "试用检测请求过多" });
  try {
    return await startTrialCheck(String((request.params as any).id));
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "试用检测启动失败" });
  }
});
app.get("/api/v2/admin/accounts/:id/payment-exposure-check/:jobId", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    return await getPaymentExposureCheckStatus(String((request.params as any).id), String((request.params as any).jobId));
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "支付检查任务不存在" });
  }
});
app.get("/api/v2/admin/accounts/:id", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const item = getAccountDetail(String((request.params as any).id));
  return item || reply.code(404).send({ error: "账号不存在" });
});

// AutoMyAI publishes only sanitized, structured observations here. This is an
// integration write, so it remains available while the admin shadow database
// is read-only and uses its own API key instead of the admin/import key.
app.post("/api/v2/internal/payment-exposure-check", async (request, reply) => {
  if (!config.paymentExposureApiKey) return reply.code(503).send({ error: "支付方式检查接收API未配置" });
  const provided = String(request.headers["x-api-key"] || "").trim();
  if (!constantTimeEqual(provided, config.paymentExposureApiKey)) return reply.code(401).send({ error: "API密钥无效" });
  if (!consumeRate(request, "payment-exposure-ingest", 2000)) return reply.code(429).send({ error: "支付检查接收请求过多" });
  const body = request.body as any;
  const checks = Array.isArray(body) ? body : Array.isArray(body?.checks) ? body.checks : body && typeof body === "object" ? [body] : [];
  if (!checks.length) return reply.code(400).send({ error: "请求必须包含单条检查记录或 checks 数组" });
  if (checks.length > 500) return reply.code(413).send({ error: "单次最多接收500条检查记录" });
  return { ok: true, ...ingestPaymentExposureChecks(checks) };
});

app.get("/api/v2/admin/accounts/:id/credentials", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  const item = revealCredentials(String((request.params as any).id));
  return item || reply.code(404).send({ error: "凭证不存在" });
});
app.post("/api/v2/admin/accounts/bulk-credentials", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  const body = request.body as any;
  const ids = [...new Set<string>((Array.isArray(body?.accountIds) ? body.accountIds : []).map((value: unknown) => String(value)).filter(Boolean))].slice(0, 500);
  if (!ids.length) return reply.code(400).send({ error: "没有选择账号" });
  const results = ids.map((id) => {
    const credentials = revealCredentials(id);
    return {
      id,
      primaryEmail: primaryEmailForAccount(id),
      accessToken: String(credentials?.accessToken || ""),
    };
  });
  return { results };
});
app.get("/api/v2/admin/accounts/:id/current-export", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  const item = getCurrentCustomerExport(String((request.params as any).id));
  if (!item) return reply.code(404).send({ error: "账号没有当前邮箱绑定" });
  if (!item.available) return reply.code(409).send({ error: item.reason, currentEmail: item.currentEmail });
  return item;
});
app.post("/api/v2/admin/accounts/bulk-current-export", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  const body = request.body as any;
  const ids = [...new Set<string>((Array.isArray(body?.accountIds) ? body.accountIds : []).map((value: unknown) => String(value)).filter(Boolean))].slice(0, 500);
  if (!ids.length) return reply.code(400).send({ error: "没有选择账号" });
  const results = ids.map((id) => {
    const item = getCurrentCustomerExport(id);
    return item ? { id, ...item } : { id, available: false, currentEmail: "", loginIdentifier: "", publicUrl: "", text: "", reason: "账号没有当前邮箱绑定" };
  });
  return { results };
});
app.patch("/api/v2/admin/accounts/:id", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireWrite(reply)) return;
  try {
    const item = updateAccount(String((request.params as any).id), request.body as any);
    return item || reply.code(404).send({ error: "账号不存在" });
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/accounts/:id/rebind", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireWrite(reply)) return;
  try { return createRebind(String((request.params as any).id), String((request.body as any)?.email || "")); }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/accounts/:id/deactivate", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireWrite(reply)) return;
  try { return deactivateAccount(String((request.params as any).id), String((request.body as any)?.reason || "admin_manual")); }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/accounts/:id/recycle", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireWrite(reply)) return;
  try {
    const body = request.body as any;
    return recycleAccount(String((request.params as any).id), String(body?.email || ""), String(body?.plan || "free"));
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/accounts/:id/grants", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return { results: listAccountGrants(String((request.params as any).id)) };
});
app.post("/api/v2/admin/accounts/:id/grants", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireWrite(reply)) return;
  try {
    const body = request.body as any;
    return createCustomerGrant(String((request.params as any).id), String(body?.bindingId || ""), body || {});
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.delete("/api/v2/admin/accounts/:id/grants/:grantId", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireWrite(reply)) return;
  const params = request.params as any;
  return revokeCustomerGrant(String(params.id), String(params.grantId)) ? { ok: true } : reply.code(404).send({ error: "授权不存在" });
});
app.post("/api/v2/admin/accounts/bulk", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireWrite(reply)) return;
  try {
    const body = request.body as any;
    return applyBulkAction(Array.isArray(body?.accountIds) ? body.accountIds : [], String(body?.action || ""), body?.value);
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/import/accounts", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireWrite(reply)) return;
  const body = request.body as any;
  if (!Array.isArray(body?.accounts)) return reply.code(400).send({ error: "accounts 必须是数组" });
  return importAccounts(body.accounts);
});

async function establishPreset(request: FastifyRequest, reply: FastifyReply, token: string) {
  if (!consumeRate(request, "preset", 60)) return reply.code(429).send({ error: "请求过多" });
  const grant = grantByPublicToken(token);
  if (!grant) return reply.code(404).send({ error: "账号不存在、未授权或仍在管理员确认中" });
  setSessionCookie(reply, "mail_opus_v2_session", signSession("customer", grant.id));
  return { ok: true, label: grant.label };
}
app.get("/api/preset", async (request, reply) => {
  return reply.code(405).send({ error: "查询参数授权已停用，请使用新版片段链接" });
});
app.post("/api/preset", async (request, reply) => {
  if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
  return establishPreset(request, reply, String((request.body as any)?.m || ""));
});

app.post("/api/login", async (request, reply) => {
  if (!consumeRate(request, "customer-login", 20)) return reply.code(429).send({ error: "登录尝试过多" });
  if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
  const body = request.body as any;
  const grant = authenticateCustomer(String(body?.email || ""), String(body?.password || ""));
  if (!grant) return reply.code(401).send({ error: "邮箱或密码不正确，或新绑定尚未分配客户权限" });
  setSessionCookie(reply, "mail_opus_v2_session", signSession("customer", grant.id));
  return { ok: true, label: grant.label };
});
app.post("/api/logout", async (_request, reply) => {
  reply.clearCookie("mail_opus_v2_session", { path: "/" });
  return { ok: true };
});
app.get("/api/session", async (request, reply) => {
  const grant = customerGrant(request);
  return grant ? { ok: true, label: grant.label, hidePromotion: grant.hidePromotion } : reply.code(401).send({ error: "未登录" });
});
app.get("/api/mails", async (request, reply) => {
  const grant = customerGrant(request);
  if (!grant) return reply.code(401).send({ error: "未登录" });
  const query = request.query as any;
  const offset = Math.max(0, Number(query.offset || 0));
  const limit = Math.max(1, Math.min(30, Number(query.limit || 30)));
  return { label: grant.label, ...listCustomerMails(grant, offset, limit) };
});
app.get("/api/mail-detail", async (request, reply) => {
  const grant = customerGrant(request);
  if (!grant) return reply.code(401).send({ error: "未登录" });
  const message = customerMailDetail(grant, String((request.query as any).id || ""));
  if (!message) return reply.code(404).send({ error: "邮件不存在或不属于当前授权" });
  let text = "";
  if (message.provider === "shared-mail-api") {
    const upstream = await fetchSharedMessage(String(message.provider_message_id)).catch(() => null);
    text = upstream?.text || "";
  } else if (String(message.provider || "").startsWith("outlook:")) {
    const upstream = await fetchOutlookMessage(
      String(message._upstreamMailboxEmail || ""),
      String(message.provider_message_id || ""),
      String(message.folder || "inbox"),
    ).catch(() => null);
    text = upstream?.text || "";
  }
  return { ok: true, mail: { from: message.sender, subject: message.subject, created_at: message.received_at, folder: message.folder, text: text || "邮件正文暂时无法从上游读取。" } };
});

app.get("/api/v2/import/accounts", async (_request, reply) => reply.code(405).send({ error: "请使用POST" }));
app.post("/api/v2/import/accounts", async (request, reply) => {
  if (!consumeRate(request, "v2-import", 60)) return reply.code(429).send({ error: "导入请求过多" });
  if (!config.importApiKey) return reply.code(503).send({ error: "导入API未配置" });
  const provided = String(request.headers["x-api-key"] || "").trim();
  if (!constantTimeEqual(provided, config.importApiKey)) return reply.code(401).send({ error: "API密钥无效" });
  if (!requireWrite(reply)) return;
  const body = request.body as any;
  if (!Array.isArray(body?.accounts)) return reply.code(400).send({ error: "accounts 必须是数组" });
  return importAccounts(body.accounts);
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const status = Number((error as any).statusCode || 500);
  reply.code(status).send({ error: status >= 500 ? "服务异常" : (error instanceof Error ? error.message : String(error)) });
});

app.get("/*", async (_request, reply) => {
  if (!fs.existsSync(path.join(webRoot, "index.html"))) return reply.code(503).type("text/plain").send("V2 web assets are not built");
  return reply.type("text/html; charset=utf-8").send(fs.createReadStream(path.join(webRoot, "index.html")));
});

await app.listen({ host: "127.0.0.1", port: config.port });
