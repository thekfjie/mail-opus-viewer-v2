import { config } from "./config.js";
import { simpleParser } from "mailparser";

function stripHtml(value: string): string {
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

export async function fetchSharedMailPage(offset: number, limit: number): Promise<any> {
  if (!config.mailAdminAuth) throw new Error("邮件服务后台口令未配置");
  const response = await fetch(`${config.mailApiBase}/admin/mails?limit=${limit}&offset=${offset}`, {
    headers: { "x-admin-auth": config.mailAdminAuth, "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`邮件服务返回 ${response.status}`);
  return response.json();
}

let newestCache: { id: number; expiresAt: number } = { id: 0, expiresAt: 0 };

async function newestSharedId(): Promise<number> {
  if (newestCache.id && newestCache.expiresAt > Date.now()) return newestCache.id;
  const data = await fetchSharedMailPage(0, 1);
  const id = Number(data?.results?.[0]?.id || 0);
  newestCache = { id, expiresAt: Date.now() + 30_000 };
  return id;
}

export async function fetchSharedMessage(messageId: string): Promise<{ text: string } | null> {
  const numericId = Number(messageId);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;
  const newestId = await newestSharedId();
  if (!newestId) return null;
  let offset = Math.max(0, newestId - numericId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const data = await fetchSharedMailPage(offset, 5);
    const results = Array.isArray(data?.results) ? data.results : [];
    const hit = results.find((mail: any) => String(mail.id) === String(messageId));
    if (hit) {
      const text = String(hit.text || hit.body || "");
      const html = String(hit.html || "");
      const raw = String(hit.raw || "");
      let rawText = "";
      if (raw) {
        const parsed = await simpleParser(raw, { skipHtmlToText: false, skipTextToHtml: true });
        rawText = String(parsed.text || "").trim() || stripHtml(String(parsed.html || ""));
      }
      return { text: text.trim() || stripHtml(html) || rawText };
    }
    if (!results.length) return null;
    const first = Number(results[0]?.id || 0);
    const last = Number(results[results.length - 1]?.id || 0);
    if (numericId > first) offset = Math.max(0, offset - 5);
    else if (numericId < last) offset += 5;
    else return null;
  }
  return null;
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
    const detail = String(payload?.error?.message || payload?.error || payload?.message || response.status);
    throw new Error(`Outlook 管理服务返回 ${detail}`);
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
