import crypto from "node:crypto";
import { db } from "./db.js";
import { emailHash, normalizeEmail, splitEmail } from "./association.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { applyBulkAction, getAccountDetail, importAccounts, revealCredentials } from "./repository.js";
import { normalizeHiddenTags } from "./business-evidence.js";
import { createPendingAssociationReview } from "./account-transitions.js";

export const SIGNUP_NOTE = "automyai OpenAI signup pool pending";
export const REBIND_NOTE = "automyai OpenAI email rebind target pending";
export const REGISTERED_NOTE = "automyai UC signup registered";
const COMPLETED_NOTE = "automyai OpenAI-X workflow completed";
const PENDING_CLAIM_LOOKBACK_MS = 5 * 60 * 1000;
const PENDING_CLAIM_LIMIT = 100;
const RELAY_SENDER_PATTERN = "(^|<|\\b)[a-z]+_at_tm[a-z0-9]*_openai_com_[a-z0-9]+_[a-z0-9]+@icloud\\.com(>|\\b|$)";
const DIRECT_SENDER_PATTERN = "(^|<|\\b)[^\\s<>@]+@(?:[a-z0-9-]+\\.)*openai\\.com(>|\\b|$)";

function bindingCompatibility(binding: any): Record<string, any> {
  try { return JSON.parse(String(binding?.source_json || "{}"))?.compatibility || {}; }
  catch { return {}; }
}

function compatibilityStatus(accountId: string, binding: any): string {
  const metadata = bindingCompatibility(binding);
  if (typeof metadata.internalStatusMessage === "string") return metadata.internalStatusMessage;
  const preference = db.prepare("SELECT status_message FROM account_preferences WHERE account_id=?").get(accountId) as any;
  return String(preference?.status_message || "");
}

function mailboxPattern(address: string): string {
  return `(^|<|\\b)${address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(>|\\b|$)`;
}

function senderPattern(address: string): string {
  const relay = address.toLowerCase().match(/^[a-z]+_at_tm[a-z0-9]*_openai_com_([a-z0-9]+)_[a-z0-9]+@icloud\.com$/);
  return relay ? `(^|<|\\b)[a-z]+_at_tm[a-z0-9]*_openai_com_${relay[1]}_[a-z0-9]+@icloud\\.com(>|\\b|$)` : mailboxPattern(address);
}

function isOpenAiSenderAddress(address: string): boolean {
  const normalized = normalizeEmail(address);
  const { domain } = splitEmail(normalized);
  if (domain === "openai.com" || domain.endsWith(".openai.com")) return true;
  return /^[a-z]+_at_tm[a-z0-9]*_openai_com_[a-z0-9]+_[a-z0-9]+@icloud\.com$/.test(normalized);
}

function compatibilitySenderPattern(sourceEmail: string, provider: string): string {
  // V1 sometimes supplies the OpenAI relay sender in sourceEmail, but newer
  // imports supply the customer's base iCloud mailbox there. A customer
  // mailbox is recipient identity, never a safe sender restriction.
  if (sourceEmail && isOpenAiSenderAddress(sourceEmail)) return senderPattern(sourceEmail);
  return provider === "domain" ? DIRECT_SENDER_PATTERN : RELAY_SENDER_PATTERN;
}

function normalizePatterns(input: unknown): string[] {
  const patterns = (Array.isArray(input) ? input : String(input || "").split(/\r?\n/)).map(String).map((value) => value.trim()).filter(Boolean);
  if (patterns.length > 30 || patterns.some((pattern) => pattern.length > 500)) throw Object.assign(new Error("邮件匹配规则超出限制"), { statusCode: 400 });
  try { patterns.forEach((pattern) => new RegExp(pattern, "i")); }
  catch { throw Object.assign(new Error("邮件匹配规则无效"), { statusCode: 400 }); }
  return patterns;
}

function saveCompatibilityMetadata(accountId: string, body: Record<string, any>) {
  const binding = db.prepare("SELECT * FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId) as any;
  if (!binding) throw new Error("账号没有当前邮箱绑定");
  const previous = bindingCompatibility(binding);
  const sourceEmail = body.sourceEmail == null ? String(previous.sourceEmail || "") : String(body.sourceEmail || "").trim().slice(0, 320);
  const rawToEmail = body.toEmail == null ? String(previous.toEmail || "") : String(body.toEmail || "").trim().slice(0, 320);
  const toEmail = rawToEmail && normalizeEmail(rawToEmail) !== normalizeEmail(sourceEmail) ? validEmail(rawToEmail) : body.email;
  if (sourceEmail) validEmail(sourceEmail);
  const internalStatusMessage = String(body.internalStatusMessage ?? body.statusMessage ?? previous.internalStatusMessage ?? "").trim().slice(0, 500);
  let source: Record<string, any> = {};
  try { source = JSON.parse(String(binding.source_json || "{}")); } catch {}
  source.compatibility = { sourceEmail, toEmail, internalStatusMessage };
  const now = new Date().toISOString();
  db.prepare("UPDATE email_bindings SET source_json=?,updated_at=? WHERE id=?").run(JSON.stringify(source), now, binding.id);
  const previousRules = db.prepare("SELECT * FROM mail_routing_rules WHERE binding_id=? ORDER BY priority DESC,id").all(binding.id) as any[];
  if (previousRules.length && !["sourceEmail", "toEmail", "fromPatterns", "toPatterns"].some((key) => body[key] != null)) return;
  const fromPatterns = body.fromPatterns == null ? [...new Set(previousRules.map((rule) => String(rule.sender_pattern)).filter(Boolean))] : normalizePatterns(body.fromPatterns);
  const toPatterns = body.toPatterns == null ? [...new Set(previousRules.map((rule) => String(rule.recipient_pattern)).filter(Boolean))] : normalizePatterns(body.toPatterns);
  const senders = fromPatterns.length ? fromPatterns : [compatibilitySenderPattern(sourceEmail, binding.provider)];
  const recipients = toPatterns.length ? toPatterns : [mailboxPattern(toEmail)];
  db.prepare("DELETE FROM mail_routing_rules WHERE binding_id=?").run(binding.id);
  const insert = db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,sender_pattern,recipient_pattern,valid_from,valid_to,source,priority,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'v2-compatibility',?,?,?)`);
  // V1 evaluates sender and recipient rule sets independently; retain their cross-product.
  for (const [fromIndex, from] of senders.entries()) for (const [toIndex, to] of recipients.entries()) {
    insert.run(`compat:${binding.id}:${fromIndex}:${toIndex}`, binding.id, from, to, binding.valid_from, binding.valid_to,
      100 - fromIndex - toIndex, now, now);
  }
}

function validEmail(input: unknown): string {
  const email = normalizeEmail(input);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error("邮箱格式无效"), { statusCode: 400 });
  return email;
}

function pendingRecipientMatches(pendingEmail: string, recipient: string): boolean {
  const pending = splitEmail(normalizeEmail(pendingEmail));
  const delivered = splitEmail(normalizeEmail(recipient));
  if (!pending.localPart || !pending.domain || !delivered.localPart || pending.domain !== delivered.domain) return false;
  if (pending.localPart === delivered.localPart) return true;
  if (pending.domain !== "icloud.com" && !pending.domain.endsWith(".icloud.com")) return false;
  const pendingPlus = pending.localPart.includes("+");
  const deliveredPlus = delivered.localPart.includes("+");
  if (pendingPlus === deliveredPlus) return false;
  const pendingBase = pendingPlus ? pending.localPart.split("+", 1)[0] : pending.localPart;
  const deliveredBase = deliveredPlus ? delivered.localPart.split("+", 1)[0] : delivered.localPart;
  return pendingBase === deliveredBase;
}

/**
 * Mail can be indexed just before the temporary mailbox import finishes.
 * Backfill only a small, recent security-mail window so that late pending
 * creation does not lose the OTP claim or trigger a table-wide scan.
 */
function backfillPendingMailboxClaims(pendingId: string, pendingEmail: string, createdAt: string): number {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return 0;
  const from = new Date(createdMs - PENDING_CLAIM_LOOKBACK_MS).toISOString();
  const rows = db.prepare(`SELECT id,recipient_enc FROM mail_messages
    WHERE provider='shared-mail-api' AND received_at>=? AND received_at<=?
      AND (is_security=1 OR category IN ('security','verification'))
    ORDER BY received_at DESC,id DESC LIMIT ?`).all(from, createdAt, PENDING_CLAIM_LIMIT) as any[];
  const insert = db.prepare(`INSERT OR IGNORE INTO pending_mail_claims(pending_id,message_id,created_at)
    VALUES(?,?,?)`);
  const now = new Date().toISOString();
  let claims = 0;
  for (const row of rows) {
    let recipient = "";
    try { recipient = decryptSecret(String(row.recipient_enc || "")); } catch { continue; }
    if (pendingRecipientMatches(pendingEmail, recipient)) claims += insert.run(pendingId, row.id, now).changes;
  }
  return claims;
}

export function pendingMailboxes(kind = ""): any[] {
  return (db.prepare("SELECT * FROM pending_mailboxes WHERE (?='' OR kind=?) ORDER BY created_at DESC,id").all(kind, kind) as any[]).map((row) => ({
    id: row.id, email: decryptSecret(row.email_enc), kind: row.kind, temporary: true,
    createdAt: row.created_at, updatedAt: row.updated_at, note: row.kind === "rebind" ? REBIND_NOTE : SIGNUP_NOTE,
    rebindTargetPending: row.kind === "rebind", lifecycleStatus: "active", sold: false, autoFlag: true,
    openaiOAuth: { hasAccessToken: false, hasRefreshToken: false, hasIdToken: false, hasSessionToken: false },
  }));
}

/**
 * Resolve an iCloud plus alias or its base recipient to one temporary mailbox.
 * iCloud forwarding can collapse ``local+suffix@icloud.com`` to
 * ``local@icloud.com`` in the delivered headers. Keep the lookup bounded to
 * the pending task pool and leave the stored address unchanged.
 */
export function pendingMailboxForEmail(emailInput: unknown): any | null {
  const wanted = normalizeEmail(emailInput);
  if (!wanted) return null;
  const exact = pendingMailboxes().find((item) => normalizeEmail(item.email) === wanted);
  if (exact) return exact;
  const parts = splitEmail(wanted);
  if (!parts.localPart || !parts.domain
    || !(parts.domain === "icloud.com" || parts.domain.endsWith(".icloud.com"))) return null;
  return pendingMailboxes().find((item) => pendingRecipientMatches(item.email, wanted)) || null;
}

export function resolveCompatibilityAccount(id: string): string {
  const own = db.prepare("SELECT id FROM gpt_accounts WHERE id=? AND deleted_at=''").get(id) as any;
  if (own) return String(own.id);
  const binding = db.prepare(`SELECT b.account_id FROM email_bindings b JOIN gpt_accounts a ON a.id=b.account_id
    WHERE b.legacy_mapping_id=? AND a.deleted_at='' ORDER BY b.is_current DESC LIMIT 1`).get(id) as any;
  if (!binding) throw Object.assign(new Error("账号不存在"), { statusCode: 404 });
  return String(binding.account_id);
}

export function accountForEmail(emailInput: unknown): string {
  const rows = db.prepare(`SELECT DISTINCT b.account_id FROM email_bindings b JOIN gpt_accounts a ON a.id=b.account_id
    WHERE b.email_hash=? AND b.is_current=1 AND a.deleted_at='' AND a.retired_at=''`).all(emailHash(validEmail(emailInput))) as any[];
  if (rows.length !== 1) throw Object.assign(new Error(rows.length ? "邮箱归属待核对" : "账号不存在"), { statusCode: rows.length ? 409 : 404 });
  return String(rows[0].account_id);
}

export function compatibilityMapping(accountId: string): Record<string, any> {
  const account = getAccountDetail(accountId);
  if (!account) throw Object.assign(new Error("账号不存在"), { statusCode: 404 });
  const row = db.prepare("SELECT * FROM gpt_accounts WHERE id=?").get(accountId) as any;
  const bindings = db.prepare("SELECT * FROM email_bindings WHERE account_id=? ORDER BY is_current DESC,valid_from DESC,created_at DESC").all(accountId) as any[];
  const current = bindings[0];
  const metadata = bindingCompatibility(current);
  const connection = current ? db.prepare("SELECT * FROM mailbox_connections WHERE binding_id=? ORDER BY updated_at DESC LIMIT 1").get(current.id) as any : null;
  const evidence = db.prepare("SELECT * FROM account_business_evidence WHERE account_id=?").get(accountId) as any;
  const credentials = revealCredentials(accountId);
  const relation = db.prepare("SELECT from_account_id FROM account_relations WHERE to_account_id=? AND relation_type='mailbox_recycle' LIMIT 1").get(accountId) as any;
  const grant = current ? db.prepare("SELECT visible_to FROM access_grants WHERE binding_id=? AND scope!='admin_only' ORDER BY updated_at DESC LIMIT 1").get(current.id) as any : null;
  let address = "";
  try { address = String(JSON.parse(decryptSecret(String(connection?.credentials_enc || "")))?.address || ""); } catch {}
  return {
    id: accountId, email: account.primaryEmail, label: "Mailbox", note: row.note || "",
    sold: account.sold, autoFlag: account.isAuto, lifecycleStatus: account.lifecycleStatus,
    hasDeactivation: account.deactivationLocked, deactivationLocked: account.deactivationLocked, deactivatedAt: account.deactivatedAt,
    hasPlus: account.plan === "plus", manualPlus: row.plan_source === "manual" && account.plan === "plus",
    billingChannel: account.billingChannel, billingChannelOverride: account.billingChannelOverride,
    hidePromotion: account.hidePromotion, domainMailbox: account.domainMailbox,
    mailboxType: connection?.provider || account.provider, outlookManagerEmail: decryptSecret(String(connection?.manager_email_enc || "")),
    address, externalProvider: connection?.provider || "", sourceEmail: String(metadata.sourceEmail || ""),
    toEmail: String(metadata.toEmail || account.primaryEmail),
    rebindPreviousId: bindings.length > 1 ? String(bindings[1].legacy_mapping_id || bindings[1].id) : "",
    rebindPreviousEmail: bindings.length > 1 ? decryptSecret(bindings[1].email_enc) : "", rebindNextId: "", rebindNextEmail: "",
    rebindChangedAt: bindings.length > 1 ? String(current.valid_from || "") : "",
    registrationCreatedAt: row.arrived_at || "", createdAt: row.created_at || "", updatedAt: row.updated_at || "",
    internalStatusMessage: compatibilityStatus(accountId, current) || row.quarantine_reason || "", statusMessage: "",
    receiveDisabled: Boolean(grant?.visible_to), receiveDisabledAt: String(grant?.visible_to || ""),
    markColor: account.markColor, groupBoundary: account.groupBoundary, suspectedUnused: account.suspectedUnused,
    hasAccessToken: Boolean(credentials?.accessToken), hasRefreshToken: Boolean(credentials?.refreshToken),
    openaiOAuth: { hasAccessToken: Boolean(credentials?.accessToken), hasRefreshToken: Boolean(credentials?.refreshToken),
      hasIdToken: Boolean(credentials?.idToken), hasSessionToken: Boolean(credentials?.sessionToken) },
    hasOpenaiPassword: Boolean(credentials?.openaiPassword), hiddenTags: normalizeHiddenTags(JSON.parse(evidence?.hidden_tags_json || "[]")),
    recycled: Boolean(relation), recycledFromId: String(relation?.from_account_id || ""), recycleGeneration: Number(evidence?.recycle_generation || 0),
    mailVerifiedNoPlus: Boolean(evidence?.mail_verified_no_plus), tokenPlan: account.plan, isFreeAccount: account.plan === "free",
    promoEligible: account.promoEligible, promoCampaign: account.promoCampaign, promoCheckedAt: account.trialCheckedAt,
  };
}

function minimalAccount(accountId: string) {
  const item = compatibilityMapping(accountId);
  const fields = ["id", "email", "label", "sold", "autoFlag", "manualPlus", "hasPlus", "billingChannel",
    "billingChannelOverride", "mailboxType", "createdAt", "registrationCreatedAt", "updatedAt", "openaiOAuth", "hasOpenaiPassword"];
  return Object.fromEntries(fields.map((key) => [key, item[key]]));
}

export function normalizeCompatibilityInput(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("账号数据无效"), { statusCode: 400 });
  const body = value as Record<string, any>;
  const result: Record<string, any> = { ...body, email: validEmail(body.email || body.login) };
  for (const [camel, snake] of [["accessToken", "access_token"], ["refreshToken", "refresh_token"], ["idToken", "id_token"], ["sessionToken", "session_token"], ["openaiPassword", "openai_password"]] as const) {
    if (!(camel in result) && snake in body) result[camel] = body[snake];
  }
  return result;
}

export function upsertCompatibilityAccount(input: unknown): Record<string, any> {
  const body = normalizeCompatibilityInput(input);
  const pendingKind = body.note === REBIND_NOTE ? "rebind" : body.note === SIGNUP_NOTE ? "signup" : "";
  if (pendingKind && !["accessToken", "refreshToken", "idToken", "sessionToken"].some((key) => body[key])) {
    const hash = emailHash(body.email);
    const existing = db.prepare("SELECT id FROM pending_mailboxes WHERE email_hash=?").get(hash) as any;
    const now = new Date().toISOString();
    const id = existing?.id || `pending:${crypto.createHash("sha256").update(body.email).digest("hex").slice(0, 24)}`;
    db.transaction(() => {
      db.prepare(`INSERT INTO pending_mailboxes(id,email_hash,email_enc,kind,created_at,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(email_hash) DO UPDATE SET kind=excluded.kind,updated_at=excluded.updated_at`)
        .run(id, hash, encryptSecret(body.email), pendingKind, now, now);
      if (!existing) backfillPendingMailboxClaims(id, body.email, now);
    }).immediate();
    return { ok: true, created: !existing, temporary: true, id, item: pendingMailboxes().find((item) => item.id === id) };
  }
  return db.transaction(() => {
    const pending = db.prepare("SELECT * FROM pending_mailboxes WHERE email_hash=?").get(emailHash(body.email)) as any;
    const result = importAccounts([body as any]);
    if (result.errors.length) throw Object.assign(new Error(result.errors[0].error), { statusCode: 409 });
    const accountId = accountForEmail(body.email);
    saveCompatibilityMetadata(accountId, body);
    if (pending) {
      const binding = db.prepare("SELECT * FROM email_bindings WHERE account_id=? AND is_current=1 AND email_hash=?")
        .get(accountId, emailHash(body.email)) as any;
      const messages = db.prepare(`SELECT m.id,m.received_at FROM pending_mail_claims pc JOIN mail_messages m ON m.id=pc.message_id
        WHERE pc.pending_id=? AND julianday(m.received_at)>=julianday(?)
        AND NOT EXISTS(SELECT 1 FROM mail_ownership_claims c WHERE c.message_id=m.id AND c.account_id<>?)`)
        .all(pending.id, pending.created_at, accountId) as any[];
      for (const mail of messages) {
        if (binding.valid_to && Date.parse(mail.received_at) >= Date.parse(binding.valid_to)) continue;
        db.prepare(`INSERT OR IGNORE INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,visible_to_customer,created_at)
          VALUES(?,?,?,'exact','confirmed pending mailbox import',?,?)`)
          .run(mail.id, accountId, binding.id, Number(Date.parse(mail.received_at) >= Date.parse(binding.valid_from)), new Date().toISOString());
      }
      const unresolved = db.prepare(`SELECT pc.message_id FROM pending_mail_claims pc WHERE pc.pending_id=?
        AND NOT EXISTS(SELECT 1 FROM mail_ownership_claims c WHERE c.message_id=pc.message_id AND c.account_id=?)`)
        .all(pending.id, accountId) as any[];
      if (unresolved.length) createPendingAssociationReview(accountId, body.email, "临时邮箱邮件归属或时间待核对", {
        source: "pending-mailbox-import", messageIds: unresolved.map((row) => String(row.message_id)),
      });
      db.prepare("DELETE FROM pending_mailboxes WHERE id=?").run(pending.id);
    }
    return { ok: true, created: result.created > 0, passwordGenerated: false, item: minimalAccount(accountId) };
  }).immediate();
}

export function cleanupCompatibilityAccount(input: unknown) {
  const body = normalizeCompatibilityInput(input);
  const kind = body.kind === "rebind" ? "rebind" : "signup";
  return db.transaction(() => {
    const pendingRemoved = db.prepare("DELETE FROM pending_mailboxes WHERE email_hash=? AND kind=?").run(emailHash(body.email), kind).changes > 0;
    const matches = db.prepare(`SELECT a.* FROM gpt_accounts a JOIN email_bindings b ON b.account_id=a.id
      WHERE b.email_hash=? AND b.is_current=1 AND a.deleted_at='' AND a.sold=0`).all(emailHash(body.email)) as any[];
    let removedCount = 0, completedRemoved = 0;
    for (const row of matches) {
      const credentials = revealCredentials(row.id);
      if (["accessToken", "refreshToken", "idToken", "sessionToken"].some((key) => credentials?.[key])) continue;
      const expectedNote = kind === "rebind" ? REBIND_NOTE : SIGNUP_NOTE;
      const binding = db.prepare("SELECT source_json FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(row.id) as any;
      const note = String(row.note || "").trim();
      const staleCompleted = kind === "signup" && /already_registered|user_already_exists|邮箱已注册/i.test(String(body.reason || ""))
        && note === COMPLETED_NOTE && /already_registered|user_already_exists|邮箱已注册/i.test(compatibilityStatus(row.id, binding));
      if (note !== expectedNote && !staleCompleted) continue;
      applyBulkAction([row.id], "delete", true);
      removedCount += 1;
      if (staleCompleted) completedRemoved += 1;
    }
    return { ok: true, email: body.email, kind, pendingRemoved, mappingRemoved: removedCount > 0, completedRemoved, removedCount };
  }).immediate();
}

export function saveCompatibilityProbe(input: Record<string, any>) {
  const accountId = accountForEmail(input.email || input.login);
  const tag = normalizeHiddenTags([input])[0];
  if (!tag) throw Object.assign(new Error("IP 地区或账单国家/货币无效"), { statusCode: 400 });
  db.transaction(() => {
    const previous = db.prepare("SELECT hidden_tags_json FROM account_business_evidence WHERE account_id=?").get(accountId) as any;
    const tags = normalizeHiddenTags(JSON.parse(previous?.hidden_tags_json || "[]"));
    db.prepare(`INSERT INTO account_business_evidence(account_id,hidden_tags_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET hidden_tags_json=excluded.hidden_tags_json,updated_at=excluded.updated_at`)
      .run(accountId, JSON.stringify([...tags.filter((item) => item.key !== tag.key), tag].slice(-64)), new Date().toISOString());
  }).immediate();
  return { ok: true, updated: true };
}
