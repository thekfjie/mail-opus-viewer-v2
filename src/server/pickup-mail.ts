import { emailHash, normalizeEmail } from "./association.js";
import { db } from "./db.js";
import { decryptSecret } from "./crypto.js";
import { MailReadError, type D1MailReader } from "./cf-mail.js";
import { isVerificationMail } from "./mail-classification.js";
import { extractVerificationCode } from "./native-mail.js";
import { fetchSharedMessage, sharedMailReader } from "./upstream-mail.js";

interface PickupOptions { sourceEmail: string; since: string; until?: string; allowBaseRecipient: boolean }
const LEGACY_PICKUP_WINDOW_MS = 60 * 60 * 1000;
const results = new Map<string, { expiresAt: number; result: Record<string, unknown> }>();
const pendingReads = new Map<string, Promise<Record<string, unknown>>>();

/** 并发注册任务占用同源邮箱时，不能把折叠后的收件人归给当前子邮箱。
 * 历史/已导入账号由可信调用方的活跃取件授权隔离，不能永久阻塞源邮箱复用。 */
function hasOtherPendingMailbox(email: string, sourceEmail: string): boolean {
  const base = sourceEmail.split("@")[0];
  const prefix = `${base}+`;
  return (db.prepare("SELECT email_enc FROM pending_mailboxes WHERE email_hash<>?").all(emailHash(email)) as any[])
    .some((row) => {
      const other = normalizeEmail(decryptSecret(row.email_enc));
      return other === sourceEmail || other.startsWith(prefix) && other.endsWith("@icloud.com");
    });
}

/** 公开取件只凭已发放的邮箱范围读本地索引，不创建或删除注册中的临时账号。 */
export async function pickupMailboxVerificationCode(
  emailInput: unknown, options: PickupOptions, reader: Pick<D1MailReader, "byId"> = sharedMailReader,
): Promise<Record<string, unknown>> {
  const email = normalizeEmail(emailInput);
  const match = /^([^+@\s]+)\+oai[^+@\s]+@icloud\.com$/.exec(email);
  const sourceEmail = normalizeEmail(options.sourceEmail);
  const since = Date.parse(String(options.since || ""));
  // Old callers omitted `until`; keep them compatible while bounding the
  // historical interval to the same one-hour batch rule.
  const requestedUntil = options.until ? Date.parse(String(options.until)) : Number.POSITIVE_INFINITY;
  const until = Number.isFinite(requestedUntil)
    ? requestedUntil
    : Math.min(Date.now(), since + LEGACY_PICKUP_WINDOW_MS);
  if (!match || sourceEmail !== `${match[1]}@icloud.com` || !Number.isFinite(since) || since > Date.now() || (options.until && !Number.isFinite(until)) || until < since) {
    throw new MailReadError("invalid_pickup_scope", 400);
  }
  const allowBase = options.allowBaseRecipient === true && !hasOtherPendingMailbox(email, sourceEmail);
  const sql = `SELECT DISTINCT m.* FROM mail_recipient_index r JOIN mail_messages m ON m.id=r.message_id
    WHERE r.email_hash IN (?,?) AND m.provider='shared-mail-api' AND julianday(m.received_at)>=julianday(?)`;
  const rows = (until === Number.POSITIVE_INFINITY
    ? db.prepare(`${sql} ORDER BY julianday(m.received_at) DESC,m.id DESC LIMIT 20`)
      .all(emailHash(email), emailHash(sourceEmail), new Date(since).toISOString())
    : db.prepare(`${sql} AND julianday(m.received_at)<=julianday(?) ORDER BY julianday(m.received_at) DESC,m.id DESC LIMIT 20`)
      .all(emailHash(email), emailHash(sourceEmail), new Date(since).toISOString(), new Date(until).toISOString())) as any[];
  const key = JSON.stringify([email, sourceEmail, since, until, allowBase, rows.map((row) => [row.id, row.indexed_at])]);
  const cached = results.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const inflight = pendingReads.get(key);
  if (inflight) return inflight;
  const task = (async () => {
    const candidates = rows.filter((row) => isVerificationMail(row.subject, row.sender)).slice(0, 8);
    for (const candidate of candidates) {
      const detail = await fetchSharedMessage(String(candidate.provider_message_id), email, reader);
      if (!detail) throw new MailReadError("mail_upstream_missing");
      const recipients = detail.recipients || [];
      const aliases = recipients.filter((recipient) => recipient.startsWith(`${match[1]}+`) && recipient.endsWith("@icloud.com"));
      // 显式的其他子邮箱优先于折叠的源邮箱，禁止不同子邮箱之间串码。
      if (aliases.some((recipient) => recipient !== email)) continue;
      if (!aliases.includes(email) && (!allowBase || !recipients.includes(sourceEmail))) {
        throw new MailReadError("mail_recipient_ambiguous", 409);
      }
      const code = extractVerificationCode(detail as unknown as Record<string, unknown>);
      if (code) return { ok: true, item: { id: candidate.id, verificationCode: code,
        created_at: candidate.received_at, subject: candidate.subject } };
    }
    return { ok: true, item: null };
  })().then((result) => {
    for (const [entry, value] of results) if (value.expiresAt <= Date.now()) results.delete(entry);
    if (results.size >= 512) results.delete(results.keys().next().value!);
    results.set(key, { expiresAt: Date.now() + 60_000, result });
    return result;
  }).finally(() => pendingReads.delete(key));
  pendingReads.set(key, task);
  return task;
}
