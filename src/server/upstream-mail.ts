import { config } from "./config.js";
import { simpleParser } from "mailparser";
import { gunzipSync } from "node:zlib";
import { db } from "./db.js";
import { D1MailReader, MailReadError, type SharedMailRow } from "./cf-mail.js";
import { normalizeEmail, splitEmail } from "./association.js";

export function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export const sharedMailReader = new D1MailReader(db, {
  accountId: config.cfAccountId, databaseId: config.cfD1DatabaseId,
  readToken: config.cfD1ReadToken, timeIndex: config.cfD1TimeIndex, leaseWaitMs: 5_000,
});

export function sharedMailRaw(mail: SharedMailRow): string {
  if (mail.raw) {
    if (Buffer.byteLength(mail.raw) > 8 * 1024 * 1024) throw new MailReadError("mail_content_too_large", 413);
    return mail.raw;
  }
  if (!mail.raw_blob) return "";
  try {
    const compressed = Array.isArray(mail.raw_blob) ? Buffer.from(mail.raw_blob) : Buffer.from(mail.raw_blob, "base64");
    return gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 }).toString("utf8");
  } catch { throw new MailReadError("mail_content_decode_failed"); }
}

export interface SharedMessageDetail {
  text: string; html: string; from: string; to: string; subject: string; receivedAt: string;
  recipients?: string[];
}

function inlineEmbeddedImages(htmlInput: string, attachments: any[]): string {
  let html = htmlInput;
  let embeddedBytes = 0;
  const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const attachment of attachments) {
    const content = Buffer.isBuffer(attachment?.content) ? attachment.content : null;
    const contentType = String(attachment?.contentType || "").toLowerCase();
    if (!content || !allowed.has(contentType) || content.byteLength > 2 * 1024 * 1024
      || embeddedBytes + content.byteLength > 4 * 1024 * 1024) continue;
    const references = [
      { value: String(attachment?.contentId || "").replace(/^<|>$/g, ""), cid: true },
      { value: String(attachment?.contentLocation || ""), cid: false },
    ].filter((reference) => reference.value);
    if (!references.length) continue;
    const dataUrl = `data:${contentType};base64,${content.toString("base64")}`;
    for (const reference of references) {
      const candidates = reference.cid ? [`cid:${reference.value}`, `cid:%3C${reference.value}%3E`] : [reference.value];
      for (const candidate of candidates) html = html.replace(new RegExp(escapeRegex(candidate), "gi"), dataUrl);
    }
    embeddedBytes += content.byteLength;
  }
  return html;
}

const EMAIL_ADDRESS_RE = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function addressCandidates(value: unknown): string[] {
  const input = String(value || "");
  const matches = input.match(EMAIL_ADDRESS_RE) || [];
  return [...new Set((matches.length ? matches : [input]).map(normalizeEmail).filter(Boolean))];
}

function recipientMatchesExpected(actualInput: string, expectedInput: string): boolean {
  const actualCandidates = addressCandidates(actualInput);
  const expectedCandidates = addressCandidates(expectedInput);
  if (!actualCandidates.length || !expectedCandidates.length) return false;
  return expectedCandidates.some((expected) => actualCandidates.some((actual) => recipientAddressMatches(actual, expected)));
}

function recipientAddressMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const actualParts = splitEmail(actual);
  const expectedParts = splitEmail(expected);
  if (expectedParts.domain !== actualParts.domain
    || (expectedParts.domain !== "icloud.com" && !expectedParts.domain.endsWith(".icloud.com"))) return false;
  const actualPlus = actualParts.localPart.includes("+");
  const expectedPlus = expectedParts.localPart.includes("+");
  if (actualPlus === expectedPlus) return false;
  const actualBase = actualPlus ? actualParts.localPart.split("+", 1)[0] : actualParts.localPart;
  const expectedBase = expectedPlus ? expectedParts.localPart.split("+", 1)[0] : expectedParts.localPart;
  return actualBase === expectedBase;
}

export async function fetchSharedMessage(messageId: string, expectedRecipient = "", reader: Pick<D1MailReader, "byId"> = sharedMailReader): Promise<SharedMessageDetail | null> {
  const row = await reader.byId(messageId);
  if (!row) return null;
  const parsed = await simpleParser(sharedMailRaw(row), { skipHtmlToText: false, skipTextToHtml: true });
  const recipients = [String(row.address || ""), ...parsed.headerLines
      .filter((header) => ["to", "cc", "received", "delivered-to", "x-original-to", "x-forwarded-to", "x-envelope-to", "envelope-to", "resent-to", "apparently-to", "x-icloud-hme"].includes(header.key))
      .map((header) => header.line)].join("\n").match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  if (expectedRecipient) {
    if (!recipients.some((recipient) => recipientMatchesExpected(recipient, expectedRecipient))) {
      throw new MailReadError("mail_recipient_mismatch", 403);
    }
  }
  const html = inlineEmbeddedImages(String(parsed.html || row.html || ""), parsed.attachments || []);
  return { text: String(parsed.text || row.text || "").trim() || stripHtml(html), html,
    from: String(parsed.from?.text || row.source || ""), to: String(row.address || ""),
    subject: String(parsed.subject || row.subject || ""), receivedAt: String(row.created_at || ""),
    recipients: [...new Set(recipients.map(normalizeEmail))] };
}

interface OutlookSession {
  cookie: string;
  createdAt: number;
}

let outlookSession: OutlookSession | null = null;

function cookies(response: Response): string {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  return values.map((value) => value.split(";")[0]).filter(Boolean).join("; ");
}

async function outlookLogin(): Promise<OutlookSession> {
  if (outlookSession && Date.now() - outlookSession.createdAt < 30 * 60 * 1000) return outlookSession;
  if (!config.outlookManagerPassword) throw new Error("Outlook 管理服务未配置登录密码");
  const response = await fetch(`${config.outlookManagerBase}/login`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ password: config.outlookManagerPassword }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok || payload?.success === false) throw new Error("Outlook 管理服务登录失败");
  outlookSession = { cookie: cookies(response), createdAt: Date.now() };
  return outlookSession;
}

interface OutlookRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  csrf?: boolean;
  retry?: boolean;
}

export async function outlookManagerFetch(path: string, options: OutlookRequestOptions = {}): Promise<any> {
  const session = await outlookLogin();
  const headers: Record<string, string> = { accept: "application/json", cookie: session.cookie };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.csrf) {
    const csrfResponse = await fetch(`${config.outlookManagerBase}/api/csrf-token`, {
      headers: { accept: "application/json", cookie: session.cookie }, signal: AbortSignal.timeout(15_000),
    });
    const csrf = await csrfResponse.json().catch(() => ({})) as any;
    if (!csrfResponse.ok) throw new Error("Outlook 管理服务 CSRF 初始化失败");
    if (csrf?.csrf_token) headers["x-csrf-token"] = String(csrf.csrf_token);
  }
  const response = await fetch(`${config.outlookManagerBase}${path.startsWith("/") ? path : `/${path}`}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 && options.retry !== false) {
    outlookSession = null;
    return outlookManagerFetch(path, { ...options, retry: false });
  }
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok || payload?.success === false) {
    throw new MailReadError(`outlook_upstream_${response.status === 200 ? "rejected" : response.status}`);
  }
  return payload;
}

export async function listOutlookManagerAccounts(): Promise<any[]> {
  const output: any[] = [];
  const limit = 200;
  for (let offset = 0; offset < 10_000; offset += limit) {
    const payload = await outlookManagerFetch(`/api/accounts?limit=${limit}&offset=${offset}`);
    const rows = Array.isArray(payload?.accounts) ? payload.accounts : [];
    output.push(...rows);
    if (!payload?.has_more || rows.length < limit) break;
  }
  return output;
}

export async function listOutlookManagerMails(mailboxEmail: string, offset = 0, limit = 20): Promise<any> {
  const query = new URLSearchParams({ method: "graph", folder: "all", skip: String(offset), top: String(limit) });
  return outlookManagerFetch(`/api/emails/${encodeURIComponent(mailboxEmail)}?${query}`);
}

export interface OutlookMessageDetail {
  text: string;
  html: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  folder: string;
}

function outlookAddress(value: any): string {
  if (Array.isArray(value)) return value.map(outlookAddress).filter(Boolean).join(", ");
  return String(value?.emailAddress?.address || value?.address || value?.email || value || "");
}

export async function fetchOutlookMessage(mailboxEmail: string, messageId: string, folder = "inbox", retry = true): Promise<OutlookMessageDetail | null> {
  if (!mailboxEmail || !messageId) return null;
  const session = await outlookLogin();
  const allowedFolder = new Set(["inbox", "junkemail", "deleteditems"]).has(folder.toLowerCase()) ? folder.toLowerCase() : "inbox";
  const legacyWrapper = `outlook-${allowedFolder}-`;
  const detailId = messageId.startsWith(legacyWrapper) ? messageId.slice(legacyWrapper.length) : messageId;
  const query = new URLSearchParams({ method: "graph", folder: allowedFolder });
  const response = await fetch(`${config.outlookManagerBase}/api/email/${encodeURIComponent(mailboxEmail)}/${encodeURIComponent(detailId)}?${query}`, {
    headers: { accept: "application/json", cookie: session.cookie },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 && retry) {
    outlookSession = null;
    return fetchOutlookMessage(mailboxEmail, messageId, folder, false);
  }
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok || !payload?.success || !payload?.email) return null;
  const detail = payload.email;
  const body = String(detail.body || detail.text || "");
  const bodyType = String(detail.body_type || "text").toLowerCase();
  const text = bodyType === "html" ? stripHtml(body) : body.trim();
  return {
    text,
    html: bodyType === "html" ? body : "",
    from: outlookAddress(detail.from),
    to: outlookAddress(detail.to) || mailboxEmail,
    subject: String(detail.subject || "(无主题)"),
    receivedAt: String(detail.date || detail.receivedDateTime || detail.created_at || ""),
    folder: allowedFolder,
  };
}
