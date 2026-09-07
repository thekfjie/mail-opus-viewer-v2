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

function savedProxy(key: CheckRouteKey): string {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(settingKey(key)) as { value?: string } | undefined;
  if (!row?.value) return "";
  try { return decryptSecret(String(row.value)); } catch { return ""; }
}

function savedSecret(key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value?: string } | undefined;
  if (!row?.value) return "";
  try { return decryptSecret(String(row.value)); } catch { return ""; }
}

function saveSecret(key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, encryptSecret(value), now);
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

export function effectivePaymentEligibilityApi(): { endpoint: string; apiToken: string } {
  return {
    endpoint: savedSecret(ELIGIBILITY_ENDPOINT_SETTING) || config.paymentEligibilityApiUrl,
    apiToken: savedSecret(ELIGIBILITY_TOKEN_SETTING) || config.paymentEligibilityApiToken,
  };
}

export function paymentEligibilityApiSummary(): PaymentEligibilityApiSummary {
  const savedEndpoint = savedSecret(ELIGIBILITY_ENDPOINT_SETTING);
  const endpoint = savedEndpoint || config.paymentEligibilityApiUrl;
  const savedToken = savedSecret(ELIGIBILITY_TOKEN_SETTING);
  return {
    configured: Boolean(endpoint),
    source: savedEndpoint ? "saved" : process.env.PAYMENT_ELIGIBILITY_API_URL ? "environment" : endpoint ? "default" : "none",
    endpoint,
    hasApiToken: Boolean(savedToken || config.paymentEligibilityApiToken),
  };
}

export function savePaymentEligibilityApi(endpointValue: unknown, apiTokenValue: unknown, updateToken: boolean): PaymentEligibilityApiSummary {
  const endpoint = validateEligibilityEndpoint(endpointValue);
  saveSecret(ELIGIBILITY_ENDPOINT_SETTING, endpoint);
  if (updateToken) {
    const token = String(apiTokenValue || "").trim();
    if (token) saveSecret(ELIGIBILITY_TOKEN_SETTING, token);
    else db.prepare("DELETE FROM settings WHERE key=?").run(ELIGIBILITY_TOKEN_SETTING);
  }
  return paymentEligibilityApiSummary();
}

export function clearPaymentEligibilityApi(): PaymentEligibilityApiSummary {
  db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(ELIGIBILITY_ENDPOINT_SETTING, ELIGIBILITY_TOKEN_SETTING);
  return paymentEligibilityApiSummary();
}

export function effectiveCheckProxy(key: CheckRouteKey): string {
  return savedProxy(key) || String(definitions[key].environmentValue() || "").trim();
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

export function checkRouteSummary(key: CheckRouteKey): CheckRouteSummary {
  const saved = savedProxy(key);
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

export function listCheckRouteSummaries(): CheckRouteSummary[] {
  return (Object.keys(definitions) as CheckRouteKey[]).map(checkRouteSummary);
}

export function saveCheckRouteProxy(key: CheckRouteKey, value: unknown): CheckRouteSummary {
  const proxy = validateProxy(value);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(settingKey(key), encryptSecret(proxy), now);
  return checkRouteSummary(key);
}

export function clearCheckRouteProxy(key: CheckRouteKey): CheckRouteSummary {
  db.prepare("DELETE FROM settings WHERE key=?").run(settingKey(key));
  return checkRouteSummary(key);
}
