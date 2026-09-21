import crypto from "node:crypto";
import { normalizeEmail } from "./association.js";
import { db } from "./db.js";
import { decryptSecret } from "./crypto.js";
import { stripHtml, type SharedMessageDetail } from "./upstream-mail.js";

export interface ExternalMailbox {
  provider: "yangyang" | "applemail" | "flysms";
  email: string;
  token: string;
  origin: string;
  openUrl: string;
}

export class ExternalMailboxError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 502) { super(code); }
}

export function parseExternalMailbox(value: unknown): ExternalMailbox | null {
  const text = String(value || "").trim();
  const valid = (email: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const compact = text.match(/^flysms[:|]([^|:\s]+)[:|](\S+)$/i);
  if (compact && valid(compact[1])) return { provider: "flysms", email: normalizeEmail(compact[1]), token: compact[2],
    origin: "https://flysms.top", openUrl: `https://flysms.top/icloud/?email=${encodeURIComponent(normalizeEmail(compact[1]))}` };
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (/(^|\.)flysms\.top$/i.test(url.hostname)) {
      const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
      const email = normalizeEmail(url.searchParams.get("email") || url.searchParams.get("mailbox") || hash.get("email") || hash.get("mailbox") || "");
      const token = String(url.searchParams.get("token") || url.searchParams.get("importToken") || hash.get("token") || hash.get("importToken") || "").trim();
      return { provider: "flysms", email, token, origin: "https://flysms.top", openUrl: `https://flysms.top/icloud/${email ? `?email=${encodeURIComponent(email)}` : ""}` };
    }
    if (/(^|\.)yangyang\.website$/i.test(url.hostname)) {
      const match = url.pathname.match(/^\/messages\/([^/]+)\/([^/]+)\/?$/i);
      if (!match) return null;
      const email = normalizeEmail(decodeURIComponent(match[2]));
      const token = decodeURIComponent(match[1]);
      if (!valid(email) || !token) return null;
      return { provider: "yangyang", email, token, origin: url.origin,
        openUrl: `${url.origin}/messages/${encodeURIComponent(token)}/${encodeURIComponent(email)}` };
    }
    if (/(^|\.)applemail\.kfjie\.me$/i.test(url.hostname)) {
      const match = url.pathname.match(/^\/mail\/([^/]+)\/([^/]+)\/?$/i) || url.pathname.match(/^\/openapi\/mail\/([^/]+)\/([^/]+)\/latest\/?$/i);
      if (!match) return null;
      const email = normalizeEmail(decodeURIComponent(match[1]));
      const token = decodeURIComponent(match[2]);
      if (!valid(email) || !token) return null;
      return { provider: "applemail", email, token, origin: url.origin, openUrl: `${url.origin}/mail/${encodeURIComponent(email)}/${encodeURIComponent(token)}` };
    }
  } catch { return null; }
  return null;
}

async function jsonResponse(url: string, transport: typeof fetch): Promise<any> {
  let response;
  try {
    response = await transport(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "error" });
  } catch { throw new ExternalMailboxError("external_mail_transport_error"); }
  if (response.status === 404) return null;
  if (!response.ok) throw new ExternalMailboxError(`external_mail_http_${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new ExternalMailboxError("external_mail_empty_response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new ExternalMailboxError("external_mail_content_too_large", 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof ExternalMailboxError) throw error;
    throw new ExternalMailboxError("external_mail_invalid_response");
  }
}

const inFlight = new Map<string, Promise<SharedMessageDetail | null>>();

export function fetchExternalMessageById(external: ExternalMailbox, messageId: string, transport: typeof fetch = fetch): Promise<SharedMessageDetail | null> {
  if (external.provider === "flysms") return Promise.reject(new ExternalMailboxError("external_mail_manual_only", 409));
  if (external.provider === "applemail") return Promise.reject(new ExternalMailboxError("external_mail_id_api_unavailable", 503));
  if (!messageId || messageId.length > 512 || /[\r\n\0]/.test(messageId)) return Promise.reject(new ExternalMailboxError("external_mail_invalid_id", 400));
  const id = messageId.replace(/^yangyang-/, "");
  const key = crypto.createHash("sha256").update(`${external.origin}\0${external.email}\0${external.token}\0${id}`).digest("hex");
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = (async () => {
    const detail = await jsonResponse(`${external.origin}/message/${encodeURIComponent(id)}/${encodeURIComponent(external.token)}/${encodeURIComponent(external.email)}`, transport);
    if (!detail) return null;
    if (detail.id != null && String(detail.id) !== id) throw new ExternalMailboxError("external_mail_id_mismatch", 403);
    const recipient = normalizeEmail(detail.toAddress || detail.to_address || detail.email || "");
    if (recipient && recipient !== external.email) throw new ExternalMailboxError("external_mail_recipient_mismatch", 403);
    const body = String(detail.body || "");
    const html = /^data:text\/html(?:;[^,]*)?;base64,/i.test(body) ? Buffer.from(body.slice(body.indexOf(",") + 1), "base64").toString("utf8") : "";
    return { text: html ? stripHtml(html) : body, html,
      from: String(detail.fromAddress || detail.from_address || ""), to: external.email,
      subject: String(detail.subject || ""), receivedAt: String(detail.receivedAt || detail.received_at || "") };
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

export async function fetchExternalMessage(accountId: string, messageId: string, bindingId = ""): Promise<SharedMessageDetail | null> {
  const row = db.prepare(`SELECT m.*,c.credentials_enc FROM mail_messages m
    JOIN mail_ownership_claims oc ON oc.message_id=m.id JOIN mailbox_connections c ON c.binding_id=oc.binding_id
    WHERE m.id=? AND oc.account_id=? AND (?='' OR oc.binding_id=?) ORDER BY c.updated_at DESC LIMIT 1`)
    .get(messageId, accountId, bindingId, bindingId) as any;
  if (!row) return null;
  let address = "";
  try { address = String(JSON.parse(decryptSecret(String(row.credentials_enc || ""))).address || ""); } catch { /* Legacy records may lack connection material. */ }
  const external = parseExternalMailbox(address);
  if (!external) throw new ExternalMailboxError("external_mail_connection_unavailable", 503);
  const detail = await fetchExternalMessageById(external, String(row.provider_message_id));
  if (!detail) return null;
  return { ...detail, receivedAt: detail.receivedAt || String(row.received_at || ""), subject: detail.subject || String(row.subject || "") };
}
