import crypto from "node:crypto";
import { emailHash, normalizeEmail, parseJwtSubject } from "./association.js";
import { resolveAccountMatch } from "./account-transitions.js";
import { config } from "./config.js";
import { observeCredentialVersion } from "./credential-versions.js";
import { decryptSecret, digestToken, encryptSecret, hashPassword } from "./crypto.js";
import { db } from "./db.js";
import { importAccounts } from "./repository.js";
import { syncSub2ApiAlive } from "./sub2api-sync.js";
import { listOutlookManagerAccounts, outlookManagerFetch } from "./upstream-mail.js";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function validEmail(value: unknown): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizeEmail(value));
}

function jwtPayload(token: string): Record<string, any> {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1] || "", "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function jwtEmail(token: string): string {
  const payload = jwtPayload(token);
  const profile = payload["https://api.openai.com/profile"] || {};
  const auth = payload["https://api.openai.com/auth"] || {};
  return normalizeEmail(profile.email || auth.email || payload.email || payload.preferred_username || "");
}

function openAiJwt(token: string): boolean {
  const payload = jwtPayload(token);
  if (!Object.keys(payload).length) return false;
  const issuer = String(payload.iss || "").toLowerCase();
  const audience = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).map(String).join(" ").toLowerCase();
  return issuer.includes("openai.com") || audience.includes("openai.com") || Object.keys(payload).some((key) => key.includes("openai.com"));
}

function findJson(value: string): Record<string, any> | null {
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < value.length; end += 1) {
      const char = value[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(value.slice(start, end + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

interface ParsedCredential {
  line: number;
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  sessionToken: string;
  openaiPassword: string;
  error: string;
}

function collectCredentialObject(value: any, result: ParsedCredential, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialObject(item, result, depth + 1);
    return;
  }
  for (const [rawKey, item] of Object.entries(value)) {
    const key = rawKey.replace(/[\s-]/g, "_").toLowerCase();
    if (["email", "login", "username"].includes(key) && validEmail(item) && !result.email) result.email = normalizeEmail(item);
    else if (["accesstoken", "access_token", "at"].includes(key) && typeof item === "string") result.accessToken ||= item.replace(/^Bearer\s+/i, "").trim();
    else if (["refreshtoken", "refresh_token", "rt"].includes(key) && typeof item === "string") result.refreshToken ||= item.trim();
    else if (["idtoken", "id_token"].includes(key) && typeof item === "string") result.idToken ||= item.trim();
    else if (["sessiontoken", "session_token"].includes(key) && typeof item === "string") result.sessionToken ||= item.trim();
    else if (["password", "openaipassword", "openai_password"].includes(key) && typeof item === "string") result.openaiPassword ||= item;
    if (item && typeof item === "object") collectCredentialObject(item, result, depth + 1);
  }
}

function parseCredentialLine(raw: string, line: number): ParsedCredential | null {
  const source = raw.trim();
  if (!source) return null;
  const result: ParsedCredential = { line, email: "", accessToken: "", refreshToken: "", idToken: "", sessionToken: "", openaiPassword: "", error: "" };
  const json = findJson(source);
  if (json) collectCredentialObject(json, result);
  const email = source.match(/[^\s<>|,;]+@[^\s<>|,;]+\.[^\s<>|,;]+/i)?.[0];
  if (!result.email && validEmail(email)) result.email = normalizeEmail(email);
  for (const match of source.matchAll(/(?:^|\s)(at|access[_ -]?token|rt|refresh[_ -]?token)\s*[:=]\s*(\S+)/ig)) {
    if (/^(?:at|access)/i.test(match[1])) result.accessToken ||= match[2].trim();
    else result.refreshToken ||= match[2].trim();
  }
  if (!result.accessToken && !result.refreshToken && !result.sessionToken && !json) {
    const chunks = source.split(/\s*----+\s*|\s+/).filter(Boolean).filter((item) => !validEmail(item));
    for (const chunk of chunks) {
      if (!result.accessToken && openAiJwt(chunk)) result.accessToken = chunk;
      else if (!result.refreshToken && chunk.length >= 20 && !chunk.includes(".")) result.refreshToken = chunk;
    }
  }
  if (result.accessToken && !openAiJwt(result.accessToken)) result.error = "AT 不是有效的 OpenAI JWT";
  if (!result.accessToken && !result.refreshToken && !result.sessionToken) result.error ||= "这一行没有找到 AT、RT 或 Session Token";
  return result;
}

function parseCredentials(text: string): ParsedCredential[] {
  const json = findJson(text);
  if (json && (json.accessToken || json.access_token || json.user || json.sessionToken)) {
    const item: ParsedCredential = { line: 1, email: "", accessToken: "", refreshToken: "", idToken: "", sessionToken: "", openaiPassword: "", error: "" };
    collectCredentialObject(json, item);
    if (!item.accessToken && !item.refreshToken && !item.sessionToken) item.error = "JSON 中没有可识别的凭证";
    return [item];
  }
  const results = text.split(/\r?\n/).map(parseCredentialLine).filter((item): item is ParsedCredential => Boolean(item));
  if (!results.length) throw new Error("没有找到可处理的凭据行");
  if (results.length > 500) throw new Error("单次最多处理 500 行凭据");
  return results;
}

function resolveCredential(item: ParsedCredential): { status: string; reason: string; accountId: string; email: string; subjectHash: string } {
  if (item.error) return { status: "invalid", reason: item.error, accountId: "", email: item.email, subjectHash: "" };
  const tokenEmail = item.accessToken ? jwtEmail(item.accessToken) : "";
  const subject = item.accessToken ? parseJwtSubject(item.accessToken) : "";
  const subjectHash = subject ? sha256(subject) : "";
  if (item.email && tokenEmail && item.email !== tokenEmail) {
    const explicit = db.prepare("SELECT account_id FROM email_bindings WHERE email_hash=? ORDER BY is_current DESC LIMIT 1").get(emailHash(item.email)) as any;
    const byIdentity = subjectHash ? resolveAccountMatch(subjectHash, "") : null;
    if (!explicit || !byIdentity?.accountId || String(explicit.account_id) !== byIdentity.accountId) {
      return { status: "conflict", reason: "行内邮箱与 AT 身份指向不同账号", accountId: "", email: item.email, subjectHash };
    }
  }
  const email = item.email || tokenEmail;
  const match = resolveAccountMatch(subjectHash, email);
  if (match.kind === "conflict") return { status: "conflict", reason: match.reason, accountId: match.accountId, email, subjectHash };
  if (match.kind !== "account" || !match.accountId) return { status: "unresolved", reason: "凭证未匹配现有 GPT 身份", accountId: "", email, subjectHash };
  return { status: "ready", reason: "", accountId: match.accountId, email, subjectHash };
}

export function previewOauthBatch(textInput: unknown): Record<string, unknown> {
  const text = String(textInput || "").trim();
  const items = parseCredentials(text).map((credential) => {
    const resolution = resolveCredential(credential);
    return {
      line: credential.line, email: resolution.email, status: resolution.status, reason: resolution.reason,
      targetId: resolution.accountId, hasAccessToken: Boolean(credential.accessToken), hasRefreshToken: Boolean(credential.refreshToken),
    };
  });
  return {
    ok: true, batchHash: sha256(text), total: items.length,
    ready: items.filter((item) => item.status === "ready").length,
    conflicts: items.filter((item) => item.status === "conflict").length,
    unresolved: items.filter((item) => item.status === "unresolved").length,
    invalid: items.filter((item) => item.status === "invalid").length,
    items,
  };
}

export function applyOauthBatch(textInput: unknown, previewHash: unknown, confirmed: unknown): Record<string, unknown> {
  const text = String(textInput || "").trim();
  if (!confirmed || String(previewHash || "") !== sha256(text)) throw new Error("预览已变化，请重新预览后确认");
  const credentials = parseCredentials(text);
  let applied = 0;
  const results = credentials.map((credential) => {
    const resolution = resolveCredential(credential);
    if (resolution.status !== "ready") return { line: credential.line, status: resolution.status, reason: resolution.reason };
    const binding = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(resolution.accountId) as any;
    const observed = observeCredentialVersion({
      accountId: resolution.accountId, bindingId: String(binding?.id || "") || null,
      accessToken: credential.accessToken, refreshToken: credential.refreshToken, idToken: credential.idToken,
      sessionToken: credential.sessionToken, openaiPassword: credential.openaiPassword,
      subjectHash: resolution.subjectHash, source: "v2-oauth-batch", validityStatus: credential.accessToken ? "alive" : "unknown",
      evidence: { batchHash: sha256(text), line: credential.line },
    });
    applied += 1;
    return { line: credential.line, status: observed.conflict ? "conflict" : "applied", targetId: resolution.accountId, changed: observed.changed };
  });
  return { ok: true, applied, total: results.length, results };
}

let oauthHealthRun: Promise<void> | null = null;

async function runOauthHealth(jobId: string): Promise<void> {
  const startedAt = new Date().toISOString();
  db.prepare("UPDATE oauth_health_jobs SET status='running', started_at=?, updated_at=? WHERE id=?").run(startedAt, startedAt, jobId);
  try {
    await syncSub2ApiAlive();
    const rows = db.prepare(`SELECT a.id account_id, cc.credential_version_id, cv.validity_status,
        CASE WHEN cv.refresh_token_enc!='' THEN 1 ELSE 0 END has_refresh
      FROM gpt_accounts a LEFT JOIN account_current_credentials cc ON cc.account_id=a.id
      LEFT JOIN credential_versions cv ON cv.id=cc.credential_version_id
      WHERE a.deleted_at='' AND a.lifecycle_status='active'`).all() as any[];
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const row of rows) {
        const access = String(row.validity_status || "unknown");
        db.prepare(`INSERT INTO oauth_health_results(id, job_id, account_id, credential_version_id, access_status, refresh_status, detail, checked_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
          crypto.randomUUID(), jobId, row.account_id, row.credential_version_id || null, access,
          row.has_refresh ? access : "missing", access === "alive" ? "Sub2API 当前活跃凭证" : "当前活跃导出未确认凭证", now,
        );
      }
      const errors = rows.filter((row) => String(row.validity_status || "unknown") !== "alive").length;
      db.prepare(`UPDATE oauth_health_jobs SET status='completed', total_count=?, completed_count=?, error_count=?, finished_at=?, updated_at=? WHERE id=?`)
        .run(rows.length, rows.length, errors, now, now, jobId);
    })();
  } catch (error) {
    const now = new Date().toISOString();
    db.prepare("UPDATE oauth_health_jobs SET status='failed', error_count=1, finished_at=?, updated_at=? WHERE id=?").run(now, now, jobId);
    db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('oauth_health_last_error',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(error instanceof Error ? error.message : String(error), now);
  }
}

export function startOauthHealth(): Record<string, unknown> {
  const active = db.prepare("SELECT * FROM oauth_health_jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get() as any;
  if (active) return oauthHealthStatus(String(active.id));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO oauth_health_jobs(id,status,created_at,updated_at) VALUES(?,'queued',?,?)").run(id, now, now);
  oauthHealthRun = runOauthHealth(id).finally(() => { oauthHealthRun = null; });
  return oauthHealthStatus(id);
}

export function oauthHealthStatus(id = ""): Record<string, unknown> {
  const row = id ? db.prepare("SELECT * FROM oauth_health_jobs WHERE id=?").get(id) as any
    : db.prepare("SELECT * FROM oauth_health_jobs ORDER BY created_at DESC LIMIT 1").get() as any;
  if (!row) return { status: "idle", total: 0, completed: 0, errors: 0 };
  return {
    id: row.id, status: row.status, total: Number(row.total_count || 0), completed: Number(row.completed_count || 0),
    errors: Number(row.error_count || 0), createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

interface OutlookImportItem {
  email: string;
  openaiPassword: string;
  mailboxPassword: string;
  clientId: string;
  mailboxRefreshToken: string;
  accessToken: string;
  raw: string;
}

function parseOutlookLines(input: unknown): OutlookImportItem[] {
  const rows = String(input || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!rows.length) throw new Error("请粘贴至少一行账号");
  const output: OutlookImportItem[] = [];
  const invalid: number[] = [];
  const seen = new Set<string>();
  rows.forEach((line, index) => {
    const parts = line.split("----").map((part) => part.trim());
    const email = normalizeEmail(parts[0]);
    if (!validEmail(email) || ![4, 6].includes(parts.length) || parts.slice(1).some((part) => !part)) { invalid.push(index + 1); return; }
    if (seen.has(email)) return;
    seen.add(email);
    const item = parts.length === 4
      ? { email, openaiPassword: "", mailboxPassword: parts[1], clientId: parts[2], mailboxRefreshToken: parts[3], accessToken: "" }
      : { email, openaiPassword: parts[1], mailboxPassword: parts[2], clientId: parts[3], mailboxRefreshToken: parts[4], accessToken: parts[5] };
    output.push({ ...item, raw: [email, item.mailboxPassword, item.clientId, item.mailboxRefreshToken].join("----") });
  });
  if (invalid.length) throw new Error(`第 ${invalid.slice(0, 20).join("、")} 行格式不正确，只支持 Outlook 4 段或 6 段格式`);
  return output.slice(0, 500);
}

function accountForEmail(email: string): { accountId: string; bindingId: string } | null {
  const row = db.prepare(`SELECT b.account_id, b.id binding_id FROM email_bindings b
    JOIN gpt_accounts a ON a.id=b.account_id WHERE b.email_hash=? AND b.is_current=1 AND a.deleted_at=''`).get(emailHash(email)) as any;
  return row ? { accountId: String(row.account_id), bindingId: String(row.binding_id) } : null;
}

function saveOutlookConnection(item: OutlookImportItem, groupId: unknown = ""): void {
  const owner = accountForEmail(item.email);
  if (!owner) throw new Error("Outlook 邮箱导入后没有当前绑定");
  const now = new Date().toISOString();
  const id = sha256(`outlook-manager:${owner.bindingId}`).slice(0, 32);
  const secret = encryptSecret(JSON.stringify({ password: item.mailboxPassword, clientId: item.clientId, refreshToken: item.mailboxRefreshToken }));
  db.prepare(`INSERT INTO mailbox_connections(id,binding_id,provider,external_account_id,external_group_id,secret_ref,status,last_checked_at,
      metadata_json,created_at,updated_at,manager_email_enc,credentials_enc)
    VALUES(?,?,'outlook-manager',?,?,?,'active','',?, ?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET external_account_id=excluded.external_account_id,external_group_id=excluded.external_group_id,
      status='active',metadata_json=excluded.metadata_json,manager_email_enc=excluded.manager_email_enc,
      credentials_enc=excluded.credentials_enc,updated_at=excluded.updated_at`).run(
    id, owner.bindingId, emailHash(item.email), String(groupId || ""), `v2:${owner.bindingId}:mailbox`,
    JSON.stringify({ mailSource: "outlook-manager", importedBy: "v2" }), now, now, encryptSecret(item.email), secret,
  );
}

export async function importOutlook(input: unknown): Promise<Record<string, unknown>> {
  const parsed = parseOutlookLines(input);
  const managerResult = await outlookManagerFetch("/api/accounts", { method: "POST", csrf: true, body: {
    account_string: parsed.map((item) => item.raw).join("\n"), account_format: "client_id_refresh_token", provider: "outlook",
    forward_enabled: false, remark: "Cloud Opus V2 Imported", status: "active", tag_ids: [],
  } });
  let imported = 0;
  let created = 0;
  let errors = 0;
  for (let index = 0; index < parsed.length; index += 200) {
    const chunk = parsed.slice(index, index + 200);
    const result = importAccounts(chunk.map((item) => ({
      email: item.email, accessToken: item.accessToken, openaiPassword: item.openaiPassword, plan: "free", note: "",
    })));
    imported += result.imported;
    created += result.created;
    errors += result.errors.length;
  }
  for (const item of parsed) if (accountForEmail(item.email)) saveOutlookConnection(item, managerResult?.group_id || "");
  return { ok: true, added: created, updated: imported - created, skipped: parsed.length - imported, errors, managerAdded: Number(managerResult?.added_count || 0), managerSkipped: Number(managerResult?.skipped_count || 0) };
}

function transferEmails(input: unknown): string[] {
  const text = String(input || "");
  const json = findJson(text);
  const candidates = [normalizeEmail(json?.user?.email || ""), ...(text.match(/[^\s<>|,;]+@[^\s<>|,;]+\.[^\s<>|,;]+/gi) || []).map(normalizeEmail)];
  return [...new Set(candidates.filter(validEmail))].slice(0, 500);
}

export async function previewOutlookTransfer(input: unknown): Promise<Record<string, unknown>> {
  const emails = transferEmails(input);
  if (!emails.length) throw new Error("请粘贴至少一个邮箱");
  const manager = new Map((await listOutlookManagerAccounts()).map((item) => [normalizeEmail(item.email), item]));
  const results = emails.map((email) => {
    const listed = manager.get(email);
    const local = accountForEmail(email);
    return { email, exists: Boolean(listed), transferable: Boolean(listed), alreadyInViewer: Boolean(local), status: !listed ? "missing" : local ? "existing" : "ready", reason: !listed ? "Outlook 管理库未找到" : local ? "V2 已有账号" : "可转移" };
  });
  return { ok: true, total: results.length, transferable: results.filter((item) => item.transferable).length, results };
}

export async function applyOutlookTransfer(input: unknown): Promise<Record<string, unknown>> {
  const emails = transferEmails(input);
  if (!emails.length) throw new Error("请粘贴至少一个邮箱");
  const manager = new Map((await listOutlookManagerAccounts()).map((item) => [normalizeEmail(item.email), item]));
  let added = 0;
  let updated = 0;
  const failed: Array<Record<string, unknown>> = [];
  for (const email of emails) {
    const listed = manager.get(email);
    if (!listed) { failed.push({ email, error: "Outlook 管理库未找到" }); continue; }
    try {
      const detailPayload = await outlookManagerFetch(`/api/accounts/${listed.id}`);
      const detail = detailPayload?.account || detailPayload;
      const result = importAccounts([{ email, plan: "free" }]);
      added += result.created;
      updated += result.imported - result.created;
      saveOutlookConnection({
        email, openaiPassword: "", accessToken: "", mailboxPassword: String(detail.password || ""),
        clientId: String(detail.client_id || ""), mailboxRefreshToken: String(detail.refresh_token || ""), raw: "",
      }, detail.group_id || listed.group_id || "");
    } catch (error) {
      failed.push({ email, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: true, added, updated, failed: failed.length, failedItems: failed };
}

export function importSession(input: unknown): Record<string, unknown> {
  const text = String(input || "");
  const session = findJson(text);
  if (!session) throw new Error("会话 JSON 无法解析，请完整复制后重试");
  const credential: ParsedCredential = { line: 1, email: "", accessToken: "", refreshToken: "", idToken: "", sessionToken: "", openaiPassword: "", error: "" };
  collectCredentialObject(session, credential);
  credential.email ||= normalizeEmail(session.user?.email || "");
  if (!validEmail(credential.email)) throw new Error("会话 JSON 中没有有效的账号邮箱");
  if (!credential.accessToken && !credential.sessionToken) throw new Error("会话 JSON 中没有可识别的 Token");
  const result = importAccounts([credential]);
  return { ok: result.errors.length === 0, added: result.created, updated: result.imported - result.created, skipped: result.imported ? 0 : 1, errors: result.errors };
}

export function runUsageAudit(): Record<string, unknown> {
  const now = new Date().toISOString();
  const candidates = db.prepare(`SELECT a.id,
      (SELECT MAX(m.received_at) FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id
        WHERE oc.account_id=a.id AND m.category='billing') billing_at,
      (SELECT MAX(m.received_at) FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id
        WHERE oc.account_id=a.id AND m.category IN ('security','rebind')) activity_at
    FROM gpt_accounts a WHERE a.deleted_at='' AND a.lifecycle_status='active' AND a.sold=0`).all() as any[];
  let suspected = 0;
  db.transaction(() => {
    for (const row of candidates) {
      const billingAt = Date.parse(String(row.billing_at || ""));
      const activityAt = Date.parse(String(row.activity_at || ""));
      const unused = Number.isFinite(billingAt) && (!Number.isFinite(activityAt) || activityAt <= billingAt);
      db.prepare("UPDATE gpt_accounts SET suspected_unused=?, updated_at=? WHERE id=? AND mark_color!='purple'").run(unused ? 1 : 0, now, row.id);
      if (unused) suspected += 1;
    }
    db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('usage_audit_last_result',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(JSON.stringify({ checked: candidates.length, suspected }), now);
  })();
  return { ok: true, checked: candidates.length, suspectedUnused: suspected, finishedAt: now };
}

interface ShareFilters { sold: string; channel: string; plusOnly: boolean }

function shareFilters(input: any): ShareFilters {
  return {
    sold: ["all", "sold", "unsold"].includes(String(input?.sold || "all")) ? String(input?.sold || "all") : "all",
    channel: String(input?.channel || "").slice(0, 80), plusOnly: Boolean(input?.plusOnly),
  };
}

function publicShare(row: any): Record<string, unknown> {
  const token = decryptSecret(String(row.token_enc || ""));
  const active = !row.revoked_at && Date.parse(String(row.expires_at || "")) > Date.now() && Number(row.views) < Number(row.max_views);
  return {
    id: row.id, label: row.label, createdAt: row.created_at, expiresAt: row.expires_at,
    maxViews: Number(row.max_views), views: Number(row.views), remainingViews: Math.max(0, Number(row.max_views) - Number(row.views)),
    revoked: Boolean(row.revoked_at), active, filters: JSON.parse(String(row.filters_json || "{}")),
    url: `${config.publicOrigin}/adminshare#t=${encodeURIComponent(token)}`,
  };
}

export function listShareLinks(): Record<string, unknown> {
  return { results: (db.prepare("SELECT * FROM share_links ORDER BY created_at DESC").all() as any[]).map(publicShare) };
}

export function createShareLink(input: any): Record<string, unknown> {
  const ttlHours = Math.max(1, Math.min(168, Number(input?.ttlHours || 24)));
  const maxViews = Math.max(1, Math.min(50, Number(input?.maxViews || 5)));
  const token = crypto.randomBytes(24).toString("base64url");
  const id = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + ttlHours * 60 * 60 * 1_000).toISOString();
  db.prepare(`INSERT INTO share_links(id,token_hash,token_enc,label,expires_at,max_views,filters_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, digestToken(token), encryptSecret(token), String(input?.label || "").slice(0, 80), expires, maxViews, JSON.stringify(shareFilters(input)), now.toISOString(), now.toISOString());
  return { ok: true, link: publicShare(db.prepare("SELECT * FROM share_links WHERE id=?").get(id)) };
}

export function revokeShareLink(id: string): boolean {
  return db.prepare("UPDATE share_links SET revoked_at=?,updated_at=? WHERE id=? AND revoked_at=''").run(new Date().toISOString(), new Date().toISOString(), id).changes > 0;
}

function maskEmail(email: string): string {
  const [local, domain] = normalizeEmail(email).split("@");
  if (!local || !domain) return "***";
  if (local.length < 3) return `${local[0] || "*"}*@${domain}`;
  const count = Math.min(4, local.length - 2);
  const start = Math.floor((local.length - count) / 2);
  return `${local.slice(0, start)}${"*".repeat(count)}${local.slice(start + count)}@${domain}`;
}

export function readShareSnapshot(token: string, visitor: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT * FROM share_links WHERE token_hash=?").get(digestToken(token)) as any;
  if (!row || row.revoked_at || Date.parse(String(row.expires_at || "")) <= Date.now() || Number(row.views) >= Number(row.max_views)) return null;
  const now = new Date().toISOString();
  const visitorHash = sha256(`${visitor}:${token}`);
  const dedupe = db.prepare("SELECT expires_at FROM share_view_dedup WHERE link_id=? AND visitor_hash=?").get(row.id, visitorHash) as any;
  const counted = !dedupe || Date.parse(String(dedupe.expires_at || "")) <= Date.now();
  db.transaction(() => {
    if (counted) {
      db.prepare("UPDATE share_links SET views=views+1,last_view_at=?,updated_at=? WHERE id=?").run(now, now, row.id);
      db.prepare(`INSERT INTO share_view_dedup(link_id,visitor_hash,expires_at) VALUES(?,?,?)
        ON CONFLICT(link_id,visitor_hash) DO UPDATE SET expires_at=excluded.expires_at`).run(row.id, visitorHash, new Date(Date.now() + 10 * 60_000).toISOString());
    } else db.prepare("UPDATE share_links SET last_view_at=?,updated_at=? WHERE id=?").run(now, now, row.id);
  })();
  const filters = shareFilters(JSON.parse(String(row.filters_json || "{}")));
  const rows = db.prepare(`SELECT a.plan,a.billing_channel,a.deactivation_locked,a.mark_color,b.email_enc,b.provider
    FROM gpt_accounts a JOIN email_bindings b ON b.account_id=a.id AND b.is_current=1
    WHERE a.deleted_at='' AND a.lifecycle_status!='retired'
      AND (?='all' OR (?='sold' AND a.sold=1) OR (?='unsold' AND a.sold=0))
      AND (?='' OR a.billing_channel=?) AND (?=0 OR a.plan='plus')
    ORDER BY a.arrived_at DESC,a.id DESC`).all(filters.sold, filters.sold, filters.sold, filters.channel, filters.channel, filters.plusOnly ? 1 : 0) as any[];
  const current = db.prepare("SELECT * FROM share_links WHERE id=?").get(row.id) as any;
  return {
    ok: true, label: row.label || "账号概览", generatedAt: now, expiresAt: row.expires_at,
    maxViews: Number(row.max_views), remainingViews: Math.max(0, Number(row.max_views) - Number(current.views)), count: rows.length,
    results: rows.map((item) => ({
      emailMasked: maskEmail(decryptSecret(String(item.email_enc || ""))), hasPlus: String(item.plan) === "plus",
      hasDeactivation: Boolean(item.deactivation_locked), billingChannel: String(item.billing_channel || ""),
      mailboxType: String(item.provider || ""), markColor: String(item.mark_color || ""),
    })),
  };
}

export function changeCustomerPassword(grantId: string, password: unknown): void {
  const value = String(password || "");
  if (value.length < 6 || value.length > 256) throw new Error("新密码长度应为 6 到 256 个字符");
  const now = new Date().toISOString();
  const result = db.prepare(`UPDATE access_grants SET password_hash=?,password_plain_enc=?,updated_at=?
    WHERE id=? AND active=1 AND scope!='admin_only'`).run(hashPassword(value), encryptSecret(value), now, grantId);
  if (!result.changes) throw new Error("当前授权已失效");
}
