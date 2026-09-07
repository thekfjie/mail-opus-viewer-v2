import crypto from "node:crypto";
import { config } from "./config.js";
import { legacyConfig } from "./legacy-config.js";
import { db } from "./db.js";
import { syncFromV1 } from "./legacy-import.js";

interface V1RequestOptions {
  method?: string;
  body?: unknown;
  apiKey?: boolean;
}

let adminCookie = "";
let adminCookieExpiresAt = 0;
let commandQueue: Promise<unknown> = Promise.resolve();

function responseCookie(response: Response): string {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

async function parseResponse(response: Response): Promise<any> {
  const text = await response.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { detail: text.slice(0, 1_000) }; }
  if (!response.ok) {
    const error = new Error(String(payload?.error || payload?.detail || `V1 请求失败 ${response.status}`));
    (error as any).statusCode = response.status;
    throw error;
  }
  return payload;
}

async function loginV1(): Promise<void> {
  if (adminCookie && adminCookieExpiresAt > Date.now()) return;
  if (!config.adminPassword) throw new Error("V1/V2 共存写入缺少后台口令配置");
  const response = await fetch(`${legacyConfig.baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "", password: config.adminPassword }),
    signal: AbortSignal.timeout(15_000),
  });
  await parseResponse(response);
  adminCookie = responseCookie(response);
  if (!adminCookie) throw new Error("V1 登录成功但没有返回后台会话");
  adminCookieExpiresAt = Date.now() + 30 * 60 * 1_000;
}

export async function requestV1(path: string, options: V1RequestOptions = {}, retry = true): Promise<any> {
  const apiKey = Boolean(options.apiKey);
  if (apiKey) {
    if (!config.importApiKey) throw new Error("V1/V2 共存写入缺少导入 API 密钥");
  } else {
    await loginV1();
  }
  const response = await fetch(`${legacyConfig.baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
    method: options.method || "GET",
    headers: {
      host: "legacy-mail.example.com",
      "x-forwarded-host": "legacy-mail.example.com",
      "x-forwarded-proto": "https",
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(apiKey ? { "x-api-key": config.importApiKey } : { cookie: adminCookie }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 401 && !apiKey && retry) {
    adminCookie = "";
    adminCookieExpiresAt = 0;
    return requestV1(path, options, false);
  }
  return parseResponse(response);
}

function queue<T>(operation: () => Promise<T>): Promise<T> {
  const next = commandQueue.then(operation, operation);
  commandQueue = next.then(() => undefined, () => undefined);
  return next;
}

export function currentLegacyMappingId(accountId: string): string {
  const row = db.prepare(`SELECT legacy_mapping_id FROM email_bindings
    WHERE account_id=? AND is_current=1 AND legacy_mapping_id NOT LIKE 'v2:%'
    ORDER BY valid_from DESC, created_at DESC LIMIT 1`).get(accountId) as any;
  if (!row?.legacy_mapping_id) throw new Error("账号没有可写入的 V1 当前映射");
  return String(row.legacy_mapping_id);
}

export function allLegacyMappingIds(accountIds: string[]): string[] {
  const ids = [...new Set(accountIds.map(String).filter(Boolean))].slice(0, 500);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT legacy_mapping_id FROM email_bindings
    WHERE account_id IN (${placeholders}) AND legacy_mapping_id NOT LIKE 'v2:%'
    ORDER BY is_current DESC, valid_from DESC`).all(...ids) as any[];
  return [...new Set(rows.map((row) => String(row.legacy_mapping_id || "")).filter(Boolean))];
}

export async function syncAfterV1Write<T>(operation: () => Promise<T>): Promise<{ result: T; sync: ReturnType<typeof syncFromV1> }> {
  return queue(async () => {
    const result = await operation();
    const sync = syncFromV1();
    return { result, sync };
  });
}

export async function v1CompatCommand(action: string, accountIds: string[], extra: Record<string, unknown> = {}): Promise<any> {
  const currentOnly = new Set(["patch", "deactivate", "rebind", "grant", "revoke"]);
  const ids = currentOnly.has(action)
    ? [...new Set(accountIds.map(currentLegacyMappingId))]
    : allLegacyMappingIds(accountIds);
  if (!ids.length) throw new Error("所选账号没有可写入的 V1 映射");
  const output = await syncAfterV1Write(() => requestV1("/api/v1/compat/command", {
    method: "POST", apiKey: true, body: { action, ids, requestId: crypto.randomUUID(), ...extra },
  }));
  return output.result;
}

export async function proxyV1AndSync(path: string, options: V1RequestOptions = {}): Promise<any> {
  return syncAfterV1Write(() => requestV1(path, options));
}

export async function proxyV1AndScheduleSync(path: string, options: V1RequestOptions = {}): Promise<{ result: any; syncPending: true }> {
  const result = await queue(() => requestV1(path, options));
  const timer = setTimeout(() => {
    void queue(async () => { syncFromV1(); }).catch((error) => {
      console.error(`V1 后台投影同步失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 250);
  timer.unref();
  return { result, syncPending: true };
}

export async function v1Health(): Promise<Record<string, unknown>> {
  const started = Date.now();
  try {
    const response = await fetch(`${legacyConfig.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    const payload = await parseResponse(response);
    return { ok: true, latencyMs: Date.now() - started, release: payload.release || {} };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}
