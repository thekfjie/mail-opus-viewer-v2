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
if (process.env.V1_ENV_FILE) loadEnvFile(process.env.V1_ENV_FILE);

const sessionSecret = process.env.V2_SESSION_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString("base64url");
const encryptionSource = process.env.CREDENTIAL_ENCRYPTION_KEY || `${sessionSecret}:mail-opus-v2-credentials`;
const credentialDirectory = process.env.CREDENTIALS_DIRECTORY || "";
const automyaiConfig = readJsonObject(
  process.env.AUTOMYAI_CONFIG_PATH
  || (credentialDirectory ? path.join(credentialDirectory, "automyai-config") : ""),
);
const outlookManagerEnv = readEnvObject(process.env.OUTLOOK_MANAGER_ENV_FILE || "");

const routingPrimaryEmail = String(process.env.ROUTING_PRIMARY_EMAIL || "").trim().toLowerCase();
const routingLegacyEmails = new Set(
  String(process.env.ROUTING_LEGACY_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

const paymentExposurePromotionProxyJP = String(process.env.PAYMENT_EXPOSURE_PROMOTION_PROXY_JP || "").trim();
const paymentExposurePromotionRegion = "JP" as const;
const requestedAutoTrialRouteKey = String(process.env.V2_AUTO_TRIAL_ROUTE || "nl_ideal").trim().toLowerCase();
const autoTrialRouteKey = ["nl_ideal", "de_paypal", "ph_gcash"].includes(requestedAutoTrialRouteKey)
  ? requestedAutoTrialRouteKey : "nl_ideal";
const autoTrialEnabled = !["0", "false", "off", "no"].includes(String(process.env.V2_AUTO_TRIAL_ENABLED || "true").toLowerCase());

const paymentExposureRoutes = {
  nlIdeal: {
    key: "nl_ideal", label: "NL / EUR / iDEAL", target: "ideal", ipCountry: "NL",
    billingCountry: "NL", billingCurrency: "EUR", expectedMethod: "ideal",
    proxy: String(process.env.PAYMENT_EXPOSURE_PROXY_NL || "").trim(),
    promotionProxy: paymentExposurePromotionProxyJP,
    promotionProxyRegion: paymentExposurePromotionRegion,
  },
  dePayPal: {
    key: "de_paypal", label: "DE / EUR / PayPal", target: "paypal", ipCountry: "DE",
    billingCountry: "DE", billingCurrency: "EUR", expectedMethod: "paypal",
    proxy: String(process.env.PAYMENT_EXPOSURE_PROXY_DE || "").trim(),
    promotionProxy: paymentExposurePromotionProxyJP,
    promotionProxyRegion: paymentExposurePromotionRegion,
  },
  phGCash: {
    key: "ph_gcash", label: "PH / PHP / GCash", target: "gcash", ipCountry: "PH",
    billingCountry: "PH", billingCurrency: "PHP", expectedMethod: "gcash",
    proxy: String(process.env.PAYMENT_EXPOSURE_PROXY_PH || "").trim(),
    promotionProxy: paymentExposurePromotionProxyJP,
    promotionProxyRegion: paymentExposurePromotionRegion,
  },
} as const;

export const config = {
  projectRoot,
  port: Number(process.env.PORT || 8790),
  databasePath: process.env.DATABASE_PATH || "/var/lib/mail-opus-v2/mail-opus-v2.sqlite",
  v1ConfigFile: process.env.V1_CONFIG_FILE || "",
  v1MailIndexFile: process.env.V1_MAIL_INDEX_FILE || "",
  v1BackupsDir: process.env.V1_BACKUPS_DIR || "",
  readOnly: !["0", "false", "off"].includes(String(process.env.V2_READ_ONLY || "true").toLowerCase()),
  syncIntervalMs: Math.max(10_000, Number(process.env.V2_SYNC_INTERVAL_MS || 60_000)),
  autoTrialEnabled,
  autoTrialDelayMs: Math.max(0, Number(process.env.V2_AUTO_TRIAL_DELAY_MS || 12 * 60 * 60 * 1000)),
  autoTrialRetryMs: Math.max(60_000, Number(process.env.V2_AUTO_TRIAL_RETRY_MS || 6 * 60 * 60 * 1000)),
  autoTrialBatchSize: Math.max(1, Math.min(100, Number(process.env.V2_AUTO_TRIAL_BATCH_SIZE || 10))),
  autoTrialRouteKey,
  publicOrigin: process.env.PUBLIC_ORIGIN || "http://127.0.0.1:8790",
  sessionSecret,
  encryptionKey: crypto.createHash("sha256").update(encryptionSource).digest(),
  adminPassword: process.env.VIEWER_ADMIN_PASSWORD || process.env.MAIL_ADMIN_AUTH || "",
  importApiKey: process.env.IMPORT_API_KEY || "",
  paymentExposureApiKey: process.env.PAYMENT_EXPOSURE_API_KEY || process.env.OPUS_PAYMENT_EXPOSURE_API_KEY || "",
  automyaiExtractApiBase: String(process.env.AUTOMYAI_EXTRACT_API_BASE || "http://127.0.0.1:18794").replace(/\/+$/, ""),
  automyaiExtractApiKey: String(process.env.AUTOMYAI_EXTRACT_API_KEY || "").trim(),
  paymentExposureTimeoutMs: Math.max(10_000, Math.min(180_000, Number(process.env.PAYMENT_EXPOSURE_TIMEOUT_MS || 90_000))),
  paymentExposurePromoCampaign: String(process.env.PAYMENT_EXPOSURE_PROMO_CAMPAIGN_ID || "plus-1-month-free").trim() || "plus-1-month-free",
  paymentExposurePromotionRegion,
  paymentExposureRoutes,
  mailApiBase: String(process.env.MAIL_API_BASE || "http://127.0.0.1:8787").replace(/\/+$/, ""),
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
    ...String(process.env.ROUTING_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
    ...routingLegacyEmails,
  ].filter(Boolean)),
  trustedRebindDomains: String(process.env.TRUSTED_REBIND_DOMAINS || "icloud.com,example.com")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^\*\./, ""))
    .filter(Boolean),
  sub2apiUrl: String(process.env.SUB2API_API_URL || automyaiConfig.SUB2API_API_URL || "http://127.0.0.1:8080/api/v1").replace(/\/+$/, ""),
  sub2apiAdminEmail: String(process.env.SUB2API_ADMIN_EMAIL || automyaiConfig.SUB2API_ADMIN_EMAIL || ""),
  sub2apiAdminPassword: String(process.env.SUB2API_ADMIN_PASSWORD || automyaiConfig.SUB2API_ADMIN_PASSWORD || ""),
  sub2apiAdminToken: String(process.env.SUB2API_ADMIN_TOKEN || automyaiConfig.SUB2API_ADMIN_TOKEN || ""),
};
