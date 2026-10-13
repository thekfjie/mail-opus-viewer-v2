import { asyncMap } from './async-collections.js';
import { config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { db } from "./db.js";

export type CheckRouteKey = "promotion_jp" | "nl_ideal" | "de_paypal" | "ph_gcash";

export interface CheckRouteSummary {
  key: CheckRouteKey;
  label: string;
  ipCountry: string;
  configured: boolean;
  source: "saved" | "environment" | "none";
  addressDisplay: string;
}

export interface PaymentEligibilityApiSummary {
  configured: boolean;
  source: "saved" | "environment" | "default" | "none";
  endpoint: string;
  hasApiToken: boolean;
}

const SETTING_PREFIX = "check_route_proxy_v1:";
const ELIGIBILITY_ENDPOINT_SETTING = "payment_eligibility_endpoint_v1";
const ELIGIBILITY_TOKEN_SETTING = "payment_eligibility_api_token_v1";

const definitions: Record<CheckRouteKey, { label: string; ipCountry: string; environmentValue: () => string }> = {
  promotion_jp: {
    label: "JP 优惠检测",
    ipCountry: "JP",
    environmentValue: () => config.paymentExposurePromotionProxyJP,
  },
  nl_ideal: {
    label: "NL / EUR / iDEAL",
    ipCountry: "NL",
    environmentValue: () => String(process.env.PAYMENT_EXPOSURE_PROXY_NL || "").trim(),
  },
  de_paypal: {
    label: "DE / EUR / PayPal",
    ipCountry: "DE",
    environmentValue: () => String(process.env.PAYMENT_EXPOSURE_PROXY_DE || "").trim(),
  },
  ph_gcash: {
    label: "PH / PHP / GCash",
    ipCountry: "PH",
    environmentValue: () => String(process.env.PAYMENT_EXPOSURE_PROXY_PH || "").trim(),
  },
};

export function isCheckRouteKey(value: string): value is CheckRouteKey {
  return Object.prototype.hasOwnProperty.call(definitions, String(value || "").trim().toLowerCase());
}

function settingKey(key: CheckRouteKey): string {
  return `${SETTING_PREFIX}${key}`;
}

async function savedProxy(key: CheckRouteKey): Promise<string> {
  const row = (await db.prepare("SELECT value FROM settings WHERE key=?").get(settingKey(key))) as { value?: string } | undefined;
  if (!row?.value) return "";
  try { return decryptSecret(String(row.value)); } catch { return ""; }
}

async function savedSecret(key: string): Promise<string> {
  const row = (await db.prepare("SELECT value FROM settings WHERE key=?").get(key)) as { value?: string } | undefined;
  if (!row?.value) return "";
  try { return decryptSecret(String(row.value)); } catch { return ""; }
}

async function saveSecret(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  (await db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, encryptSecret(value), now));
}

function validateEligibilityEndpoint(value: unknown): string {
  const endpoint = String(value || "").trim();
  if (!endpoint) throw new Error("请填写支付资格检查接口地址");
  if (endpoint.length > 2048 || /[\r\n\0]/.test(endpoint)) throw new Error("检查接口地址格式不正确");
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error("检查接口地址必须是完整 HTTP/HTTPS URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error("检查接口仅支持不含账号密码和片段的 HTTP/HTTPS URL");
  }
  return parsed.toString();
}

export async function effectivePaymentEligibilityApi(): Promise<{ endpoint: string; apiToken: string }> {
  return {
    endpoint: (await savedSecret(ELIGIBILITY_ENDPOINT_SETTING)) || config.paymentEligibilityApiUrl,
    apiToken: (await savedSecret(ELIGIBILITY_TOKEN_SETTING)) || config.paymentEligibilityApiToken,
  };
}

export async function paymentEligibilityApiSummary(): Promise<PaymentEligibilityApiSummary> {
  const savedEndpoint = (await savedSecret(ELIGIBILITY_ENDPOINT_SETTING));
  const endpoint = savedEndpoint || config.paymentEligibilityApiUrl;
  const savedToken = (await savedSecret(ELIGIBILITY_TOKEN_SETTING));
  return {
    configured: Boolean(endpoint),
    source: savedEndpoint ? "saved" : process.env.PAYMENT_ELIGIBILITY_API_URL ? "environment" : endpoint ? "default" : "none",
    endpoint,
    hasApiToken: Boolean(savedToken || config.paymentEligibilityApiToken),
  };
}

export async function savePaymentEligibilityApi(endpointValue: unknown, apiTokenValue: unknown, updateToken: boolean): Promise<PaymentEligibilityApiSummary> {
  const endpoint = validateEligibilityEndpoint(endpointValue);
  (await saveSecret(ELIGIBILITY_ENDPOINT_SETTING, endpoint));
  if (updateToken) {
    const token = String(apiTokenValue || "").trim();
    if (token) (await saveSecret(ELIGIBILITY_TOKEN_SETTING, token));
    else (await db.prepare("DELETE FROM settings WHERE key=?").run(ELIGIBILITY_TOKEN_SETTING));
  }
  return (await paymentEligibilityApiSummary());
}

export async function clearPaymentEligibilityApi(): Promise<PaymentEligibilityApiSummary> {
  (await db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(ELIGIBILITY_ENDPOINT_SETTING, ELIGIBILITY_TOKEN_SETTING));
  return (await paymentEligibilityApiSummary());
}

export async function effectiveCheckProxy(key: CheckRouteKey): Promise<string> {
  return (await savedProxy(key)) || String(definitions[key].environmentValue() || "").trim();
}

function validateProxy(value: unknown): string {
  const proxy = String(value || "").trim();
  if (!proxy) throw new Error("请填写代理 / 出口地址");
  if (proxy.length > 2048 || /[\r\n\0]/.test(proxy) || /\s/.test(proxy)) throw new Error("代理 / 出口地址格式不正确");
  const supportedUrl = /^(?:https?|socks5h?):\/\/[^/\s]+(?::\d{2,5})?(?:\/.*)?$/i.test(proxy);
  const hostPort = /^(?:[^:@\s]+:[^@\s]+@)?[^:\s/]+:\d{2,5}(?::[^:\s]+:[^\s]+)?$/i.test(proxy);
  if (!supportedUrl && !hostPort) {
    throw new Error("支持 HTTP、HTTPS、SOCKS5，或 host:port:user:pass 格式");
  }
  return proxy;
}

function displayProxy(proxy: string): string {
  return proxy;
}

export async function checkRouteSummary(key: CheckRouteKey): Promise<CheckRouteSummary> {
  const saved = (await savedProxy(key));
  const environment = String(definitions[key].environmentValue() || "").trim();
  const proxy = saved || environment;
  return {
    key,
    label: definitions[key].label,
    ipCountry: definitions[key].ipCountry,
    configured: Boolean(proxy),
    source: saved ? "saved" : environment ? "environment" : "none",
    addressDisplay: proxy ? `${definitions[key].ipCountry} 路由 · ${displayProxy(proxy)}` : "",
  };
}

export async function listCheckRouteSummaries(): Promise<CheckRouteSummary[]> {
  return (await asyncMap((Object.keys(definitions) as CheckRouteKey[]), checkRouteSummary));
}

export async function saveCheckRouteProxy(key: CheckRouteKey, value: unknown): Promise<CheckRouteSummary> {
  const proxy = validateProxy(value);
  const now = new Date().toISOString();
  (await db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(settingKey(key), encryptSecret(proxy), now));
  return (await checkRouteSummary(key));
}

export async function clearCheckRouteProxy(key: CheckRouteKey): Promise<CheckRouteSummary> {
  (await db.prepare("DELETE FROM settings WHERE key=?").run(settingKey(key)));
  return (await checkRouteSummary(key));
}
