import { emailHash, normalizeEmail } from "./association.js";
import { db } from "./db.js";
import { isStrictPlusEvidenceSubject } from "./plus-evidence.js";
import { fetchOutlookMessage, fetchSharedMessage, listOutlookManagerAccounts, listOutlookManagerMails } from "./upstream-mail.js";

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

export function listAdminAccountMails(accountId: string, offsetInput: unknown, limitInput: unknown): Record<string, unknown> {
  const offset = integer(offsetInput, 0, 0, 5_000);
  const limit = integer(limitInput, 10, 1, 30);
  const count = Number((db.prepare(`SELECT COUNT(DISTINCT m.id) count FROM mail_messages m
    JOIN mail_ownership_claims oc ON oc.message_id=m.id WHERE oc.account_id=?`).get(accountId) as any)?.count || 0);
  const rows = db.prepare(`SELECT DISTINCT m.id, m.sender, m.subject, m.received_at, m.folder, m.category
    FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id
    WHERE oc.account_id=? ORDER BY datetime(m.received_at) DESC, m.id DESC LIMIT ? OFFSET ?`).all(accountId, limit, offset) as any[];
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
  const accounts = await listOutlookManagerAccounts();
  return normalizeEmail(accounts.find((item) => emailHash(normalizeEmail(item?.email)) === hash)?.email || "");
}

export async function adminAccountMailDetail(accountId: string, messageId: string): Promise<Record<string, unknown> | null> {
  const row = db.prepare(`SELECT m.* FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id
    WHERE oc.account_id=? AND m.id=? LIMIT 1`).get(accountId, messageId) as any;
  if (!row) return null;
  let text = "";
  if (String(row.provider) === "shared-mail-api") {
    text = String((await fetchSharedMessage(String(row.provider_message_id)).catch(() => null))?.text || "");
  } else if (String(row.provider).startsWith("outlook:")) {
    const mailbox = await outlookMailboxForProvider(String(row.provider));
    text = String((await fetchOutlookMessage(mailbox, String(row.provider_message_id), String(row.folder || "inbox")).catch(() => null))?.text || "");
  }
  return { ok: true, mail: { id: row.id, from: row.sender, subject: row.subject, created_at: row.received_at, folder: row.folder, text } };
}

export function extractVerificationCode(value: Record<string, unknown>): string {
  const content = `${String(value.subject || "")}\n${String(value.text || "")}`;
  const patterns = [
    /(?:verification|login|temporary|one[- ]time|security|验证码|驗證碼|登录代码|登入代碼|認証コード|確認コード|検証コード|一時検証コード|一時的な認証コード)[^0-9]{0,120}([0-9]{6})(?![0-9])/i,
    /(^|[^0-9])([0-9]{6})(?![0-9])/,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return String(match[2] || match[1] || "");
  }
  return "";
}

function likelyVerificationMail(value: Record<string, unknown>): boolean {
  const subject = String(value.subject || "");
  const sender = String(value.from || "");
  return /(?:openai|chatgpt).*(?:code|verify|verification|login|登录|登入|验证码|驗證碼|認証|検証)/i.test(subject)
    || /(?:temporary|one[- ]time|security|verification).*(?:code|login)/i.test(subject)
    || /(?:noreply|no-reply).*openai/i.test(sender);
}

export async function accountVerificationCode(accountId: string): Promise<Record<string, unknown>> {
  const page = listAdminAccountMails(accountId, 0, 20) as any;
  for (const candidate of (page.results || []).filter(likelyVerificationMail).slice(0, 8)) {
    const detail = await adminAccountMailDetail(accountId, String(candidate.id));
    const mail = (detail as any)?.mail || candidate;
    const verificationCode = extractVerificationCode(mail);
    if (verificationCode) return { ok: true, item: { ...mail, verificationCode } };
  }
  return { ok: true, item: null };
}

interface OutlookPoolCache {
  scannedAt: string;
  accounts: any[];
}

let outlookPoolCache: OutlookPoolCache | null = null;

function classifySubjects(subjects: string[]): Record<string, unknown> {
  const hasDeactivation = subjects.some((subject) => /access deactivated|访问权限已停用|账号已停用|アクセスが無効/i.test(subject));
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

function poolResponse(cache: OutlookPoolCache): Record<string, unknown> {
  const viewerHashes = new Set((db.prepare("SELECT email_hash FROM email_bindings").all() as any[]).map((row) => String(row.email_hash)));
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
  return { ...poolResponse(cache), refreshed: force };
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
