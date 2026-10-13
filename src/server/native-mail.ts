import { emailHash, normalizeEmail } from "./association.js";
import { db } from "./db.js";
import { decryptSecret } from "./crypto.js";
import { MailReadError, type D1MailReader } from "./cf-mail.js";
import { isDeactivationSubject, isVerificationMail } from "./mail-classification.js";
import { fetchExternalMessage } from "./external-mailbox.js";
import { isStrictPlusEvidenceSubject } from "./plus-evidence.js";
import { fetchOutlookMessage, fetchSharedMessage, listOutlookManagerAccounts, listOutlookManagerMails, sharedMailReader, stripHtml } from "./upstream-mail.js";

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

export async function listAdminAccountMails(accountId: string, offsetInput: unknown, limitInput: unknown): Promise<Record<string, unknown>> {
  const offset = integer(offsetInput, 0, 0, 5_000);
  const limit = integer(limitInput, 10, 1, 30);
  const count = Number(((await db.prepare(`SELECT COUNT(DISTINCT m.id) count FROM mail_messages m
    JOIN mail_ownership_claims oc ON oc.message_id=m.id WHERE oc.account_id=?`).get(accountId)) as any)?.count || 0);
  const rows = (await db.prepare(`SELECT DISTINCT m.id, m.sender, m.subject, m.received_at, m.folder, m.category
    FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id
    WHERE oc.account_id=? ORDER BY datetime(m.received_at) DESC, m.id DESC LIMIT ? OFFSET ?`).all(accountId, limit, offset)) as any[];
  return {
    count,
    results: rows.map((row) => ({
      id: String(row.id), from: String(row.sender || ""), subject: String(row.subject || "(无主题)"),
      created_at: String(row.received_at || ""), folder: String(row.folder || "inbox"), category: String(row.category || "general"),
    })),
  };
}

async function outlookMailboxForProvider(provider: string): Promise<string> {
  const hash = provider.replace(/^outlook:/, "");
  const connection = (await db.prepare(`SELECT manager_email_enc FROM mailbox_connections
    WHERE provider='outlook-manager' AND external_account_id=? AND status='active' LIMIT 1`).get(hash)) as any;
  return connection?.manager_email_enc ? normalizeEmail(decryptSecret(connection.manager_email_enc)) : "";
}

export async function adminAccountMailDetail(accountId: string, messageId: string): Promise<Record<string, unknown> | null> {
  const row = (await db.prepare(`SELECT m.* FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id
    WHERE oc.account_id=? AND m.id=? LIMIT 1`).get(accountId, messageId)) as any;
  if (!row) return null;
  let text = "";
  let html = "";
  if (String(row.provider) === "shared-mail-api") {
    const detail = await fetchSharedMessage(String(row.provider_message_id), row.recipient_enc ? decryptSecret(row.recipient_enc) : "");
    if (!detail) throw new MailReadError("mail_upstream_missing", 404);
    text = detail.text;
    html = detail.html;
  } else if (String(row.provider).startsWith("outlook:")) {
    const mailbox = await outlookMailboxForProvider(String(row.provider));
    const detail = await fetchOutlookMessage(mailbox, String(row.provider_message_id), String(row.folder || "inbox"));
    if (!detail) throw new MailReadError("mail_upstream_missing", 404);
    text = detail.text;
    html = detail.html;
  } else if (String(row.provider).startsWith("external:")) {
    const detail = await fetchExternalMessage(accountId, messageId);
    if (!detail) throw new MailReadError("mail_upstream_missing", 404);
    text = detail.text;
    html = detail.html;
  } else {
    throw new MailReadError("mail_provider_unsupported");
  }
  return { ok: true, mail: { id: row.id, from: row.sender, subject: row.subject, created_at: row.received_at, folder: row.folder, text, html } };
}

export function extractVerificationCode(value: Record<string, unknown>): string {
  const content = `${String(value.subject || "")}\n${String(value.text || "")}\n${stripHtml(String(value.html || ""))}`;
  const patterns = [
    /(?:verification|login|temporary|one[- ]time|security|验证码|驗證碼|登录代码|登入代碼|認証コード|確認コード|検証コード|一時検証コード|一時的な認証コード|この一時検証コードを入力して続行)[^0-9]{0,120}([0-9]{6})(?![0-9])/i,
    /(^|[^0-9])([0-9]{6})(?![0-9])/,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return String(match[2] || match[1] || "");
  }
  return "";
}

function likelyVerificationMail(value: Record<string, unknown>): boolean {
  const subject = String(value.subject || "").replace(/\s+/g, " ").trim();
  const sender = String(value.from || "");
  return isVerificationMail(subject, sender)
    || /(?:openai|chatgpt).*(?:code|verify|verification|login|登录|登入|验证码|驗證碼|認証|検証)/i.test(subject)
    || /(?:temporary|one[- ]time|security|verification).*(?:code|login)/i.test(subject)
    || /(?:一時的な認証コード|一時検証コード|検証コード|認証コード)/.test(subject)
    || /(?:noreply|no-reply).*openai/i.test(sender);
}

const verificationResults = new Map<string, { expiresAt: number; result: Record<string, unknown> }>();
const verificationPending = new Map<string, Promise<Record<string, unknown>>>();

export interface VerificationCodeOptions { bindingId?: string; ignoreAccessWindow?: boolean }

type AccountMailDetailReader = typeof adminAccountMailDetail;

async function verificationCandidates(accountId: string, options: VerificationCodeOptions): Promise<{ binding: any; rows: any[] }> {
  const binding = options.bindingId
    ? (await db.prepare("SELECT * FROM email_bindings WHERE id=? AND account_id=?").get(options.bindingId, accountId)) as any
    : (await db.prepare("SELECT * FROM email_bindings WHERE account_id=? ORDER BY is_current DESC, valid_from DESC LIMIT 1").get(accountId)) as any;
  if (!binding) return { binding: null, rows: [] };
  const rows = (await db.prepare(`SELECT DISTINCT m.id,m.sender AS "from",m.subject,m.received_at AS created_at,m.folder,m.category,m.indexed_at
    FROM mail_messages m JOIN mail_ownership_claims c ON c.message_id=m.id
    WHERE c.account_id=? AND c.binding_id=? AND m.received_at<>''
      AND NOT EXISTS(SELECT 1 FROM mail_ownership_claims other WHERE other.message_id=m.id AND other.account_id<>?)
      AND (?=1 OR ((?='' OR m.received_at>=?) AND (?='' OR m.received_at<?)
        AND (?='' OR m.received_at<=?)))
    ORDER BY m.received_at DESC,m.id DESC LIMIT 20`).all(accountId, binding.id, accountId, Number(options.ignoreAccessWindow === true),
    binding.valid_from, binding.valid_from, binding.valid_to, binding.valid_to,
    binding.receive_disabled_at, binding.receive_disabled_at)) as any[];
  return { binding, rows };
}

async function readAccountVerificationCode(accountId: string, rows: any[], detailReader: AccountMailDetailReader): Promise<Record<string, unknown>> {
  for (const candidate of rows.filter(likelyVerificationMail).slice(0, 8)) {
    const detail = await detailReader(accountId, String(candidate.id));
    const mail = (detail as any)?.mail || candidate;
    const verificationCode = extractVerificationCode(mail);
    if (verificationCode) return { ok: true, item: { id: candidate.id, from: candidate.from, subject: candidate.subject,
      created_at: candidate.created_at, folder: candidate.folder, category: candidate.category, verificationCode } };
  }
  return { ok: true, item: null };
}

export async function accountVerificationCode(accountId: string, options: VerificationCodeOptions = {}, detailReader: AccountMailDetailReader = adminAccountMailDetail): Promise<Record<string, unknown>> {
  const { binding, rows } = (await verificationCandidates(accountId, options));
  const key = JSON.stringify([accountId, binding?.id || "", binding?.valid_from || "", binding?.valid_to || "",
    binding?.receive_disabled_at || "", options.ignoreAccessWindow === true, rows.map((row) => [row.id, row.indexed_at])]);
  const cached = verificationResults.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
  const pending = verificationPending.get(key);
  if (pending) return pending;
  const task = readAccountVerificationCode(accountId, rows, detailReader).then((result) => {
    for (const [entry, value] of verificationResults) if (value.expiresAt <= Date.now()) verificationResults.delete(entry);
    verificationResults.set(key, { expiresAt: Date.now() + 60_000, result });
    return result;
  }).finally(() => verificationPending.delete(key));
  verificationPending.set(key, task);
  return task;
}

export async function pendingMailboxVerificationCode(emailInput: unknown, reader: Pick<D1MailReader, "byId"> = sharedMailReader): Promise<Record<string, unknown>> {
  const email = normalizeEmail(emailInput);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new MailReadError("invalid_mailbox_email", 400);
  const pending = (await db.prepare("SELECT id,created_at FROM pending_mailboxes WHERE email_hash=?").get(emailHash(email))) as any;
  if (!pending) throw new MailReadError("pending_mailbox_not_found", 404);
  const rows = (await db.prepare(`SELECT m.* FROM mail_messages m JOIN pending_mail_claims c ON c.message_id=m.id
    WHERE c.pending_id=? AND datetime(m.received_at)>=datetime(?,'-5 minutes')
      AND (m.received_at>=? OR c.created_at>=?)
    ORDER BY m.received_at DESC,m.id DESC LIMIT 20`)
    .all(pending.id, pending.created_at, pending.created_at, pending.created_at)) as any[];
  const key = `pending:${pending.id}:${pending.created_at}:${rows[0]?.id || ""}:${rows[0]?.indexed_at || ""}`;
  const cached = verificationResults.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const inflight = verificationPending.get(key);
  if (inflight) return inflight;
  const task = (async () => {
    for (const candidate of rows.filter((row) => likelyVerificationMail({ subject: row.subject, from: row.sender })).slice(0, 8)) {
      if (candidate.provider !== "shared-mail-api") continue;
      const detail = await fetchSharedMessage(String(candidate.provider_message_id), email, reader);
      if (!detail) continue;
      const verificationCode = extractVerificationCode(detail as unknown as Record<string, unknown>);
      if (verificationCode) return { ok: true, item: { id: candidate.id, from: candidate.sender,
        subject: candidate.subject, created_at: candidate.received_at, folder: candidate.folder, verificationCode } };
    }
    return { ok: true, item: null };
  })().then((result) => {
    for (const [entry, value] of verificationResults) if (value.expiresAt <= Date.now()) verificationResults.delete(entry);
    verificationResults.set(key, { expiresAt: Date.now() + 60_000, result });
    return result;
  }).finally(() => verificationPending.delete(key));
  verificationPending.set(key, task);
  return task;
}

interface OutlookPoolCache {
  scannedAt: string;
  accounts: any[];
}

let outlookPoolCache: OutlookPoolCache | null = null;

function classifySubjects(subjects: string[]): Record<string, unknown> {
  const hasDeactivation = subjects.some(isDeactivationSubject);
  const hasPlus = subjects.some(isStrictPlusEvidenceSubject);
  const hasActivity = subjects.some((subject) => /new sign-in|login code|verification|welcome to (?:chatgpt|openai)|登录|验证码/i.test(subject));
  const opened = hasDeactivation || hasPlus || hasActivity;
  return {
    opened, hasDeactivation, hasPlus, hasActivity,
    bucket: hasPlus ? "plus" : hasDeactivation ? "free_deactivated" : opened ? "free_active" : "not_opened",
    status: hasPlus ? "Plus已开通" : hasDeactivation ? "Free已停用" : opened ? "Free已开通(未停用)" : "未开通GPT",
  };
}

async function refreshOutlookPool(): Promise<OutlookPoolCache> {
  const accounts = await listOutlookManagerAccounts();
  const results = new Array(accounts.length);
  let cursor = 0;
  async function scan(): Promise<void> {
    while (cursor < accounts.length) {
      const index = cursor++;
      const item = accounts[index];
      try {
        const payload = await listOutlookManagerMails(normalizeEmail(item?.email), 0, 40);
        const mails = Array.isArray(payload?.emails) ? payload.emails : [];
        results[index] = { ...item, ...classifySubjects(mails.map((mail: any) => String(mail?.subject || ""))), mailScanned: mails.length, error: "" };
      } catch (error) {
        results[index] = { ...item, opened: false, bucket: "error", status: "扫描失败", mailScanned: 0, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, accounts.length)) }, scan));
  outlookPoolCache = { scannedAt: new Date().toISOString(), accounts: results };
  return outlookPoolCache;
}

async function poolResponse(cache: OutlookPoolCache): Promise<Record<string, unknown>> {
  const viewerHashes = new Set(((await db.prepare("SELECT email_hash FROM email_bindings").all()) as any[]).map((row) => String(row.email_hash)));
  const results = cache.accounts.filter((item) => item?.opened && !viewerHashes.has(emailHash(normalizeEmail(item.email)))).map((item) => ({
    id: `outlook-${item.id || emailHash(normalizeEmail(item.email))}`,
    email: String(item.email || ""), groupId: item.group_id || null, groupName: String(item.group_name || ""),
    lastRefreshStatus: String(item.last_refresh_status || ""), accountStatus: String(item.status || ""),
    opened: true, hasDeactivation: Boolean(item.hasDeactivation), hasPlus: Boolean(item.hasPlus), hasActivity: Boolean(item.hasActivity),
    status: String(item.status || ""), bucket: String(item.bucket || ""), mailScanned: Number(item.mailScanned || 0), error: String(item.error || ""),
  })).sort((left, right) => Number(left.hasPlus) - Number(right.hasPlus) || Number(left.hasDeactivation) - Number(right.hasDeactivation) || left.email.localeCompare(right.email));
  const summary = Object.fromEntries([...new Set(cache.accounts.map((item) => String(item?.bucket || "unknown")))].map((bucket) => [bucket, cache.accounts.filter((item) => String(item?.bucket || "unknown") === bucket).length]));
  return {
    ok: true, scannedAt: cache.scannedAt, stale: Date.now() - Date.parse(cache.scannedAt) > 6 * 60 * 60 * 1000,
    refreshing: false, scannedAccounts: cache.accounts.length, scanErrors: Number(summary.error || 0), summary,
    total: results.length, freeActive: results.filter((item) => !item.hasDeactivation && !item.hasPlus).length,
    freeDeactivated: results.filter((item) => item.hasDeactivation && !item.hasPlus).length, plus: results.filter((item) => item.hasPlus).length, results,
  };
}

export async function outlookFreePool(force = false): Promise<Record<string, unknown>> {
  const cache = force || !outlookPoolCache ? await refreshOutlookPool() : outlookPoolCache;
  return { ...(await poolResponse(cache)), refreshed: force };
}

export async function outlookFreeMails(email: string, offsetInput: unknown, limitInput: unknown): Promise<Record<string, unknown>> {
  const normalized = normalizeEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error("邮箱无效");
  const offset = integer(offsetInput, 0, 0, 500);
  const limit = integer(limitInput, 20, 1, 50);
  const payload = await listOutlookManagerMails(normalized, offset, limit);
  const rows = Array.isArray(payload?.emails) ? payload.emails : [];
  return { ok: true, email: normalized, count: rows.length, results: rows.map((mail: any) => ({
    id: String(mail.id || ""), from: String(mail.from?.emailAddress?.address || mail.from?.address || mail.from || ""),
    to: String(mail.to?.[0]?.emailAddress?.address || mail.to || ""), subject: String(mail.subject || "(无主题)"),
    created_at: String(mail.date || ""), folder: String(mail.folder || "inbox"), preview: String(mail.body_preview || "").slice(0, 180),
    detailMethod: "graph", detailIdMode: String(mail.id_mode || ""),
  })) };
}

export async function outlookFreeMailDetail(email: string, id: string, folder: string): Promise<Record<string, unknown>> {
  const normalized = normalizeEmail(email);
  const detail = await fetchOutlookMessage(normalized, id, folder);
  if (!detail) throw new Error("邮件不存在或读取失败");
  return { ok: true, mail: {
    id, from: detail.from, to: detail.to, subject: detail.subject,
    created_at: detail.receivedAt, folder: detail.folder, text: detail.text, html: detail.html,
  } };
}
