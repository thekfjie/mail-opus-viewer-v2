import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function loadEnvFile(filePath: string): void {
  try {
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith("#")) continue;
      const index = value.indexOf("=");
      if (index < 1) continue;
      const key = value.slice(0, index).trim();
      let entry = value.slice(index + 1).trim();
      if ((entry.startsWith('"') && entry.endsWith('"')) || (entry.startsWith("'") && entry.endsWith("'"))) {
        entry = entry.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = entry;
    }
  } catch {
    // Optional configuration file.
  }
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readEnvObject(filePath: string): Record<string, string> {
  const output: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith("#")) continue;
      const index = value.indexOf("=");
      if (index < 1) continue;
      const key = value.slice(0, index).trim();
      let entry = value.slice(index + 1).trim();
      if ((entry.startsWith('"') && entry.endsWith('"')) || (entry.startsWith("'") && entry.endsWith("'"))) entry = entry.slice(1, -1);
      output[key] = entry;
    }
  } catch {
    // Optional protected integration file.
  }
  return output;
}

const projectRoot = path.resolve(process.env.PROJECT_ROOT || process.cwd());
loadEnvFile(process.env.ENV_FILE || path.join(projectRoot, ".env"));

const sessionSecret = process.env.V2_SESSION_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString("base64url");
const encryptionSource = process.env.CREDENTIAL_ENCRYPTION_KEY || `${sessionSecret}:mail-opus-v2-credentials`;
const credentialDirectory = process.env.CREDENTIALS_DIRECTORY || "";
const automyaiConfig = readJsonObject(
  process.env.AUTOMYAI_CONFIG_PATH
  || (credentialDirectory ? path.join(credentialDirectory, "automyai-config") : ""),
);
const outlookManagerEnv = readEnvObject(process.env.OUTLOOK_MANAGER_ENV_FILE || "/opt/outlook-manager/.env");

const routingPrimaryEmail = String(process.env.ROUTING_PRIMARY_EMAIL || "relay@example.net").trim().toLowerCase();
const routingLegacyEmails = new Set(
  String(process.env.ROUTING_LEGACY_EMAILS || "legacy-relay@example.net,archive-relay@example.net")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

const paymentExposurePromotionProxyJP = String(process.env.PAYMENT_EXPOSURE_PROMOTION_PROXY_JP || "").trim();
const paymentEligibilityApiUrl = String(process.env.PAYMENT_ELIGIBILITY_API_URL || "").trim();
const paymentEligibilityApiToken = String(process.env.PAYMENT_ELIGIBILITY_API_TOKEN || "").trim();
const paymentExposurePromotionRegion = "JP" as const;
const requestedAutoTrialRouteKey = String(process.env.V2_AUTO_TRIAL_ROUTE || "nl_ideal").trim().toLowerCase();
const autoTrialRouteKey = ["nl_ideal", "ph_gcash", "in_upi", "id_gopay", "kr_kakao", "kr_naver"].includes(requestedAutoTrialRouteKey)
  ? requestedAutoTrialRouteKey : "nl_ideal";
const autoTrialEnabled = !["0", "false", "off", "no"].includes(String(process.env.V2_AUTO_TRIAL_ENABLED || "true").toLowerCase());
const sharedMailSyncEnabled = ["1", "true", "on", "yes"].includes(String(process.env.V2_SHARED_MAIL_SYNC_ENABLED || "false").toLowerCase());
const outlookMailSyncEnabled = ["1", "true", "on", "yes"].includes(String(process.env.V2_OUTLOOK_MAIL_SYNC_ENABLED || "false").toLowerCase());
const accountAuthority = String(process.env.V2_ACCOUNT_AUTHORITY || "v1").trim().toLowerCase() === "v2" ? "v2" : "v1";

const paymentExposureRoutes = {
  nlIdeal: {
    key: "nl_ideal", label: "iDEAL 资格", target: "ideal", ipCountry: "NL",
    billingCountry: "NL", billingCurrency: "EUR", expectedMethod: "ideal",
  },
  phGCash: {
    key: "ph_gcash", label: "GCash 资格", target: "gcash", ipCountry: "PH",
    billingCountry: "PH", billingCurrency: "PHP", expectedMethod: "gcash",
  },
  inUPI: {
    key: "in_upi", label: "UPI 资格", target: "upi", ipCountry: "IN",
    billingCountry: "IN", billingCurrency: "INR", expectedMethod: "upi",
  },
  idGoPay: {
    key: "id_gopay", label: "GoPay 资格", target: "gopay", ipCountry: "ID",
    billingCountry: "ID", billingCurrency: "IDR", expectedMethod: "gopay",
  },
  krKakao: {
    key: "kr_kakao", label: "Kakao 资格", target: "kakao", ipCountry: "KR",
    billingCountry: "KR", billingCurrency: "KRW", expectedMethod: "kakao",
  },
  krNaver: {
    key: "kr_naver", label: "Naver 资格", target: "naver", ipCountry: "KR",
    billingCountry: "KR", billingCurrency: "KRW", expectedMethod: "naver",
  },
} as const;

export const config = {
  projectRoot,
  port: Number(process.env.PORT || 8790),
  databasePath: process.env.DATABASE_PATH || "/var/lib/mail-opus-v2/mail-opus-v2.sqlite",
  sqliteBusyTimeoutMs: Math.max(5_000, Math.min(120_000, Number(process.env.V2_SQLITE_BUSY_TIMEOUT_MS || 30_000))),
  readOnly: !["0", "false", "off"].includes(String(process.env.V2_READ_ONLY || "false").toLowerCase()),
  accountAuthority,
  syncIntervalMs: Math.max(10_000, Number(process.env.V2_SYNC_INTERVAL_MS || 60_000)),
  sharedMailSyncEnabled,
  sharedMailSyncIntervalMs: Math.max(60_000, Number(process.env.V2_SHARED_MAIL_SYNC_INTERVAL_MS || 10 * 60_000)),
  sharedMailPageSize: Math.max(10, Math.min(500, Number(process.env.V2_SHARED_MAIL_PAGE_SIZE || 100))),
  sharedMailMaxPages: Math.max(1, Math.min(100, Number(process.env.V2_SHARED_MAIL_MAX_PAGES || 20))),
  outlookMailSyncEnabled,
  outlookMailSyncBatch: Math.max(1, Math.min(100, Number(process.env.V2_OUTLOOK_MAIL_SYNC_BATCH || 20))),
  outlookSyncIntervalMs: Math.max(60_000, Number(process.env.V2_OUTLOOK_SYNC_INTERVAL_MS || 5 * 60_000)),
  autoTrialEnabled,
  autoTrialDelayMs: Math.max(0, Number(process.env.V2_AUTO_TRIAL_DELAY_MS || 12 * 60 * 60 * 1000)),
  autoTrialRetryMs: Math.max(60_000, Number(process.env.V2_AUTO_TRIAL_RETRY_MS || 6 * 60 * 60 * 1000)),
  autoTrialBatchSize: Math.max(1, Math.min(100, Number(process.env.V2_AUTO_TRIAL_BATCH_SIZE || 10))),
  autoTrialRouteKey,
  publicOrigin: process.env.PUBLIC_ORIGIN || "https://mail.example.com",
  sessionSecret,
  encryptionKey: crypto.createHash("sha256").update(encryptionSource).digest(),
  adminPassword: process.env.VIEWER_ADMIN_PASSWORD || process.env.MAIL_ADMIN_AUTH || "",
  importApiKey: process.env.IMPORT_API_KEY || "",
  paymentExposureApiKey: process.env.PAYMENT_EXPOSURE_API_KEY || process.env.OPUS_PAYMENT_EXPOSURE_API_KEY || "",
  automyaiExtractApiBase: String(process.env.AUTOMYAI_EXTRACT_API_BASE || "http://127.0.0.1:18794").replace(/\/+$/, ""),
  automyaiExtractApiKey: String(process.env.AUTOMYAI_EXTRACT_API_KEY || "").trim(),
  paymentExposureTimeoutMs: Math.max(10_000, Math.min(180_000, Number(process.env.PAYMENT_EXPOSURE_TIMEOUT_MS || 90_000))),
  paymentEligibilityApiUrl,
  paymentEligibilityApiToken,
  promotionPython: String(process.env.PROMOTION_PYTHON || "/opt/payment-checker/.venv/bin/python").trim(),
  promotionBridge: String(process.env.PROMOTION_BRIDGE || path.join(projectRoot, "scripts/promo-check-bridge.py")).trim(),
  promotionTimeoutMs: Math.max(10_000, Math.min(180_000, Number(process.env.PROMOTION_TIMEOUT_MS || 45_000))),
  promotionConcurrency: Math.max(1, Math.min(10, Number(process.env.V2_PROMOTION_CONCURRENCY || 2))),
  promotionCampaignCandidates: String(process.env.V2_PROMOTION_CAMPAIGNS
    || "plus-1-month-free,plus-2-months-50-pct-off,go-1-month-free,go-3-months-50-pct-off")
    .split(/[\s,]+/)
    .map((campaign) => campaign.trim())
    .filter(Boolean),
  paymentExposurePromoCampaign: String(process.env.PAYMENT_EXPOSURE_PROMO_CAMPAIGN_ID || "plus-1-month-free").trim() || "plus-1-month-free",
  paymentExposurePromotionRegion,
  paymentExposurePromotionProxyJP,
  paymentExposureRoutes,
  mailApiBase: String(process.env.MAIL_API_BASE || "https://mail-api.example.com").replace(/\/+$/, ""),
  mailAdminAuth: process.env.MAIL_ADMIN_AUTH || "",
  outlookManagerBase: String(process.env.OUTLOOK_MANAGER_BASE || "http://127.0.0.1:5010").replace(/\/+$/, ""),
  outlookManagerPassword: String(process.env.OUTLOOK_MANAGER_PASSWORD || outlookManagerEnv.LOGIN_PASSWORD || ""),
  // Keep the canonical destination separate from historical aliases. Both
  // remain routing endpoints for import purposes, but only the canonical
  // address is used by the external Cloudflare reconciliation script.
  routingPrimaryEmail,
  routingLegacyEmails,
  routingEmails: new Set([
    routingPrimaryEmail,
    ...String(process.env.ROUTING_EMAILS || "relay@routing.example.net")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
    ...routingLegacyEmails,
  ]),
  trustedRebindDomains: String(process.env.TRUSTED_REBIND_DOMAINS || "icloud.com,example.com,example.net")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^\*\./, ""))
    .filter(Boolean),
  sub2apiUrl: String(process.env.SUB2API_API_URL || automyaiConfig.SUB2API_API_URL || "http://127.0.0.1:8080/api/v1").replace(/\/+$/, ""),
  sub2apiAdminEmail: String(process.env.SUB2API_ADMIN_EMAIL || automyaiConfig.SUB2API_ADMIN_EMAIL || ""),
  sub2apiAdminPassword: String(process.env.SUB2API_ADMIN_PASSWORD || automyaiConfig.SUB2API_ADMIN_PASSWORD || ""),
  sub2apiAdminToken: String(process.env.SUB2API_ADMIN_TOKEN || automyaiConfig.SUB2API_ADMIN_TOKEN || ""),
};
