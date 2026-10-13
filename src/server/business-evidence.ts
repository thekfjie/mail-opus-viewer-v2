import type { Database } from "./storage/types.js";

export const LEGACY_RELAY_SENDER_PATTERN = "(^|<|\\b)[a-z]+_at_tm[a-z0-9]*_openai_com_[a-z0-9]+_[a-z0-9]+@icloud\\.com(>|\\b|$)";
export const LEGACY_DIRECT_SENDER_PATTERN = "(^|<|\\b)[^\\s<>@]+@(?:[a-z0-9-]+\\.)*openai\\.com(>|\\b|$)";

export function mailboxRecipientPattern(address: string): string {
  return `(^|<|\\b)${address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(>|\\b|$)`;
}

export async function applyBusinessEvidenceSchema(database: Database): Promise<void> {
  (await database.exec(`CREATE TABLE IF NOT EXISTS account_passwords (
    account_id TEXT PRIMARY KEY REFERENCES gpt_accounts(id) ON DELETE CASCADE,
    password_enc TEXT NOT NULL DEFAULT '', totp_secret_enc TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
  )`));
  (await database.exec(`CREATE TABLE IF NOT EXISTS account_business_evidence (
    account_id TEXT PRIMARY KEY REFERENCES gpt_accounts(id) ON DELETE CASCADE,
    hidden_tags_json TEXT NOT NULL DEFAULT '[]',
    mail_verified_no_plus INTEGER NOT NULL DEFAULT 0,
    mail_verified_at TEXT NOT NULL DEFAULT '',
    recycle_generation INTEGER,
    billing_started_at TEXT NOT NULL DEFAULT '',
    last_activity_at TEXT NOT NULL DEFAULT '',
    newest_mail_at TEXT NOT NULL DEFAULT '',
    audit_binding_id TEXT NOT NULL DEFAULT '',
    audited_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`));
}

export function normalizeHiddenTags(value: unknown): Record<string, string | boolean>[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-64).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const ipCountry = String(item.ipCountry || "").trim().toUpperCase();
    const billingCountry = String(item.billingCountry || "").trim().toUpperCase();
    const billingCurrency = String(item.billingCurrency || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(ipCountry) || !/^[A-Z]{2}$/.test(billingCountry) || !/^[A-Z]{3}$/.test(billingCurrency)) return [];
    const strategy = ["native_create", "post_create_update"].includes(String(item.strategy)) ? String(item.strategy) : "native_create";
    const type = String(item.checkoutType || "").toLowerCase();
    return [{ kind: "pp_probe", key: `pp_probe:${ipCountry}:${billingCountry}:${billingCurrency}:${strategy}`,
      ipCountry, billingCountry, billingCurrency, strategy,
      checkoutType: type === "stripe_live" ? "cs_live" : ["oaics", "cs_live"].includes(type) ? type : "unknown",
      paypalExposed: Boolean(item.paypalExposed) }];
  });
}

function tokenPlanClaims(token: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
    const auth = payload["https://api.openai.com/auth"] || {};
    return [auth.chatgpt_plan_type, auth.plan_type, auth.planType, payload["https://api.openai.com/auth.chatgpt_plan_type"],
      payload.chatgpt_plan_type, payload.plan_type, payload.planType,
      ...Object.entries(payload).filter(([key]) => /chatgpt[_-]?plan[_-]?type$/i.test(key)).map(([, value]) => value)]
      .map((value) => String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, ""));
  } catch { return []; }
}

export function credentialPlan(accessToken: string, idToken: string): "free" | "paid" | "unknown" {
  const claims = [...tokenPlanClaims(accessToken), ...tokenPlanClaims(idToken)];
  if (claims.some((claim) => ["plus", "pro", "team", "business", "enterprise", "edu", "chatgptplus", "chatgptpro"].includes(claim))) return "paid";
  return claims.some((claim) => ["free", "chatgptfree"].includes(claim)) ? "free" : "unknown";
}

export const ACCOUNT_ACTIVITY_SUBJECT_PATTERNS = [
  /New sign-in to your OpenAI account/i,
  /(?:new|新的|新しい).*(?:sign[ -]?in|login|登录|登入|device|设备|裝置)/i,
  /(?:temporary|临时|臨時|一時的な|一時).*(?:ChatGPT|OpenAI).*(?:login code|verification code|登录代码|登入代碼|验证码|驗證碼|認証コード|検証コード)/i,
  /(?:ChatGPT|OpenAI).*(?:temporary|临时|臨時|一時的な|一時).*(?:login code|verification code|登录代码|登入代碼|验证码|驗證碼|認証コード|検証コード)/i,
  /ChatGPT\s*の(?:一時的な認証コード|一時検証コード)/,
  /(?:security key|passkey).*(?:added|新增|添加)/i,
  /Advanced Account Security is now enabled/i,
];

export function isAccountActivitySubject(subject: string): boolean {
  return ACCOUNT_ACTIVITY_SUBJECT_PATTERNS.some((pattern) => pattern.test(subject.replace(/\s+/g, " ").trim()));
}
