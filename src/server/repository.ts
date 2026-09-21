import crypto from "node:crypto";
import { customerGrantBlockReason } from "../shared/customer-access-policy.js";
import { mailboxBindingBatchSql } from "./mailbox-batch.js";
import fs from "node:fs";
import path from "node:path";
import { AccountDetail, AccountSummary, PaymentExposureCheck, PaymentExposureMethodSummary, PaymentExposurePromoMode } from "../shared/types.js";
import { emailHash, normalizeEmail, parseJwtSubject, splitEmail, stableId } from "./association.js";
import { config } from "./config.js";
import { decryptSecret, digestToken, encryptSecret, hashPassword, verifyPassword } from "./crypto.js";
import { db } from "./db.js";
import { credentialHistory, observeCredentialVersion } from "./credential-versions.js";
import { assertRecycleEligibility, recycleEligibilityAudit } from "./recycle-eligibility.js";
import { isPlanOrderSubject, isStrictPlusEvidenceSubject } from "./plus-evidence.js";
import type { RecycleMode } from "../shared/types.js";
export { getRecycleEligibility } from "./recycle-eligibility.js";
export type { RecycleMode } from "../shared/types.js";
import {
  cancelUnusedSale,
  freezeAccountTransition,
  issueCustomerGrant,
  mailboxProvider as transitionMailboxProvider,
  markGrantUsed,
  quarantineAccount,
  rebindAccountTransition,
  recordIdentityObservation,
  recycleAccountTransition,
  resolveAccountMatch,
  revokeGrantTransition,
  createPendingAssociationReview,
  deleteAccountTransition,
} from "./account-transitions.js";

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "***";
  const visible = local.length <= 3 ? local.slice(0, 1) : local.slice(0, 3);
  return `${visible}${"*".repeat(Math.max(3, Math.min(8, local.length - visible.length)))}@${domain}`;
}

function boolean(value: unknown): boolean {
  return Boolean(Number(value));
}

function promotionCampaignIds(value: unknown): string[] {
  try {
    const evidence = JSON.parse(String(value || "{}"));
    const campaigns = Array.isArray(evidence?.campaigns) ? evidence.campaigns : [];
    const ids = campaigns.map((item: unknown): string => {
      if (typeof item === "string") return item.trim();
      return item && typeof item === "object" ? String((item as any).id || "").trim() : "";
    }).filter((id: string) => Boolean(id));
    if (!ids.length) {
      const legacy = evidence?.campaignValue;
      const legacyId = typeof legacy === "string" ? legacy.trim()
        : legacy && typeof legacy === "object" ? String(legacy.id || "").trim() : "";
      if (legacyId) ids.push(legacyId);
    }
    return [...new Set<string>(ids)].slice(0, 50);
  } catch {
    return [];
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function formatAliveDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${Math.max(minutes, 0)}分`;
}

export function computeAliveInfo(billingStartedAt: string, deactivatedAt: string, nowMs = Date.now()): {
  billingStartedAt: string; aliveUntil: string; aliveMs: number; aliveLabel: string; aliveActive: boolean;
} {
  const startMs = Date.parse(String(billingStartedAt || ""));
  if (!Number.isFinite(startMs)) return { billingStartedAt: "", aliveUntil: "", aliveMs: 0, aliveLabel: "", aliveActive: false };
  const deactivatedMs = Date.parse(String(deactivatedAt || ""));
  const hasDeactivation = Number.isFinite(deactivatedMs) && deactivatedMs >= startMs;
  const endMs = hasDeactivation ? deactivatedMs : Math.max(startMs, nowMs);
  const aliveMs = Math.max(0, endMs - startMs);
  const duration = formatAliveDuration(aliveMs);
  return {
    billingStartedAt: new Date(startMs).toISOString(),
    aliveUntil: new Date(endMs).toISOString(),
    aliveMs,
    aliveLabel: hasDeactivation ? `账单起存活 ${duration}（已停用）` : `账单起已活 ${duration}`,
    aliveActive: !hasDeactivation,
  };
}

export function billingStartedAtFromMails(
  rows: Array<{ subject?: string; received_at?: string }>, plan: string, billingChannel: string,
): string {
  if (plan.toLowerCase() !== "plus") return "";
  // The generic plan-order subject is a valid start anchor once Plus is
  // already established. Channel extraction can be unavailable from an
  // index-only read, and must not hide the billing start date itself.
  for (const row of rows) {
    const subject = String(row.subject || "");
    if (isStrictPlusEvidenceSubject(subject) || isPlanOrderSubject(subject)) return String(row.received_at || "");
  }
  return "";
}

function billingStartedAtForAccount(accountId: string, plan: string, billingChannel: string, persisted = ""): string {
  const rows = db.prepare(`SELECT DISTINCT m.id,m.subject,m.received_at
    FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id
    WHERE oc.account_id=? AND m.received_at!='' ORDER BY datetime(m.received_at) ASC`).all(accountId) as Array<{ subject?: string; received_at?: string }>;
  const derived = billingStartedAtFromMails(rows, plan, billingChannel);
  const values = [persisted, derived].filter((value) => Number.isFinite(Date.parse(value)));
  return values.sort((left, right) => Date.parse(left) - Date.parse(right))[0] || "";
}

function mailboxProvider(email: string): string {
  return transitionMailboxProvider(email);
}

const OPENAI_SIGNUP_POOL_NOTE = "automyai OpenAI signup pool pending";
const OPENAI_REBIND_TARGET_NOTE = "automyai OpenAI email rebind target pending";
const OPENAI_X_COMPLETED_NOTE = "automyai OpenAI X completed";
const OWNED_DOMAIN_ASSOCIATION_NOTE = "automyai 自动关联域名邮箱；仅使用明确自有域名";

function credentialState(row: any): { state: string; label: string; internalPending: boolean } {
  const hasAccessToken = boolean(row.has_access_token);
  const hasRefreshToken = boolean(row.has_refresh_token);
  const hasStoredAccessToken = boolean(row.has_stored_access_token);
  const hasStoredRefreshToken = boolean(row.has_stored_refresh_token);
  const note = String(row.note || "").trim();
  if (hasAccessToken) return { state: "ready", label: "AT 已就绪", internalPending: false };
  if (hasStoredAccessToken) return { state: "invalid_at", label: "AT 已保存但已失效", internalPending: false };
  if (hasStoredRefreshToken && !hasRefreshToken) return { state: "inactive_rt", label: "RT 已保存但当前不可用", internalPending: false };
  if (note === OPENAI_SIGNUP_POOL_NOTE && !hasRefreshToken) {
    return { state: "signup_pending", label: "注册池待注册", internalPending: true };
  }
  if (note === OPENAI_REBIND_TARGET_NOTE && !hasRefreshToken) {
    return { state: "rebind_pending", label: "自动换绑目标待完成", internalPending: true };
  }
  if (note === OPENAI_X_COMPLETED_NOTE) {
    return { state: "completed_missing_at", label: "任务结束但登录恢复缺 AT", internalPending: false };
  }
  if (note === OWNED_DOMAIN_ASSOCIATION_NOTE || (boolean(row.domain_mailbox) && Number(row.relation_count || 0) > 0)) {
    return { state: "associated_missing_at", label: "域名关联完成，等待新 Session/AT", internalPending: false };
  }
  if (hasRefreshToken) return { state: "refresh_only", label: "仅 RT，等待刷新 AT", internalPending: false };
  return { state: "missing", label: "AT/RT 来源未落库", internalPending: false };
}

const INTERNAL_PENDING_SQL = `(TRIM(a.note) IN ('${OPENAI_SIGNUP_POOL_NOTE}', '${OPENAI_REBIND_TARGET_NOTE}')
  AND COALESCE(c.access_token_alive,0)=0 AND COALESCE(c.refresh_token_alive,0)=0)`;

function insertAdminOnlyGrant(accountId: string, bindingId: string, email: string, now: string): void {
  const password = crypto.randomBytes(18).toString("base64url");
  db.prepare(`INSERT INTO access_grants(id, account_id, binding_id, public_token_hash, login_identifier_hash, login_identifier_enc,
    password_hash, password_plain_enc, scope, active, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'admin_only', 0, ?, ?)`).run(
    crypto.randomUUID(), accountId, bindingId, digestToken(crypto.randomUUID()), emailHash(email), encryptSecret(email),
    hashPassword(password), encryptSecret(password), now, now,
  );
}

function accountRowToSummary(row: any): AccountSummary {
  const primaryEmail = decryptSecret(String(row.primary_email_enc || ""));
  const credentials = credentialState(row);
  const hasPlus = String(row.plan || "").toLowerCase() === "plus";
  const deactivated = boolean(row.deactivation_locked) || String(row.lifecycle_status || "") === "deactivated";
  const accountState = hasPlus ? (deactivated ? "plus_deactivated" : "plus") : (deactivated ? "free_deactivated" : "free_unactivated");
  const accountStateLabel = accountState === "plus_deactivated" ? "Plus 已停用"
    : accountState === "plus" ? "Plus"
      : accountState === "free_deactivated" ? "Free 已停用" : "Free 未开通";
  const paymentExposureCount = Number(row.payment_exposure_count || 0);
  const paymentExposureExposedCount = Number(row.payment_exposure_exposed_count || 0);
  const paymentExposureUnknownCount = Number(row.payment_exposure_unknown_count || 0);
  const paymentExposureStatus = paymentExposureCount === 0 ? "never"
    : paymentExposureUnknownCount > 0 ? (paymentExposureExposedCount > 0 ? "partial" : "unknown")
      : paymentExposureExposedCount > 0 ? "exposed" : "not_exposed";
  const trialPromoValue = Number(row.latest_promo_eligible);
  const promoEligible = Number.isFinite(trialPromoValue) && trialPromoValue >= 0 ? trialPromoValue === 1 : null;
  const promoSuspiciousOverride = boolean(row.promo_suspicious_override);
  const promoSuspicious = promoEligible === false && (boolean(row.ever_promo_eligible) || promoSuspiciousOverride);
  const accessTokenFirstSeenAt = String(row.access_token_first_seen_at || "");
  const firstSeenMs = Date.parse(accessTokenFirstSeenAt);
  const autoTrialDueAt = Number.isFinite(firstSeenMs)
    ? new Date(firstSeenMs + config.autoTrialDelayMs).toISOString() : "";
  const billingStartedAt = billingStartedAtForAccount(
    String(row.id), String(row.plan || ""), String(row.billing_channel || ""), String(row.billing_started_at || ""),
  );
  const alive = computeAliveInfo(billingStartedAt, String(row.deactivated_at || ""));
  const openAiAuthMethods = (() => {
    try {
      const value = JSON.parse(String(row.openai_auth_methods_json || "[]"));
      return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
    } catch { return []; }
  })();
  const paymentExposureMethods = String(row.payment_exposure_methods || "").split(",").map((item) => item.trim()).filter(Boolean);
  const paymentExposureMethodDetails = paymentMethodSummaries(
    paymentExposureMethods,
    jsonMethodArray(row.payment_exposure_method_details_json),
  );
  return {
    id: String(row.id),
    primaryEmail,
    primaryEmailMasked: maskEmail(primaryEmail),
    lifecycleStatus: row.lifecycle_status,
    retiredAt: String(row.retired_at || ""),
    quarantineReason: String(row.quarantine_reason || ""),
    deactivationLocked: boolean(row.deactivation_locked),
    deactivatedAt: String(row.deactivated_at || ""),
    sold: boolean(row.sold),
    everSold: boolean(row.sold) || Boolean(row.sale_id),
    saleStatus: String(row.sale_status || "none") as AccountSummary["saleStatus"],
    saleId: String(row.sale_id || ""),
    saleFirstUsedAt: String(row.sale_first_used_at || ""),
    sellable: !customerGrantBlockReason({ lifecycleStatus: row.lifecycle_status, retiredAt: row.retired_at,
      quarantineReason: row.quarantine_reason, identityStatus: row.identity_status }) && !boolean(row.sold) && !credentials.internalPending,
    sellBlockers: [
      ...[customerGrantBlockReason({ lifecycleStatus: row.lifecycle_status, retiredAt: row.retired_at,
        quarantineReason: row.quarantine_reason, identityStatus: row.identity_status })].filter(Boolean),
      ...(boolean(row.sold) ? ["该GPT身份已经出售"] : []),
      ...(credentials.internalPending ? [credentials.label] : []),
    ],
    identityStatus: String(row.identity_status || "unknown"),
    accountState,
    accountStateLabel,
    hidePromotion: boolean(row.hide_promotion),
    plan: String(row.plan || "unknown"),
    billingChannel: String(row.billing_channel || ""),
    billingChannelOverride: String(row.billing_channel_override || ""),
    provider: String(row.provider || "unknown"),
    domainMailbox: boolean(row.domain_mailbox),
    isAuto: boolean(row.is_auto),
    openAiMfaEnabled: boolean(row.openai_mfa_enabled),
    openAiAuthMethods,
    suspectedUnused: boolean(row.suspected_unused),
    hasAccessToken: boolean(row.has_access_token),
    hasRefreshToken: boolean(row.has_refresh_token),
    hasStoredAccessToken: boolean(row.has_stored_access_token),
    hasStoredRefreshToken: boolean(row.has_stored_refresh_token),
    credentialState: credentials.state,
    credentialStateLabel: credentials.label,
    internalPending: credentials.internalPending,
    markColor: String(row.mark_color || ""),
    groupBoundary: boolean(row.group_boundary),
    bindingCount: Number(row.binding_count || 0),
    relationCount: Number(row.relation_count || 0),
    customerGrantCount: Number(row.customer_grant_count || 0),
    sourceStatus: String(row.source_status || "current"),
    arrivedAt: String(row.arrived_at || ""),
    updatedAt: String(row.updated_at || ""),
    latestMailAt: String(row.latest_mail_at || ""),
    paymentExposureStatus,
    paymentExposureSummary: String(row.payment_exposure_summary || ""),
    paymentExposureMethods,
    paymentExposureMethodDetails,
    paymentExposureCount,
    paymentExposureExposedCount,
    paymentExposureUnknownCount,
    paymentExposureCheckedAt: String(row.payment_exposure_checked_at || ""),
    trialStatus: String(row.latest_trial_status || "unknown"),
    promoEligible,
    promoCampaign: String(row.latest_promo_campaign || ""),
    promoCampaigns: promotionCampaignIds(row.latest_promo_evidence_json),
    promoSuspicious,
    promoSuspiciousOverride,
    historicalPromoCampaigns: promoSuspicious ? promotionCampaignIds(row.latest_eligible_promo_evidence_json) : [],
    trialCheckedAt: String(row.latest_trial_checked_at || ""),
    accessTokenFirstSeenAt,
    autoTrialDueAt,
    autoTrialStatus: String(row.auto_trial_status || "not_scheduled"),
    promotionCheckStatus: String(row.promotion_check_status || "not_scheduled"),
    promotionCheckStartedAt: String(row.promotion_check_started_at || ""),
    promotionCheckUpdatedAt: String(row.promotion_check_updated_at || ""),
    promotionCheckErrorClass: String(row.promotion_check_error_class || ""),
    promotionCheckErrorDetail: String(row.promotion_check_error_detail || ""),
    promotionCheckNextRetryAt: String(row.promotion_check_next_retry_at || ""),
    billingStartedAt: alive.billingStartedAt,
    aliveUntil: alive.aliveUntil,
    aliveMs: alive.aliveMs,
    aliveLabel: alive.aliveLabel,
    aliveActive: alive.aliveActive,
  };
}

const ACCOUNT_SELECT = `
SELECT a.*,
  cb.email_enc AS primary_email_enc,
  cb.provider AS provider,
  COALESCE(c.access_token_alive, 0) AS has_access_token,
  COALESCE(c.refresh_token_alive, 0) AS has_refresh_token,
  CASE WHEN COALESCE(c.access_token_enc, '')!='' THEN 1 ELSE 0 END AS has_stored_access_token,
  CASE WHEN COALESCE(c.refresh_token_enc, '')!='' THEN 1 ELSE 0 END AS has_stored_refresh_token,
  EXISTS(SELECT 1 FROM account_origins ao WHERE ao.account_id=a.id AND ao.is_auto=1) AS is_auto,
  s.id AS sale_id,
  COALESCE(s.status, 'none') AS sale_status,
  COALESCE(s.first_used_at, '') AS sale_first_used_at,
  (SELECT COUNT(*) FROM email_bindings b WHERE b.account_id=a.id) AS binding_count,
  (SELECT COUNT(*) FROM account_relations r WHERE r.from_account_id=a.id OR r.to_account_id=a.id) AS relation_count,
  (SELECT COUNT(*) FROM access_grants g WHERE g.account_id=a.id AND g.active=1 AND g.scope!='admin_only') AS customer_grant_count,
  COALESCE((SELECT MAX(m.received_at) FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id WHERE oc.account_id=a.id), '') AS latest_mail_at,
  (SELECT COUNT(*) FROM payment_exposure_checks p WHERE p.account_id=a.id AND p.checkout_type IN ('eligibility_api','local_extractor')) AS payment_exposure_count,
  (SELECT COUNT(*) FROM payment_exposure_checks p WHERE p.account_id=a.id AND p.checkout_type IN ('eligibility_api','local_extractor') AND p.exposed=1 AND p.status='complete') AS payment_exposure_exposed_count,
  (SELECT COUNT(*) FROM payment_exposure_checks p WHERE p.account_id=a.id AND p.checkout_type IN ('eligibility_api','local_extractor') AND p.status='unknown') AS payment_exposure_unknown_count,
  COALESCE((SELECT GROUP_CONCAT(p.target || ':' || p.status, ', ') FROM payment_exposure_checks p WHERE p.account_id=a.id AND p.checkout_type IN ('eligibility_api','local_extractor')), '') AS payment_exposure_summary,
  COALESCE((SELECT GROUP_CONCAT(DISTINCT jm.value) FROM payment_exposure_checks p, json_each(
    CASE WHEN json_valid(p.available_methods_json) THEN p.available_methods_json ELSE '[]' END
  ) jm WHERE p.account_id=a.id AND p.checkout_type IN ('eligibility_api','local_extractor') AND TRIM(jm.value)!=''), '') AS payment_exposure_methods,
  COALESCE((SELECT json_group_array(json(jm.value)) FROM payment_exposure_checks p, json_each(
    CASE WHEN json_valid(p.payment_methods_json) THEN p.payment_methods_json ELSE '[]' END
  ) jm WHERE p.account_id=a.id AND p.checkout_type IN ('eligibility_api','local_extractor') AND json_type(jm.value)='object'), '[]') AS payment_exposure_method_details_json,
  COALESCE((SELECT MAX(p.updated_at) FROM payment_exposure_checks p WHERE p.account_id=a.id AND p.checkout_type IN ('eligibility_api','local_extractor')), '') AS payment_exposure_checked_at,
  COALESCE((SELECT po.result_status FROM promotion_observations po WHERE po.account_id=a.id AND po.result_status IN ('eligible','ineligible') ORDER BY po.checked_at DESC, po.id DESC LIMIT 1), 'unknown') AS latest_trial_status,
  COALESCE((SELECT po.eligible FROM promotion_observations po WHERE po.account_id=a.id AND po.result_status IN ('eligible','ineligible') ORDER BY po.checked_at DESC, po.id DESC LIMIT 1), -1) AS latest_promo_eligible,
  COALESCE((SELECT po.campaign FROM promotion_observations po WHERE po.account_id=a.id AND po.result_status IN ('eligible','ineligible') ORDER BY po.checked_at DESC, po.id DESC LIMIT 1), '') AS latest_promo_campaign,
  COALESCE((SELECT po.evidence_json FROM promotion_observations po WHERE po.account_id=a.id AND po.result_status IN ('eligible','ineligible') ORDER BY po.checked_at DESC, po.id DESC LIMIT 1), '{}') AS latest_promo_evidence_json,
  EXISTS(SELECT 1 FROM promotion_observations po WHERE po.account_id=a.id AND po.eligible=1) AS ever_promo_eligible,
  EXISTS(SELECT 1 FROM settings ps WHERE ps.key='promotion_suspicious_override:' || a.id AND ps.value='1') AS promo_suspicious_override,
  COALESCE((SELECT po.evidence_json FROM promotion_observations po WHERE po.account_id=a.id AND po.eligible=1 ORDER BY po.checked_at DESC, po.id DESC LIMIT 1), '{}') AS latest_eligible_promo_evidence_json,
  COALESCE((SELECT po.checked_at FROM promotion_observations po WHERE po.account_id=a.id AND po.result_status IN ('eligible','ineligible') ORDER BY po.checked_at DESC, po.id DESC LIMIT 1), '') AS latest_trial_checked_at,
  COALESCE(c.access_token_first_seen_at, '') AS access_token_first_seen_at,
  COALESCE(e.billing_started_at, '') AS billing_started_at,
  COALESCE((SELECT pj.status FROM promotion_jobs pj WHERE pj.account_id=a.id AND pj.check_kind='auto' ORDER BY pj.created_at DESC, pj.id DESC LIMIT 1), '') AS auto_trial_status,
  COALESCE((SELECT pj.status FROM promotion_jobs pj WHERE pj.account_id=a.id ORDER BY pj.created_at DESC, pj.id DESC LIMIT 1), '') AS promotion_check_status,
  COALESCE((SELECT pj.started_at FROM promotion_jobs pj WHERE pj.account_id=a.id ORDER BY pj.created_at DESC, pj.id DESC LIMIT 1), '') AS promotion_check_started_at,
  COALESCE((SELECT pj.updated_at FROM promotion_jobs pj WHERE pj.account_id=a.id ORDER BY pj.created_at DESC, pj.id DESC LIMIT 1), '') AS promotion_check_updated_at,
  COALESCE((SELECT pj.error_class FROM promotion_jobs pj WHERE pj.account_id=a.id ORDER BY pj.created_at DESC, pj.id DESC LIMIT 1), '') AS promotion_check_error_class,
  COALESCE((SELECT pj.error_detail FROM promotion_jobs pj WHERE pj.account_id=a.id ORDER BY pj.created_at DESC, pj.id DESC LIMIT 1), '') AS promotion_check_error_detail,
  COALESCE((SELECT pj.next_retry_at FROM promotion_jobs pj WHERE pj.account_id=a.id ORDER BY pj.created_at DESC, pj.id DESC LIMIT 1), '') AS promotion_check_next_retry_at
FROM gpt_accounts a
LEFT JOIN email_bindings cb ON cb.id=(
  SELECT b2.id FROM email_bindings b2 WHERE b2.account_id=a.id ORDER BY b2.is_current DESC, b2.valid_from DESC, b2.created_at DESC LIMIT 1
)
LEFT JOIN credentials c ON c.account_id=a.id
LEFT JOIN account_business_evidence e ON e.account_id=a.id
LEFT JOIN sales s ON s.account_id=a.id`;

export interface AccountFilters {
  search?: string;
  range?: "day" | "week" | "two_weeks" | "all";
  status?: string;
  provider?: string;
  billingChannel?: string;
  sold?: string;
  plan?: string;
  credential?: string;
  sourceStatus?: string;
  unused?: string;
  redGroup?: string;
  markColor?: string;
  pending?: string;
  workbench?: string;
  deactivationWindow?: "today" | "3d" | "7d" | "30d";
  limit?: number;
  offset?: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1_000;

export function beijingDeactivationWindow(
  value: AccountFilters["deactivationWindow"],
  now = Date.now(),
): { start: string; end: string } {
  const days = value === "3d" ? 3 : value === "7d" ? 7 : value === "30d" ? 30 : 1;
  const beijingNow = new Date(now + BEIJING_OFFSET_MS);
  const todayStart = Date.UTC(beijingNow.getUTCFullYear(), beijingNow.getUTCMonth(), beijingNow.getUTCDate()) - BEIJING_OFFSET_MS;
  return {
    start: new Date(todayStart - (days - 1) * DAY_MS).toISOString(),
    end: new Date(todayStart + DAY_MS).toISOString(),
  };
}

export function listAccounts(filters: AccountFilters): { results: AccountSummary[]; total: number } {
  const where: string[] = ["a.deleted_at='' "];
  const params: any[] = [];
  const days = filters.range === "day" ? 1 : filters.range === "week" ? 7 : filters.range === "two_weeks" ? 14 : 0;
  if (days) {
    where.push("datetime(a.arrived_at) >= datetime('now', ?)");
    params.push(`-${days} days`);
  }
  if (filters.status) { where.push("a.lifecycle_status=?"); params.push(filters.status); }
  if (filters.provider) { where.push("cb.provider=?"); params.push(filters.provider); }
  if (filters.workbench === "icloud") where.push("cb.provider='icloud'");
  if (filters.workbench === "domain") where.push("cb.provider='domain'");
  if (filters.workbench === "auto") where.push("EXISTS(SELECT 1 FROM account_origins wao WHERE wao.account_id=a.id AND wao.is_auto=1)");
  if (filters.workbench === "missing_at") where.push("COALESCE(c.access_token_alive,0)=0");
  if (filters.workbench === "outlook_free") where.push("cb.provider='outlook' AND a.plan='free' AND a.sold=0");
  if (filters.workbench === "deactivations") {
    const window = beijingDeactivationWindow(filters.deactivationWindow || "today");
    where.push("a.deactivation_locked=1 AND a.deactivated_at>=? AND a.deactivated_at<?");
    params.push(window.start, window.end);
  }
  if (filters.billingChannel === "unknown") where.push("a.billing_channel=''");
  else if (filters.billingChannel) { where.push("a.billing_channel=?"); params.push(filters.billingChannel); }
  if (filters.sold === "true" || filters.sold === "false") { where.push("a.sold=?"); params.push(filters.sold === "true" ? 1 : 0); }
  if (filters.plan) { where.push("a.plan=?"); params.push(filters.plan); }
  if (filters.sourceStatus) { where.push("a.source_status=?"); params.push(filters.sourceStatus); }
  else where.push("a.source_status!='recovered'");
  if (filters.unused === "true") where.push("a.suspected_unused=1");
  if (filters.redGroup) {
    const group = listRedGroups().find((entry) => entry.boundaryAccountId === filters.redGroup);
    if (!group) where.push("1=0");
    else {
      where.push(`a.id IN (${group.accountIds.map(() => "?").join(",")})`);
      params.push(...group.accountIds);
    }
  }
  if (filters.markColor === "none") where.push("a.mark_color=''");
  else if (filters.markColor) { where.push("a.mark_color=?"); params.push(filters.markColor.toLowerCase()); }
  if (filters.pending === "true") where.push(INTERNAL_PENDING_SQL);
  else if (filters.pending === "exclude") where.push(`NOT ${INTERNAL_PENDING_SQL}`);
  if (filters.credential === "missing") where.push("COALESCE(c.access_token_alive,0)=0 AND COALESCE(c.refresh_token_alive,0)=0");
  if (filters.credential === "at") where.push("COALESCE(c.access_token_alive,0)=1");
  if (filters.credential === "rt") where.push("COALESCE(c.refresh_token_alive,0)=1");
  if (filters.search) {
    const search = normalizeEmail(filters.search);
    const email = splitEmail(search);
    if (email.localPart && email.domain) {
      where.push(`EXISTS(
        SELECT 1 FROM email_bindings sb WHERE sb.account_id=a.id AND sb.email_hash=?
      )`);
      params.push(emailHash(search));
    } else {
      const term = `%${search}%`;
      where.push(`(LOWER(a.note) LIKE ? OR LOWER(a.billing_channel) LIKE ? OR EXISTS(
        SELECT 1 FROM email_bindings sb WHERE sb.account_id=a.id AND (LOWER(sb.local_part) LIKE ? OR LOWER(sb.domain) LIKE ?)
      ))`);
      params.push(term, term, term, term);
    }
  }
  const clause = ` WHERE ${where.join(" AND ")}`;
  const total = Number((db.prepare(`SELECT COUNT(*) AS count FROM (${ACCOUNT_SELECT}${clause})`).get(...params) as any).count || 0);
  const limit = Math.max(1, Math.min(200, Number(filters.limit || 80)));
  const offset = Math.max(0, Number(filters.offset || 0));
  // arrived_at is persisted as canonical ISO-8601 text. Lexical ordering keeps
  // milliseconds, while SQLite datetime() truncates them and can shuffle
  // accounts created within the same second.
  const orderBy = filters.workbench === "deactivations"
    ? "a.deactivated_at DESC, a.arrived_at DESC, a.id DESC"
    : "a.arrived_at DESC, a.id DESC";
  const rows = db.prepare(`${ACCOUNT_SELECT}${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
  return { results: rows.map(accountRowToSummary), total };
}

export interface RedGroupSummary {
  boundaryAccountId: string;
  boundaryEmail: string;
  startedAt: string;
  endedAt: string;
  count: number;
  deactivatedCount: number;
  activeCount: number;
  accountIds: string[];
}

export function listRedGroups(): RedGroupSummary[] {
  const rows = db.prepare(`${ACCOUNT_SELECT} WHERE a.deleted_at='' AND a.source_status!='recovered' ORDER BY a.arrived_at DESC, a.id DESC`).all() as any[];
  const groups: RedGroupSummary[] = [];
  let current: RedGroupSummary | null = null;
  for (const row of rows) {
    if (boolean(row.group_boundary)) {
      if (current) groups.push(current);
      const summary = accountRowToSummary(row);
      current = {
        boundaryAccountId: summary.id,
        boundaryEmail: summary.primaryEmail,
        startedAt: summary.arrivedAt,
        endedAt: summary.arrivedAt,
        count: 0,
        deactivatedCount: 0,
        activeCount: 0,
        accountIds: [],
      };
    }
    if (!current) continue;
    current.accountIds.push(String(row.id));
    current.count += 1;
    current.endedAt = String(row.arrived_at || current.endedAt);
    if (boolean(row.deactivation_locked)) current.deactivatedCount += 1;
    else if (String(row.lifecycle_status) === "active") current.activeCount += 1;
  }
  if (current) groups.push(current);
  return groups;
}

export function listPendingReviews(): Array<Record<string, unknown>> {
  return (db.prepare(`SELECT * FROM pending_reviews WHERE status='pending' ORDER BY datetime(created_at) DESC`).all() as any[]).map((row) => ({
    id: String(row.id),
    reviewType: String(row.review_type),
    accountId: String(row.account_id || ""),
    candidateEmail: decryptSecret(String(row.candidate_email_enc || "")) || (row.review_type === "mail_ownership_ambiguous"
      ? decryptSecret(String((db.prepare("SELECT recipient_enc FROM mail_messages WHERE id=?")
        .get(JSON.parse(String(row.evidence_json || "{}")).messageId || "") as any)?.recipient_enc || "")) : ""),
    reason: String(row.reason || ""),
    evidence: JSON.parse(String(row.evidence_json || "{}")),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  }));
}

export function resolvePendingReview(reviewId: string, action: string, options: { applyTransition?: boolean } = {}): Record<string, unknown> {
  const review = db.prepare("SELECT * FROM pending_reviews WHERE id=? AND status='pending'").get(reviewId) as any;
  if (!review) throw new Error("待审查记录不存在或已经处理");
  const allowed = new Set(["dismiss", "keep_separate", "confirm_rebind"]);
  if (!allowed.has(action)) throw new Error("不支持的审查操作");
  const now = new Date().toISOString();
  if (action === "confirm_rebind" && options.applyTransition !== false) {
    const accountId = String(review.account_id || "");
    const email = decryptSecret(String(review.candidate_email_enc || ""));
    if (!accountId || !email) throw new Error("该审查记录缺少账号或候选邮箱，不能确认改绑");
    rebindAccountTransition(accountId, email, {
      source: "v2-admin-review",
      associationMethod: "admin_review_confirmed_rebind",
      evidence: { reviewId, previousReason: String(review.reason || "") },
    });
  }
  db.prepare("UPDATE pending_reviews SET status=?, updated_at=? WHERE id=?").run(action === "dismiss" ? "dismissed" : "resolved", now, reviewId);
  if (review.account_id) db.prepare(`INSERT INTO lifecycle_events(id, account_id, event_type, occurred_at, source, payload_json, created_at)
    VALUES(?, ?, 'association_review_resolved', ?, 'v2-admin-review', ?, ?)`).run(
    crypto.randomUUID(), review.account_id, now, JSON.stringify({ reviewId, action }), now,
  );
  return { id: reviewId, status: action === "dismiss" ? "dismissed" : "resolved", action };
}

export function migrationReport(): Record<string, unknown> {
  const v1Runs = db.prepare(`SELECT id, started_at, finished_at, source_count, account_count, binding_count, relation_count,
    recovered_count, status, detail_json FROM shadow_sync_runs ORDER BY datetime(started_at) DESC LIMIT 20`).all() as any[];
  const sub2Runs = db.prepare(`SELECT id, started_at, finished_at, total_count, active_openai_count, matched_count, created_count,
    rebind_count, conflict_count, skipped_count, status, detail_json FROM sub2api_sync_runs ORDER BY datetime(started_at) DESC LIMIT 20`).all() as any[];
  const settings = Object.fromEntries((db.prepare("SELECT key, value FROM settings ORDER BY key").all() as any[]).map((row) => [row.key, row.value]));
  const nativeOutbox = db.prepare("SELECT COUNT(*) count, COALESCE(MAX(sequence),0) sequence FROM change_outbox").get() as any;
  let apiArtifact = "";
  try { apiArtifact = String(JSON.parse(fs.readFileSync(path.join(config.projectRoot, "dist/release-manifest.json"), "utf8")).artifactSha256 || ""); } catch { apiArtifact = ""; }
  const worker = db.prepare("SELECT * FROM worker_heartbeats WHERE worker_name='native-sync-worker'").get() as any;
  const workerHeartbeatMs = Date.parse(String(worker?.heartbeat_at || ""));
  const audit = {
    activeWithoutCurrentBinding: Number((db.prepare(`SELECT COUNT(*) count FROM gpt_accounts a
      WHERE a.deleted_at='' AND a.lifecycle_status='active'
      AND NOT EXISTS(SELECT 1 FROM email_bindings b WHERE b.account_id=a.id AND b.is_current=1)`).get() as any).count || 0),
    selfReferentialAccountRelations: Number((db.prepare("SELECT COUNT(*) count FROM account_relations WHERE from_account_id=to_account_id").get() as any).count || 0),
    revokedOrDeletedWithActiveCustomerGrant: Number((db.prepare(`SELECT COUNT(DISTINCT a.id) AS count FROM gpt_accounts a
      JOIN access_grants g ON g.account_id=a.id WHERE g.active=1 AND g.scope!='admin_only'
        AND (g.revoked_at!='' OR g.revoke_reason!='' OR a.deleted_at!='')`).get() as any).count || 0),
    accountsWithMultipleCurrentBindings: Number((db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT account_id FROM email_bindings WHERE is_current=1 GROUP BY account_id HAVING COUNT(*)>1)`).get() as any).count || 0),
    currentGrantsOnHistoricalBindings: Number((db.prepare(`SELECT COUNT(*) AS count FROM access_grants g JOIN email_bindings b ON b.id=g.binding_id
      WHERE g.active=1 AND g.scope='current' AND b.is_current=0`).get() as any).count || 0),
    accountsWithMultipleActiveCustomerGrants: Number((db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT account_id FROM access_grants WHERE active=1 AND scope='current' GROUP BY account_id HAVING COUNT(*)>1)`).get() as any).count || 0),
    duplicateEmailAcrossAccounts: Number((db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT email_hash FROM email_bindings GROUP BY email_hash HAVING COUNT(DISTINCT account_id)>1)`).get() as any).count || 0),
    duplicateCurrentEmailAcrossAccounts: Number((db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT email_hash FROM email_bindings WHERE is_current=1 GROUP BY email_hash HAVING COUNT(DISTINCT account_id)>1)`).get() as any).count || 0),
    messagesClaimedByMultipleAccounts: Number((db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT message_id FROM mail_ownership_claims GROUP BY message_id HAVING COUNT(DISTINCT account_id)>1)`).get() as any).count || 0),
    ambiguousCustomerVisibleMessages: Number((db.prepare(`SELECT COUNT(*) count FROM (
      SELECT message_id FROM mail_ownership_claims WHERE visible_to_customer=1
      GROUP BY message_id HAVING COUNT(DISTINCT account_id)>1)`).get() as any).count || 0),
    credentialPointerAccountMismatch: Number((db.prepare(`SELECT COUNT(*) count FROM account_current_credentials cc
      LEFT JOIN credential_versions cv ON cv.id=cc.credential_version_id
      WHERE cv.id IS NULL OR cv.account_id!=cc.account_id`).get() as any).count || 0),
    credentialMaterialWithoutCurrentPointer: Number((db.prepare(`SELECT COUNT(*) count FROM credentials c
      WHERE (c.access_token_enc!='' OR c.refresh_token_enc!='' OR c.id_token_enc!='' OR c.session_token_enc!='')
      AND NOT EXISTS(SELECT 1 FROM account_current_credentials cc WHERE cc.account_id=c.account_id)`).get() as any).count || 0),
    promotionRetryJobsWithBlankError: Number((db.prepare(`SELECT COUNT(*) count FROM promotion_jobs
      WHERE status IN ('retry_wait','failed') AND (TRIM(error_class)='' OR TRIM(error_detail)='')`).get() as any).count || 0),
    promotionRetryableJobs: Number((db.prepare("SELECT COUNT(*) count FROM promotion_jobs WHERE status IN ('queued','retry_wait')").get() as any).count || 0),
    promotionRunningJobs: Number((db.prepare("SELECT COUNT(*) count FROM promotion_jobs WHERE status='running'").get() as any).count || 0),
    pendingSyncConflicts: Number((db.prepare("SELECT COUNT(*) count FROM sync_conflicts WHERE status='pending'").get() as any).count || 0),
    quarantinedAccounts: Number((db.prepare("SELECT COUNT(*) AS count FROM gpt_accounts WHERE lifecycle_status='quarantined' OR identity_status='conflict'").get() as any).count || 0),
    pendingReviews: Number((db.prepare("SELECT COUNT(*) AS count FROM pending_reviews WHERE status='pending'").get() as any).count || 0),
    nativeOutboxEvents: Number(nativeOutbox?.count || 0),
    nativeOutboxSequence: Number(nativeOutbox?.sequence || 0),
    workerHeartbeatAt: String(worker?.heartbeat_at || ""),
    workerHeartbeatAgeSeconds: Number.isFinite(workerHeartbeatMs) ? Math.max(0, Math.floor((Date.now() - workerHeartbeatMs) / 1_000)) : -1,
    apiArtifactSha256: apiArtifact,
    workerArtifactSha256: String(worker?.artifact_sha256 || ""),
    apiWorkerArtifactMatch: Boolean(apiArtifact && String(worker?.artifact_sha256 || "") === apiArtifact),
  };
  return {
    integrity: String((db.prepare("PRAGMA integrity_check").get() as any)?.integrity_check || "unknown"),
    foreignKeyViolations: (db.prepare("PRAGMA foreign_key_check").all() as any[]).length,
    settings,
    audit,
    v1Runs: v1Runs.map((row) => ({ ...row, detail_json: JSON.parse(String(row.detail_json || "{}")) })),
    sub2Runs: sub2Runs.map((row) => ({ ...row, detail_json: JSON.parse(String(row.detail_json || "{}")) })),
  };
}

function jsonStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizedUniqueStrings(values: unknown[], limit = 64): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = String(value ?? "").trim().toLowerCase();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizePaymentExposurePromoMode(value: unknown): PaymentExposurePromoMode {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "one_month" || mode === "1month" || mode === "1_month" || mode === "promo"
    ? "one_month" : mode === "none" || mode === "no_promo" ? "none" : "unknown";
}

function mergePaymentExposurePromoMode(existing: PaymentExposurePromoMode, incoming: PaymentExposurePromoMode): PaymentExposurePromoMode {
  if (existing === "one_month" || incoming === "one_month") return "one_month";
  if (existing === "none" || incoming === "none") return "none";
  return "unknown";
}

function paymentMethodSources(method: Partial<PaymentExposureCheck["paymentMethods"][number]>): string[] {
  const sources = Array.isArray(method.sources) ? method.sources : [];
  return normalizedUniqueStrings([
    ...sources,
    ...String(method.source || "").split(/[,|>→]+/),
  ], 16);
}

function normalizePaymentMethod(method: Partial<PaymentExposureCheck["paymentMethods"][number]>): PaymentExposureCheck["paymentMethods"][number] {
  const sources = paymentMethodSources(method);
  return {
    id: String(method.id || "").trim().slice(0, 128),
    type: String(method.type || "").trim().toLowerCase().slice(0, 64),
    provider: String(method.provider || "").trim().toLowerCase().slice(0, 64),
    name: String(method.name || "").trim().slice(0, 128),
    code: String(method.code || "").trim().slice(0, 128),
    displayName: String(method.displayName || "").trim().slice(0, 128),
    source: sources[0] || "",
    sources,
    promoMode: normalizePaymentExposurePromoMode(method.promoMode),
  };
}

function paymentMethodStableKey(method: PaymentExposureCheck["paymentMethods"][number]): string {
  const identity = method.type || method.code.toLowerCase() || method.name.toLowerCase()
    || method.displayName.toLowerCase() || method.id.toLowerCase() || method.provider;
  return identity ? `method:${identity}:promo:${normalizePaymentExposurePromoMode(method.promoMode)}` : "";
}

export function mergePaymentExposureObservation(
  existing: Pick<PaymentExposureCheck, "availableMethods" | "matchedMethods" | "paymentMethods">,
  incoming: Pick<PaymentExposureCheck, "availableMethods" | "matchedMethods" | "paymentMethods">,
): Pick<PaymentExposureCheck, "availableMethods" | "matchedMethods" | "paymentMethods"> {
  const paymentMethods: PaymentExposureCheck["paymentMethods"] = [];
  const indexByKey = new Map<string, number>();
  for (const raw of [...(existing.paymentMethods || []), ...(incoming.paymentMethods || [])]) {
    const method = normalizePaymentMethod(raw);
    const key = paymentMethodStableKey(method);
    if (!key) continue;
    let index = indexByKey.get(key);
    if (index === undefined && method.promoMode !== "unknown") {
      const identity = method.type || method.code.toLowerCase() || method.name.toLowerCase()
        || method.displayName.toLowerCase() || method.id.toLowerCase() || method.provider;
      index = indexByKey.get(`method:${identity}:promo:unknown`);
      if (index !== undefined) indexByKey.set(key, index);
    }
    if (index === undefined && method.promoMode === "unknown") {
      const identity = method.type || method.code.toLowerCase() || method.name.toLowerCase()
        || method.displayName.toLowerCase() || method.id.toLowerCase() || method.provider;
      index = paymentMethods.findIndex((candidate) => {
        const candidateIdentity = candidate.type || candidate.code.toLowerCase() || candidate.name.toLowerCase()
          || candidate.displayName.toLowerCase() || candidate.id.toLowerCase() || candidate.provider;
        return candidateIdentity === identity;
      });
      if (index < 0) index = undefined;
    }
    if (index === undefined) {
      indexByKey.set(key, paymentMethods.length);
      paymentMethods.push(method);
      continue;
    }
    const previous = paymentMethods[index];
    const sources = normalizedUniqueStrings([...paymentMethodSources(previous), ...paymentMethodSources(method)], 16);
    paymentMethods[index] = {
      id: previous.id || method.id,
      type: previous.type || method.type,
      provider: previous.provider || method.provider,
      name: previous.name || method.name,
      code: previous.code || method.code,
      displayName: previous.displayName || method.displayName,
      source: sources[0] || "",
      sources,
      promoMode: method.promoMode !== "unknown" ? method.promoMode : previous.promoMode,
    };
  }
  return {
    availableMethods: normalizedUniqueStrings([...(existing.availableMethods || []), ...(incoming.availableMethods || [])]),
    matchedMethods: normalizedUniqueStrings([...(existing.matchedMethods || []), ...(incoming.matchedMethods || [])]),
    paymentMethods: paymentMethods.slice(0, 128),
  };
}

function paymentMethodSummaries(availableMethods: string[], methods: PaymentExposureCheck["paymentMethods"]): PaymentExposureMethodSummary[] {
  const merged = mergePaymentExposureObservation(
    { availableMethods: [], matchedMethods: [], paymentMethods: [] },
    {
      availableMethods,
      matchedMethods: [],
      paymentMethods: [
        ...methods,
        ...availableMethods.map((method) => ({
          id: "", type: method, provider: "", name: method, code: "", displayName: method, source: "", sources: [],
        })),
      ],
    },
  );
  return merged.paymentMethods.map((method) => ({
    method: method.type || method.code || method.name || method.displayName || method.id,
    sources: paymentMethodSources(method),
    promoMode: method.promoMode,
  })).filter((item) => item.method);
}

function jsonMethodArray(value: unknown): PaymentExposureCheck["paymentMethods"] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === "object").map((item: any) => normalizePaymentMethod({
      id: item.id, type: item.type, provider: item.provider, name: item.name, code: item.code,
      displayName: item.displayName ?? item.display_name, source: item.source, sources: item.sources,
      promoMode: item.promoMode ?? item.promo_mode,
    })).slice(0, 128);
  } catch {
    return [];
  }
}

function paymentExposureRow(row: any): PaymentExposureCheck {
  const promoValue = Number(row.promo_eligible);
  return {
    id: String(row.id),
    target: String(row.target || ""),
    ipCountry: String(row.ip_country || ""),
    billingCountry: String(row.billing_country || ""),
    billingCurrency: String(row.billing_currency || ""),
    expectedMethod: String(row.expected_method || ""),
    availableMethods: jsonStringArray(row.available_methods_json),
    matchedMethods: jsonStringArray(row.matched_methods_json),
    paymentMethods: jsonMethodArray(row.payment_methods_json),
    trialStatus: String(row.trial_status || "unknown"),
    exposed: boolean(row.exposed),
    status: String(row.status || "unknown"),
    checkoutType: String(row.checkout_type || ""),
    detail: String(row.detail || ""),
    promoEligible: promoValue < 0 ? null : promoValue === 1,
    promoCampaign: String(row.promo_campaign || ""),
    promoMode: normalizePaymentExposurePromoMode(row.promo_mode),
    observedAt: String(row.observed_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

export function listPaymentExposureChecks(accountId: string): PaymentExposureCheck[] {
  return (db.prepare(`SELECT * FROM payment_exposure_checks WHERE account_id=?
    ORDER BY datetime(updated_at) DESC, target ASC`).all(accountId) as any[]).map(paymentExposureRow);
}

export interface PaymentEligibilityObservationInput {
  target: string;
  ipCountry: string;
  billingCountry: string;
  billingCurrency: string;
  eligible: boolean | null;
  reason: string;
  availableMethods?: string[];
  matchedMethods?: string[];
  paymentMethods?: PaymentExposureCheck["paymentMethods"];
  observedAt?: string;
  source?: "eligibility_api" | "local_extractor";
  promoMode?: PaymentExposurePromoMode;
  promoEligible?: boolean | null;
  promoCampaign?: string;
  trialStatus?: string;
  checkoutType?: string;
  replaceMethods?: boolean;
}

export function savePaymentEligibilityObservation(accountId: string, input: PaymentEligibilityObservationInput): PaymentExposureCheck {
  const account = db.prepare("SELECT 1 FROM gpt_accounts WHERE id=? AND deleted_at=''").get(accountId);
  if (!account) throw new Error("支付资格检测账号不存在");
  const target = canonicalExposureTarget(String(input.target || ""));
  if (!["ideal", "gcash", "gopay", "upi", "kakao", "naver", "momo"].includes(target)) throw new Error("不支持的支付资格检查目标");
  const ipCountry = String(input.ipCountry || "").trim().toUpperCase();
  const billingCountry = String(input.billingCountry || "").trim().toUpperCase();
  const billingCurrency = String(input.billingCurrency || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(ipCountry) || !/^[A-Z]{2}$/.test(billingCountry) || !/^[A-Z0-9]{3,12}$/.test(billingCurrency)) {
    throw new Error("支付资格检查地区配置无效");
  }
  const observedAt = Number.isFinite(Date.parse(String(input.observedAt || "")))
    ? new Date(String(input.observedAt)).toISOString() : new Date().toISOString();
  const now = new Date().toISOString();
  const eligible = input.eligible;
  const complete = typeof eligible === "boolean";
  const source = input.source === "local_extractor" ? "local_extractor" : "eligibility_api";
  const requestedPromoMode = normalizePaymentExposurePromoMode(input.promoMode);
  const promoEligibleValue = input.promoEligible === true ? 1 : input.promoEligible === false ? 0 : -1;
  const promoCampaign = String(input.promoCampaign || "").slice(0, 128);
  const trialStatus = ["observed", "eligible", "ineligible", "unknown"].includes(String(input.trialStatus || "").toLowerCase())
    ? String(input.trialStatus || "").toLowerCase() : "unknown";
  const checkoutType = String(input.checkoutType || source).slice(0, 32);
  const availableMethods = Array.isArray(input.availableMethods) && input.availableMethods.length
    ? [...new Set(input.availableMethods.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 64)
    : eligible === true ? [target] : [];
  const matchedMethods = Array.isArray(input.matchedMethods)
    ? [...new Set(input.matchedMethods.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 64)
    : eligible === true ? [target] : [];
  const existing = db.prepare(`SELECT id, available_methods_json, matched_methods_json, payment_methods_json,
      promo_mode, promo_eligible, promo_campaign FROM payment_exposure_checks
    WHERE account_id=? AND target=? AND ip_country=? AND billing_country=? AND billing_currency=?`)
    .get(accountId, target, ipCountry, billingCountry, billingCurrency) as any;
  const existingPromoMode = normalizePaymentExposurePromoMode(existing?.promo_mode);
  const promoMode = mergePaymentExposurePromoMode(existingPromoMode, requestedPromoMode);
  const preservePromoEvidence = existingPromoMode === "one_month" && requestedPromoMode !== "one_month";
  const paymentMethods = Array.isArray(input.paymentMethods) && input.paymentMethods.length
    ? input.paymentMethods.map((method) => ({ ...method,
      // Keep per-mode snapshots: a 1 month observation overlays the no-promo
      // view but does not erase it.
      promoMode: method.promoMode && method.promoMode !== "unknown" ? method.promoMode
        : input.replaceMethods ? requestedPromoMode : promoMode,
    }))
    : eligible === true
    ? [{ id: "", type: target, provider: "", name: target, code: "", displayName: target, source, promoMode }]
    : [];
  const previousMethods = jsonMethodArray(existing?.payment_methods_json);
  const baselineMethods = input.replaceMethods
    ? previousMethods.filter((method) => normalizePaymentExposurePromoMode(method.promoMode) !== requestedPromoMode)
    : previousMethods;
  const merged = mergePaymentExposureObservation(
    input.replaceMethods ? {
      availableMethods: jsonStringArray(existing?.available_methods_json),
      matchedMethods: jsonStringArray(existing?.matched_methods_json),
      paymentMethods: baselineMethods,
    } : {
      availableMethods: jsonStringArray(existing?.available_methods_json),
      matchedMethods: jsonStringArray(existing?.matched_methods_json),
      paymentMethods: jsonMethodArray(existing?.payment_methods_json),
    },
    { availableMethods, matchedMethods, paymentMethods },
  );
  const id = String(existing?.id || crypto.randomUUID());
  db.prepare(`INSERT INTO payment_exposure_checks(
    id, account_id, target, ip_country, billing_country, billing_currency, expected_method,
    available_methods_json, matched_methods_json, payment_methods_json, trial_status, exposed, status, checkout_type, detail,
    promo_eligible, promo_campaign, promo_mode, observed_at, source, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, target, ip_country, billing_country, billing_currency) DO UPDATE SET
      expected_method=excluded.expected_method, available_methods_json=excluded.available_methods_json,
      matched_methods_json=excluded.matched_methods_json, payment_methods_json=excluded.payment_methods_json,
      trial_status=excluded.trial_status, exposed=excluded.exposed, status=excluded.status, checkout_type=excluded.checkout_type,
      detail=excluded.detail, promo_eligible=excluded.promo_eligible, promo_campaign=excluded.promo_campaign,
      promo_mode=excluded.promo_mode, observed_at=excluded.observed_at,
      source=excluded.source, updated_at=excluded.updated_at`).run(
    id, accountId, target, ipCountry, billingCountry, billingCurrency, target,
    JSON.stringify(merged.availableMethods), JSON.stringify(merged.matchedMethods), JSON.stringify(merged.paymentMethods),
    trialStatus, eligible === true ? 1 : 0, complete ? "complete" : "unknown", checkoutType, String(input.reason || "").slice(0, 500),
    preservePromoEvidence ? Number(existing?.promo_eligible ?? -1) : promoEligibleValue,
    preservePromoEvidence ? String(existing?.promo_campaign || "") : promoCampaign,
    promoMode, observedAt, source, now, now,
  );
  const row = db.prepare("SELECT * FROM payment_exposure_checks WHERE id=?").get(id) as any;
  return paymentExposureRow(row);
}

function latestPromotion(accountId: string): Record<string, unknown> | null {
  const row = db.prepare(`SELECT o.*, j.region, j.check_kind FROM promotion_observations o
    JOIN promotion_jobs j ON j.id=o.job_id WHERE o.account_id=? AND o.result_status IN ('eligible','ineligible')
    ORDER BY o.checked_at DESC LIMIT 1`).get(accountId) as any;
  if (!row) return null;
  let evidence: Record<string, unknown> = {};
  try { evidence = JSON.parse(String(row.evidence_json || "{}")); } catch { evidence = {}; }
  return { eligible: row.eligible === null ? null : Boolean(row.eligible), status: row.result_status,
    campaign: row.campaign, region: row.region, checkKind: row.check_kind, checkedAt: row.checked_at,
    expiresAt: row.expires_at, evidence };
}

export function getAccountDetail(id: string): AccountDetail | null {
  const row = db.prepare(`${ACCOUNT_SELECT} WHERE a.id=? AND a.deleted_at=''`).get(id) as any;
  if (!row) return null;
  const summary = accountRowToSummary(row);
  const bindings = (db.prepare(`SELECT * FROM email_bindings WHERE account_id=? ORDER BY datetime(valid_from) DESC, created_at DESC`).all(id) as any[])
    .map((binding) => ({
      id: binding.id,
      email: decryptSecret(binding.email_enc),
      provider: binding.provider,
      validFrom: binding.valid_from,
      validTo: binding.valid_to,
      isCurrent: boolean(binding.is_current),
      associationMethod: binding.association_method,
      legacyMappingId: binding.legacy_mapping_id,
      receiveDisabledAt: String(binding.receive_disabled_at || ""),
    }));
  const relations = (db.prepare(`SELECT * FROM account_relations WHERE from_account_id=? OR to_account_id=? ORDER BY datetime(changed_at) DESC`).all(id, id) as any[])
    .map((relation) => ({
      id: relation.id,
      relationType: relation.relation_type,
      fromAccountId: relation.from_account_id,
      toAccountId: relation.to_account_id,
      changedAt: relation.changed_at,
      associationMethod: relation.association_method,
      evidence: JSON.parse(relation.evidence_json || "{}"),
    }));
  const timeline = (db.prepare(`SELECT id, event_type, occurred_at, payload_json FROM lifecycle_events WHERE account_id=? ORDER BY datetime(occurred_at) DESC`).all(id) as any[])
    .map((event) => ({ id: event.id, eventType: event.event_type, occurredAt: event.occurred_at, payload: JSON.parse(event.payload_json || "{}") }));
  const mailboxConnections = (db.prepare(`SELECT mc.* FROM mailbox_connections mc
    JOIN email_bindings b ON b.id=mc.binding_id WHERE b.account_id=? ORDER BY mc.updated_at DESC`).all(id) as any[]).map((item) => ({
    id: String(item.id), bindingId: String(item.binding_id || ""), provider: String(item.provider || ""),
    status: String(item.status || ""), externalGroupId: String(item.external_group_id || ""),
    metadata: JSON.parse(String(item.metadata_json || "{}")),
  }));
  const routingRules = (db.prepare(`SELECT r.* FROM mail_routing_rules r
    JOIN email_bindings b ON b.id=r.binding_id WHERE b.account_id=? ORDER BY r.priority DESC, r.created_at ASC`).all(id) as any[]).map((item) => ({
    id: String(item.id), bindingId: String(item.binding_id), senderPattern: String(item.sender_pattern || ""),
    recipientPattern: String(item.recipient_pattern || ""), validFrom: String(item.valid_from || ""),
    validTo: String(item.valid_to || ""), priority: Number(item.priority || 0),
  }));
  return { ...summary, note: row.note, paymentLink: row.payment_link, hidePromotion: boolean(row.hide_promotion), bindings, relations, timeline,
    paymentExposureChecks: listPaymentExposureChecks(id), credentialVersions: credentialHistory(id) as any,
    promotion: latestPromotion(id), mailboxConnections, routingRules };
}

export function overview(): Record<string, unknown> {
  const counts = db.prepare(`SELECT
    COUNT(*) AS accounts,
    SUM(CASE WHEN lifecycle_status='active' THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN deactivation_locked=1 THEN 1 ELSE 0 END) AS deactivated,
    SUM(CASE WHEN lifecycle_status='retired' THEN 1 ELSE 0 END) AS retired,
    SUM(CASE WHEN lifecycle_status='quarantined' OR identity_status='conflict' THEN 1 ELSE 0 END) AS quarantined,
    SUM(CASE WHEN sold=1 THEN 1 ELSE 0 END) AS sold,
    SUM(CASE WHEN domain_mailbox=1 THEN 1 ELSE 0 END) AS domains,
    SUM(CASE WHEN suspected_unused=1 THEN 1 ELSE 0 END) AS unused
    FROM gpt_accounts WHERE deleted_at='' AND source_status!='recovered'`).get() as any;
  const recovered = Number((db.prepare(`SELECT COUNT(*) AS count FROM gpt_accounts
    WHERE deleted_at='' AND source_status='recovered'`).get() as any)?.count || 0);
  const windowSnapshot = Date.now();
  const today = beijingDeactivationWindow("today", windowSnapshot);
  const threeDays = beijingDeactivationWindow("3d", windowSnapshot);
  const sevenDays = beijingDeactivationWindow("7d", windowSnapshot);
  const thirtyDays = beijingDeactivationWindow("30d", windowSnapshot);
  const deactivationWindows = db.prepare(`SELECT
    SUM(CASE WHEN deactivated_at>=? AND deactivated_at<? THEN 1 ELSE 0 END) AS today,
    SUM(CASE WHEN deactivated_at>=? AND deactivated_at<? THEN 1 ELSE 0 END) AS three_days,
    SUM(CASE WHEN deactivated_at>=? AND deactivated_at<? THEN 1 ELSE 0 END) AS seven_days,
    SUM(CASE WHEN deactivated_at>=? AND deactivated_at<? THEN 1 ELSE 0 END) AS thirty_days
    FROM gpt_accounts WHERE deleted_at='' AND source_status!='recovered' AND deactivation_locked=1`).get(
      today.start, today.end,
      threeDays.start, threeDays.end,
      sevenDays.start, sevenDays.end,
      thirtyDays.start, thirtyDays.end,
    ) as any;
  const credentialCounts = db.prepare(`${ACCOUNT_SELECT} WHERE a.deleted_at='' AND a.source_status!='recovered'`).all() as any[];
  const internalPending = credentialCounts.filter((row) => credentialState(row).internalPending).length;
  const visibleCredentialRows = credentialCounts.filter((row) => !credentialState(row).internalPending);
  const actionableMissingAt = credentialCounts.filter((row) => !boolean(row.has_access_token) && !credentialState(row).internalPending).length;
  const source = db.prepare("SELECT value FROM settings WHERE key='v1_source_count'").get() as any;
  const sync = db.prepare("SELECT * FROM shadow_sync_runs ORDER BY started_at DESC LIMIT 1").get() as any;
  const sub2Sync = db.prepare("SELECT * FROM sub2api_sync_runs ORDER BY started_at DESC LIMIT 1").get() as any;
  return {
    ...counts, recovered,
    visibleAccounts: Math.max(0, Number(counts.accounts || 0) - internalPending),
    visibleActive: visibleCredentialRows.filter((row) => String(row.lifecycle_status) === "active").length,
    visibleDomains: visibleCredentialRows.filter((row) => boolean(row.domain_mailbox)).length,
    visibleIcloud: visibleCredentialRows.filter((row) => String(row.provider) === "icloud").length,
    visibleAuto: visibleCredentialRows.filter((row) => boolean(row.is_auto)).length,
    visibleOutlookFree: visibleCredentialRows.filter((row) => String(row.provider) === "outlook" && String(row.plan) === "free" && !boolean(row.sold)).length,
    visibleUnused: visibleCredentialRows.filter((row) => boolean(row.suspected_unused)).length,
    deactivatedToday: Number(deactivationWindows.today || 0),
    deactivatedThreeDays: Number(deactivationWindows.three_days || 0),
    deactivatedSevenDays: Number(deactivationWindows.seven_days || 0),
    deactivatedThirtyDays: Number(deactivationWindows.thirty_days || 0),
    internalPending,
    actionableMissingAt,
    v1SourceRecords: Number(source?.value || 0), readOnly: config.readOnly,
    nativeReadOnly: config.readOnly,
    commandWriter: "v2",
    accountAuthority: "v2",
    independent: true,
    latestSync: sync || null, latestSub2Sync: sub2Sync || null,
  };
}

export interface GrantRecord {
  id: string;
  accountId: string;
  bindingId: string;
  scope: string;
  visibleFrom: string;
  visibleTo: string;
  hidePromotion: boolean;
  label: string;
}

function grantRow(row: any): GrantRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    bindingId: row.binding_id,
    scope: row.scope,
    visibleFrom: row.visible_from,
    visibleTo: row.visible_to,
    hidePromotion: boolean(row.hide_promotion),
    label: "Mailbox",
  };
}

export function grantByPublicToken(token: string): GrantRecord | null {
  const row = db.prepare(`SELECT g.*, a.hide_promotion, a.lifecycle_status FROM access_grants g
    JOIN gpt_accounts a ON a.id=g.account_id WHERE g.public_token_hash=? AND g.active=1 AND g.scope!='admin_only'
      AND g.revoked_at='' AND g.revoke_reason='' AND a.deleted_at=''`).get(digestToken(token)) as any;
  if (!row) return null;
  markGrantUsed(String(row.id));
  return grantRow(row);
}

export function grantById(id: string): GrantRecord | null {
  const row = db.prepare(`SELECT g.*, a.hide_promotion, a.lifecycle_status FROM access_grants g
    JOIN gpt_accounts a ON a.id=g.account_id WHERE g.id=? AND g.active=1 AND g.scope!='admin_only'
      AND g.revoked_at='' AND g.revoke_reason='' AND a.deleted_at=''`).get(id) as any;
  return row ? grantRow(row) : null;
}

export function authenticateCustomer(email: string, password: string): GrantRecord | null {
  const rows = db.prepare(`SELECT g.*, a.hide_promotion, a.lifecycle_status FROM access_grants g
    JOIN gpt_accounts a ON a.id=g.account_id WHERE g.login_identifier_hash=? AND g.active=1 AND g.scope!='admin_only'
      AND g.revoked_at='' AND g.revoke_reason='' AND a.deleted_at=''`).all(emailHash(normalizeEmail(email))) as any[];
  const matched = rows.filter((row) => verifyPassword(password, String(row.password_hash || "")));
  if (matched.length !== 1) return null;
  markGrantUsed(String(matched[0].id));
  return grantRow(matched[0]);
}

function visibleMailWhere(grant: GrantRecord): { clause: string; params: unknown[] } {
  const dateClauses: string[] = [];
  const params: unknown[] = [];
  if (grant.visibleFrom) { dateClauses.push("julianday(m.received_at) >= julianday(?)"); params.push(grant.visibleFrom); }
  if (grant.visibleTo) { dateClauses.push("julianday(m.received_at) < julianday(?)"); params.push(grant.visibleTo); }
  const binding = db.prepare("SELECT receive_disabled_at FROM email_bindings WHERE id=?").get(grant.bindingId) as any;
  const receiveDisabledAt = String(binding?.receive_disabled_at || "");
  if (receiveDisabledAt) {
    dateClauses.push("julianday(m.received_at) < julianday(?)");
    params.push(receiveDisabledAt);
  }
  const dateClause = dateClauses.length ? ` AND ${dateClauses.join(" AND ")}` : "";
  // V1 could index one iCloud delivery under both the base mailbox and a
  // concrete +alias mapping. Preserve the exact legacy mapping selected by
  // this customer grant. A native/non-legacy claim from another account still
  // wins and keeps the message hidden until reviewed.
  const trustedLegacyClaim = `(oc.claim_type='legacy_mapping_index'
    AND EXISTS (
      SELECT 1 FROM email_bindings legacy_binding
      WHERE legacy_binding.id=oc.binding_id AND legacy_binding.legacy_mapping_id<>''
    )
    AND NOT EXISTS (
      SELECT 1 FROM lifecycle_events rejected_claim
      WHERE rejected_claim.account_id=oc.account_id AND rejected_claim.binding_id=oc.binding_id
        AND rejected_claim.event_type='mail_claim_rejected'
        AND json_extract(rejected_claim.payload_json,'$.messageId')=m.id
    ))`;
  const grantBatch = mailboxBindingBatchSql("grant_binding");
  const claimBatch = mailboxBindingBatchSql("claim_binding");
  const conflictingBatch = mailboxBindingBatchSql("conflicting_binding");
  return {
    clause: `EXISTS (
      SELECT 1 FROM email_bindings grant_binding JOIN email_bindings claim_binding ON claim_binding.id=oc.binding_id
      WHERE grant_binding.id=? AND ${grantBatch}=${claimBatch}
    ) AND (oc.visible_to_customer=1 OR ${trustedLegacyClaim})
    AND NOT EXISTS (
      SELECT 1 FROM mail_ownership_claims conflicting
      JOIN email_bindings conflicting_binding ON conflicting_binding.id=conflicting.binding_id
      JOIN email_bindings claim_binding ON claim_binding.id=oc.binding_id
      WHERE conflicting.message_id=m.id AND conflicting.account_id<>oc.account_id
        AND conflicting.visible_to_customer=1 AND ${conflictingBatch}<>${claimBatch}
    )${dateClause}`,
    params: [grant.bindingId, ...params],
  };
}

export function listCustomerMails(grant: GrantRecord, offset: number, limit: number): { results: any[]; count: number } {
  const visible = visibleMailWhere(grant);
  const promotionClause = grant.hidePromotion ? " AND m.category!='promotion'" : "";
  const from = `FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id WHERE ${visible.clause}${promotionClause}`;
  const count = Number((db.prepare(`SELECT COUNT(DISTINCT m.id) AS count ${from}`).get(...visible.params) as any).count || 0);
  const rows = db.prepare(`SELECT DISTINCT m.id, m.sender, m.subject, m.received_at, m.folder, m.category ${from}
    ORDER BY datetime(m.received_at) DESC LIMIT ? OFFSET ?`).all(...visible.params, limit, offset) as any[];
  return {
    count,
    results: rows.map((row) => ({ id: row.id, from: row.sender, subject: row.subject, created_at: row.received_at, folder: row.folder, category: row.category, needsDetail: true })),
  };
}

export function customerMailDetail(grant: GrantRecord, messageId: string): any | null {
  const visible = visibleMailWhere(grant);
  const promotionClause = grant.hidePromotion ? " AND m.category!='promotion'" : "";
  const row = db.prepare(`SELECT DISTINCT m.*, ob.email_enc AS owner_binding_email_enc
    FROM mail_messages m
    JOIN mail_ownership_claims oc ON oc.message_id=m.id
    JOIN email_bindings ob ON ob.id=oc.binding_id
    WHERE m.id=? AND ${visible.clause}${promotionClause}`).get(messageId, ...visible.params) as any;
  if (!row) return null;
  const metadata = (() => { try { return JSON.parse(String(row.metadata_json || "{}")); } catch { return {}; } })();
  const upstreamMailboxEmail = decryptSecret(String(row.owner_binding_email_enc || ""));
  delete row.recipient_enc;
  delete row.metadata_json;
  delete row.owner_binding_email_enc;
  delete metadata.address;
  delete metadata.to;
  delete metadata.recipient;
  return { ...row, metadata, _upstreamMailboxEmail: upstreamMailboxEmail };
}

export function revealCredentials(accountId: string): Record<string, string> | null {
  const row = db.prepare(`SELECT cv.* FROM account_current_credentials cc
    JOIN credential_versions cv ON cv.id=cc.credential_version_id WHERE cc.account_id=?`).get(accountId) as any
    || db.prepare("SELECT * FROM credentials WHERE account_id=?").get(accountId) as any;
  const password = db.prepare("SELECT password_enc,totp_secret_enc FROM account_passwords WHERE account_id=?").get(accountId) as any;
  if (!row && !password) return null;
  return {
    accessToken: decryptSecret(String(row?.access_token_enc || "")),
    refreshToken: decryptSecret(String(row?.refresh_token_enc || "")),
    idToken: decryptSecret(String(row?.id_token_enc || "")),
    sessionToken: decryptSecret(String(row?.session_token_enc || "")),
    openaiPassword: decryptSecret(String(password?.password_enc || row?.openai_password_enc || "")),
    totpSecret: decryptSecret(String(password?.totp_secret_enc || "")),
  };
}

export function saveAccountCredentials(accountId: string, input: Record<string, unknown>): Record<string, unknown> {
  const current = revealCredentials(accountId) || {
    accessToken: "", refreshToken: "", idToken: "", sessionToken: "", openaiPassword: "", totpSecret: "",
  };
  const value = (key: keyof typeof current): string => Object.prototype.hasOwnProperty.call(input, key)
    ? String(input[key] || "").trim()
    : String(current[key] || "").trim();
  const accessToken = value("accessToken");
  const refreshToken = value("refreshToken");
  const idToken = value("idToken");
  const sessionToken = value("sessionToken");
  const openaiPassword = value("openaiPassword");
  const totpSecret = value("totpSecret");
  if (!accessToken && !refreshToken && !idToken && !sessionToken) {
    throw new Error("请至少填写 AT、RT、ID Token 或 Session Token 中的一项");
  }
  const subject = parseJwtSubject(accessToken || idToken);
  const binding = db.prepare(`SELECT id FROM email_bindings WHERE account_id=? AND is_current=1
    ORDER BY valid_from DESC, created_at DESC LIMIT 1`).get(accountId) as any;
  const observed = observeCredentialVersion({
    accountId,
    bindingId: String(binding?.id || "") || null,
    accessToken,
    refreshToken,
    idToken,
    sessionToken,
    openaiPassword,
    subjectHash: subject ? sha256(subject) : "",
    source: "v2-admin-manual",
    observedAt: new Date().toISOString(),
    validityStatus: accessToken ? "alive" : "unknown",
    evidence: { adminManual: true },
  });
  if (observed.conflict) throw new Error("新凭证与当前 GPT 身份冲突，已保留待审查但没有替换当前凭证");
  if (Object.prototype.hasOwnProperty.call(input, "totpSecret")) {
    const existing = db.prepare("SELECT password_enc FROM account_passwords WHERE account_id=?").get(accountId) as any;
    db.prepare(`INSERT INTO account_passwords(account_id,password_enc,totp_secret_enc,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET totp_secret_enc=excluded.totp_secret_enc,updated_at=excluded.updated_at`).run(
      accountId, String(existing?.password_enc || ""), encryptSecret(totpSecret), new Date().toISOString(),
    );
  }
  return {
    ok: true,
    credentialVersionId: observed.credentialVersionId,
    current: observed.current,
    changed: observed.changed,
    hasAccessToken: Boolean(accessToken),
    hasRefreshToken: Boolean(refreshToken),
    hasIdToken: Boolean(idToken),
    hasSessionToken: Boolean(sessionToken),
  };
}

export function primaryEmailForAccount(accountId: string): string {
  const row = db.prepare(`SELECT b.email_enc FROM email_bindings b
    WHERE b.account_id=? ORDER BY b.is_current DESC, datetime(b.valid_from) DESC, datetime(b.created_at) DESC LIMIT 1`).get(accountId) as any;
  return row ? normalizeEmail(decryptSecret(String(row.email_enc || ""))) : "";
}

export interface PaymentExposureCredentials {
  credentialVersionId: string;
  accessToken: string;
  sessionToken: string;
  email: string;
  accessTokenFingerprint: string;
  accessTokenFirstSeenAt: string;
}

// This is an internal handoff to the server-side AutoMyAI bridge. The route
// handler must never serialize this object into an admin response.
export function getPaymentExposureCredentials(accountId: string): PaymentExposureCredentials | null {
  const row = db.prepare(`SELECT cv.id credential_version_id, cv.access_token_enc, cv.session_token_enc,
      cv.token_fingerprint access_token_fingerprint, cv.first_seen_at access_token_first_seen_at, b.email_enc
    FROM gpt_accounts a
    JOIN account_current_credentials cc ON cc.account_id=a.id
    JOIN credential_versions cv ON cv.id=cc.credential_version_id
    LEFT JOIN email_bindings b ON b.id=(
      SELECT b2.id FROM email_bindings b2 WHERE b2.account_id=a.id
      ORDER BY b2.is_current DESC, b2.valid_from DESC, b2.created_at DESC LIMIT 1
    )
    WHERE a.id=? AND a.deleted_at='' AND cv.validity_status='alive' AND cv.access_token_enc!=''`).get(accountId) as any;
  if (!row) return null;
  return {
    credentialVersionId: String(row.credential_version_id || ""),
    accessToken: decryptSecret(String(row.access_token_enc || "")),
    sessionToken: decryptSecret(String(row.session_token_enc || "")),
    email: normalizeEmail(decryptSecret(String(row.email_enc || ""))),
    accessTokenFingerprint: String(row.access_token_fingerprint || ""),
    accessTokenFirstSeenAt: String(row.access_token_first_seen_at || ""),
  };
}

export interface PaymentExposureJobRecord {
  jobId: string;
  remoteJobId: string;
  accountId: string;
  routeKey: string;
  target: string;
  ipCountry: string;
  billingCountry: string;
  billingCurrency: string;
  jobKind: string;
  accessTokenFingerprint: string;
  scheduledAt: string;
  promoMode: PaymentExposurePromoMode;
  status: string;
  lastError: string;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
  updatedAt: string;
}

function paymentExposureJobRow(row: any): PaymentExposureJobRecord {
  return {
    jobId: String(row.job_id || ""), remoteJobId: String(row.remote_job_id || row.job_id || ""), accountId: String(row.account_id || ""), routeKey: String(row.route_key || ""),
    target: String(row.target || ""), ipCountry: String(row.ip_country || ""), billingCountry: String(row.billing_country || ""),
    billingCurrency: String(row.billing_currency || ""), jobKind: String(row.job_kind || "manual"),
    accessTokenFingerprint: String(row.access_token_fingerprint || ""), scheduledAt: String(row.scheduled_at || ""),
    promoMode: normalizePaymentExposurePromoMode(row.promo_mode),
    status: String(row.status || "unknown"), lastError: String(row.last_error || ""),
    startedAt: String(row.started_at || ""), finishedAt: String(row.finished_at || ""), createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

export type PaymentExposureJobInput = Omit<PaymentExposureJobRecord, "updatedAt" | "remoteJobId" | "jobKind" | "accessTokenFingerprint" | "scheduledAt" | "promoMode">
  & Partial<Pick<PaymentExposureJobRecord, "remoteJobId" | "jobKind" | "accessTokenFingerprint" | "scheduledAt" | "promoMode">>;

export function createPaymentExposureJob(input: PaymentExposureJobInput): PaymentExposureJobRecord {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO payment_exposure_jobs(
    job_id, remote_job_id, account_id, route_key, target, ip_country, billing_country, billing_currency,
    job_kind, access_token_fingerprint, scheduled_at, promo_mode, status, last_error, started_at, finished_at, created_at, updated_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(
    input.jobId, input.remoteJobId || "", input.accountId, input.routeKey, input.target, input.ipCountry, input.billingCountry, input.billingCurrency,
    input.jobKind || "manual", input.accessTokenFingerprint || "", input.scheduledAt || "", input.promoMode || "none",
    input.status, input.lastError, input.startedAt, input.finishedAt, input.createdAt, now,
  );
  return getPaymentExposureJob(input.accountId, input.jobId)!;
}

export function reservePaymentExposureJob(input: PaymentExposureJobInput): PaymentExposureJobRecord {
  return createPaymentExposureJob({ ...input, status: input.status || "dispatching" });
}

export function finalizePaymentExposureJobReservation(
  reservationId: string,
  remoteJobId: string,
  patch: Pick<PaymentExposureJobRecord, "status"> & Partial<Pick<PaymentExposureJobRecord, "startedAt" | "finishedAt" | "lastError">>,
): PaymentExposureJobRecord | null {
  const existing = db.prepare("SELECT * FROM payment_exposure_jobs WHERE job_id=?").get(reservationId) as any;
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(`UPDATE payment_exposure_jobs SET remote_job_id=?, status=?, last_error=?, started_at=?, finished_at=?, updated_at=? WHERE job_id=?`).run(
    remoteJobId, String(patch.status || "queued"), patch.lastError === undefined ? existing.last_error : String(patch.lastError || "").slice(0, 500),
    patch.startedAt === undefined ? existing.started_at : String(patch.startedAt || "").slice(0, 64),
    patch.finishedAt === undefined ? existing.finished_at : String(patch.finishedAt || "").slice(0, 64), now, reservationId,
  );
  return paymentExposureJobRow(db.prepare("SELECT * FROM payment_exposure_jobs WHERE job_id=?").get(reservationId));
}

export interface AutomaticTrialCandidate {
  accountId: string;
  accessTokenFingerprint: string;
  firstSeenAt: string;
  dueAt: string;
  routeKey: string;
}

export function listAutomaticTrialCandidates(limit = config.autoTrialBatchSize, now = new Date()): AutomaticTrialCandidate[] {
  if (!config.autoTrialEnabled) return [];
  const dueBefore = new Date(now.getTime() - config.autoTrialDelayMs).toISOString();
  const retryBefore = new Date(now.getTime() - config.autoTrialRetryMs).toISOString();
  const rows = db.prepare(`SELECT a.id AS account_id, c.access_token_fingerprint, c.access_token_first_seen_at
    FROM gpt_accounts a JOIN credentials c ON c.account_id=a.id
    WHERE a.deleted_at='' AND a.lifecycle_status='active' AND a.deactivation_locked=0
      AND c.access_token_alive=1 AND c.access_token_fingerprint!='' AND c.access_token_first_seen_at!=''
      AND c.access_token_first_seen_at<=?
      AND NOT EXISTS (
        SELECT 1 FROM payment_exposure_jobs j
        WHERE j.account_id=a.id AND j.access_token_fingerprint=c.access_token_fingerprint
          AND j.status IN ('queued', 'running')
      )
      AND NOT EXISTS (
        SELECT 1 FROM payment_exposure_jobs j
        WHERE j.account_id=a.id AND j.job_kind='auto_trial' AND j.access_token_fingerprint=c.access_token_fingerprint
          AND j.status='completed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM payment_exposure_jobs j
        WHERE j.account_id=a.id AND j.job_kind='auto_trial' AND j.access_token_fingerprint=c.access_token_fingerprint
          AND j.status='dispatching' AND j.updated_at>?
      )
      AND NOT EXISTS (
        SELECT 1 FROM payment_exposure_jobs j
        WHERE j.account_id=a.id AND j.job_kind='auto_trial' AND j.access_token_fingerprint=c.access_token_fingerprint
          AND j.status='failed' AND j.updated_at>?
      )
    ORDER BY c.access_token_first_seen_at ASC, a.id ASC LIMIT ?`).all(dueBefore, retryBefore, retryBefore, Math.max(1, Math.min(100, Number(limit || 1)))) as any[];
  return rows.map((row) => {
    const firstSeenAt = String(row.access_token_first_seen_at || "");
    const firstSeenMs = Date.parse(firstSeenAt);
    return {
      accountId: String(row.account_id || ""), accessTokenFingerprint: String(row.access_token_fingerprint || ""),
      firstSeenAt, dueAt: Number.isFinite(firstSeenMs) ? new Date(firstSeenMs + config.autoTrialDelayMs).toISOString() : "",
      routeKey: config.autoTrialRouteKey,
    };
  });
}

export function listPaymentExposureJobs(statuses: string[] = ["queued", "running"], jobKind = ""): PaymentExposureJobRecord[] {
  const allowed = statuses.map((value) => String(value || "").trim()).filter(Boolean);
  if (!allowed.length) return [];
  const placeholders = allowed.map(() => "?").join(",");
  const params: any[] = [...allowed];
  const kind = String(jobKind || "").trim();
  const kindClause = kind ? " AND job_kind=?" : "";
  if (kind) params.push(kind);
  return (db.prepare(`SELECT * FROM payment_exposure_jobs WHERE status IN (${placeholders})${kindClause} ORDER BY updated_at ASC LIMIT 100`).all(...params) as any[])
    .map(paymentExposureJobRow);
}

export function getPaymentExposureJob(accountId: string, jobId: string): PaymentExposureJobRecord | null {
  const row = db.prepare("SELECT * FROM payment_exposure_jobs WHERE account_id=? AND job_id=?").get(accountId, jobId) as any;
  return row ? paymentExposureJobRow(row) : null;
}

export function updatePaymentExposureJob(jobId: string, patch: Partial<Pick<PaymentExposureJobRecord, "status" | "lastError" | "startedAt" | "finishedAt">>): PaymentExposureJobRecord | null {
  const existing = db.prepare("SELECT * FROM payment_exposure_jobs WHERE job_id=?").get(jobId) as any;
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(`UPDATE payment_exposure_jobs SET status=?, last_error=?, started_at=?, finished_at=?, updated_at=? WHERE job_id=?`).run(
    patch.status === undefined ? existing.status : String(patch.status || "unknown").slice(0, 40),
    patch.lastError === undefined ? existing.last_error : String(patch.lastError || "").slice(0, 500),
    patch.startedAt === undefined ? existing.started_at : String(patch.startedAt || "").slice(0, 64),
    patch.finishedAt === undefined ? existing.finished_at : String(patch.finishedAt || "").slice(0, 64),
    now, jobId,
  );
  const row = db.prepare("SELECT * FROM payment_exposure_jobs WHERE job_id=?").get(jobId) as any;
  return row ? paymentExposureJobRow(row) : null;
}

export function updateAccount(accountId: string, patch: Record<string, unknown>): AccountDetail | null {
  const existing = db.prepare("SELECT * FROM gpt_accounts WHERE id=?").get(accountId) as any;
  if (!existing) return null;
  if (patch.sold !== undefined) {
    if (patch.sold) throw new Error("不能直接标记已售；请为当前绑定生成客户授权，系统会原子地建立出售记录");
    cancelUnusedSale(accountId);
  }
  const allowedColors = new Set(["", "yellow", "orange", "green", "blue", "purple", "gray", "red"]);
  const note = patch.note === undefined ? existing.note : String(patch.note || "").slice(0, 4_000);
  const payment = patch.paymentLink === undefined ? existing.payment_link : String(patch.paymentLink || "").slice(0, 2_000);
  const colorInput = patch.markColor === undefined ? existing.mark_color : String(patch.markColor || "").toLowerCase();
  const color = allowedColors.has(colorInput) ? colorInput : existing.mark_color;
  db.prepare(`UPDATE gpt_accounts SET note=?, payment_link=?, hide_promotion=?, mark_color=?, group_boundary=?, updated_at=? WHERE id=?`).run(
    note, payment,
    patch.hidePromotion === undefined ? existing.hide_promotion : (patch.hidePromotion ? 1 : 0),
    color,
    patch.groupBoundary === undefined ? existing.group_boundary : (patch.groupBoundary ? 1 : 0),
    new Date().toISOString(), accountId,
  );
  return getAccountDetail(accountId);
}

export function setPromotionSuspicion(accountId: string, suspicious: boolean): AccountDetail | null {
  const exists = db.prepare("SELECT 1 FROM gpt_accounts WHERE id=? AND deleted_at=''").get(accountId);
  if (!exists) return null;
  const now = new Date().toISOString();
  const key = `promotion_suspicious_override:${accountId}`;
  db.transaction(() => {
    if (suspicious) {
      db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, '1', ?)
        ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at`).run(key, now);
    } else {
      db.prepare("DELETE FROM settings WHERE key=?").run(key);
    }
    db.prepare(`INSERT INTO lifecycle_events(id, account_id, event_type, occurred_at, source, payload_json, created_at)
      VALUES(?, ?, 'promotion_suspicion_changed', ?, 'v2-admin', ?, ?)`).run(
      crypto.randomUUID(), accountId, now, JSON.stringify({ suspicious }), now,
    );
  })();
  return getAccountDetail(accountId);
}

export function createRebind(accountId: string, newEmailInput: string): AccountDetail {
  rebindAccountTransition(accountId, newEmailInput);
  return getAccountDetail(accountId)!;
}

export function deactivateAccount(accountId: string, reason = "admin_manual"): AccountDetail {
  freezeAccountTransition(accountId, reason);
  return getAccountDetail(accountId)!;
}

export function recycleAccount(accountId: string, newEmailInput: string, planInput = "free"): { previous: AccountDetail; replacement: AccountDetail } {
  const { replacementId } = recycleAccountTransition(accountId, newEmailInput, planInput);
  return { previous: getAccountDetail(accountId)!, replacement: getAccountDetail(replacementId)! };
}

function nextRecycleAlias(email: string): string {
  const parts = splitEmail(email);
  const local = parts.localPart.split("+")[0];
  if (!local || parts.domain !== "icloud.com") return "";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let tag = "oai";
    for (let index = 0; index < 6; index += 1) tag += alphabet[crypto.randomInt(alphabet.length)];
    const candidate = `${local}+${tag}@${parts.domain}`;
    if (!db.prepare("SELECT 1 FROM email_bindings WHERE email_hash=?").get(emailHash(candidate))) return candidate;
  }
  return "";
}

export function recycleAccountByMode(accountId: string, modeInput: string): { mode: RecycleMode; previous: AccountDetail; replacement: AccountDetail } {
  if (!["deactivated", "untagged_free", "invalid_at", "alias_rotate"].includes(modeInput)) throw new Error("回收模式无效");
  const mode = modeInput as RecycleMode;
  return db.transaction(() => {
    // Re-read eligibility after obtaining the write lock. A stale admin panel
    // must not recycle an account that was sold, tagged, rebound or reclaimed.
    const eligibility = assertRecycleEligibility(accountId, mode);
    const generation = eligibility.generation;
    const row = db.prepare("SELECT email_enc FROM email_bindings WHERE account_id=? AND is_current=1").get(accountId) as any;
    const email = decryptSecret(String(row.email_enc || ""));
    const alias = nextRecycleAlias(email);
    if (!alias) throw new Error("未能生成未使用的 iCloud +oai 别名");
    const result = recycleAccount(accountId, alias, "free");
    const now = new Date().toISOString();
    db.prepare("UPDATE gpt_accounts SET note=?,source_status='v2',updated_at=? WHERE id=?")
      .run("automyai OpenAI signup pool pending", now, result.replacement.id);
    db.prepare(`INSERT OR IGNORE INTO account_origins(account_id,source_type,source_id,is_auto,first_seen_at,metadata_json)
      VALUES(?,'recycle',?,1,?,?)`).run(result.replacement.id, `${accountId}:${mode}`, now, JSON.stringify({ mode, generation: mode === "alias_rotate" ? generation : generation + 1 }));
    db.prepare(`INSERT INTO account_business_evidence(account_id,recycle_generation,updated_at) VALUES(?,?,?)`)
      .run(result.replacement.id, mode === "alias_rotate" ? generation : generation + 1, now);
    db.prepare(`UPDATE account_relations SET evidence_json=? WHERE relation_type='mailbox_recycle'
      AND from_account_id=? AND to_account_id=?`).run(JSON.stringify({ mode, previousEmail: emailHash(email), nextEmail: emailHash(alias), customerAccessInherited: false, credentialsInherited: false,
        eligibility: recycleEligibilityAudit(eligibility, mode) }), accountId, result.replacement.id);
    return { mode, previous: getAccountDetail(accountId)!, replacement: getAccountDetail(result.replacement.id)! };
  }).immediate();
}

export interface CustomerGrantResult {
  grantId: string;
  publicToken: string;
  publicUrl: string;
  loginIdentifier: string;
  password: string;
  scope: string;
}

export interface CurrentCustomerExport {
  available: boolean;
  accountId: string;
  bindingId: string;
  currentEmail: string;
  loginIdentifier: string;
  publicUrl: string;
  text: string;
  reason: string;
}

export interface CurrentCustomerExportCredentials {
  openaiPassword?: string;
  totpSecret?: string;
}

const TWO_FACTOR_URL = "https://2fa.vip";

export function formatCurrentCustomerExportText(currentEmail: string, loginIdentifier: string, publicUrl: string,
  credentials: CurrentCustomerExportCredentials = {}): string {
  const email = String(currentEmail || "");
  const login = String(loginIdentifier || "");
  const url = String(publicUrl || "");
  const password = String(credentials.openaiPassword || "");
  const totp = String(credentials.totpSecret || "");
  if (password) {
    const fields = [`账号：${login || email}`, `密码：${password}`];
    if (totp) fields.push(`2FA：${totp}`, `2FA地址：${TWO_FACTOR_URL}`);
    return fields.join(" | ");
  }
  const fields = [`ai账号：${email}`];
  if (login && login.toLowerCase() !== email.toLowerCase()) fields.push(`登录标识：${login}`);
  fields.push(`邮箱验证码：${url}`);
  return fields.join(" | ");
}

export function getCurrentCustomerExport(accountId: string): CurrentCustomerExport | null {
  const row = db.prepare(`SELECT b.id AS binding_id, b.email_enc, b.legacy_mapping_id,
      g.id AS grant_id, g.public_token_enc, g.legacy_public_token, g.login_identifier_enc, g.password_plain_enc
    FROM email_bindings b
    LEFT JOIN access_grants g ON g.binding_id=b.id AND g.account_id=b.account_id
      AND g.active=1 AND g.scope='current'
    WHERE b.account_id=? AND b.is_current=1
    ORDER BY datetime(g.created_at) DESC LIMIT 1`).get(accountId) as any;
  if (!row) return null;
  const currentEmail = decryptSecret(String(row.email_enc || ""));
  const credentials = revealCredentials(accountId) || {};
  const base = {
    accountId,
    bindingId: String(row.binding_id || ""),
    currentEmail,
    loginIdentifier: decryptSecret(String(row.login_identifier_enc || "")),
    publicUrl: "",
    text: "",
  };
  if (!row.grant_id) return { ...base, available: false, reason: "当前邮箱尚未生成客户接码授权" };
  let publicToken = decryptSecret(String(row.public_token_enc || ""));
  if (!publicToken && boolean(row.legacy_public_token)) publicToken = String(row.legacy_mapping_id || "");
  if (!publicToken) return { ...base, available: false, reason: "当前授权属于旧版本，无法再次复制，请重置当前客户授权" };
  if (!decryptSecret(String(row.password_plain_enc || ""))) {
    return { ...base, available: false, reason: "当前授权缺少可复制的接码密码，请重置当前客户授权" };
  }
  const publicUrl = `${config.publicOrigin}/#m=${encodeURIComponent(publicToken)}`;
  return {
    ...base,
    available: true,
    publicUrl,
    text: formatCurrentCustomerExportText(currentEmail, base.loginIdentifier, publicUrl, credentials),
    reason: "",
  };
}

// Admin copy is a provisioning action, not a sale decision. If this mailbox
// has no usable entrance yet, create one without changing `sold` or creating a
// sale. The token remains bound to this exact account + mailbox stage.
export function provisionCurrentCustomerExport(accountId: string): CurrentCustomerExport | null {
  const current = getCurrentCustomerExport(accountId);
  if (!current || current.available || config.readOnly) return current;
  issueCustomerGrant(accountId, current.bindingId, {
    loginIdentifier: current.currentEmail,
    trackSale: false,
  });
  return getCurrentCustomerExport(accountId);
}

export function createCustomerGrant(accountId: string, bindingId: string, input: Record<string, unknown> = {}): CustomerGrantResult {
  const secret = issueCustomerGrant(accountId, bindingId, input);
  return { ...secret, publicUrl: `${config.publicOrigin}/#m=${encodeURIComponent(secret.publicToken)}` };
}

export function revokeCustomerGrant(accountId: string, grantId: string): boolean {
  return revokeGrantTransition(accountId, grantId);
}

export function listAccountGrants(accountId: string): Array<Record<string, unknown>> {
  return (db.prepare(`SELECT id, binding_id, sale_id, login_identifier_enc, scope, visible_from, visible_to, active,
      first_used_at, last_used_at, revoked_at, revoke_reason, created_at, updated_at
    FROM access_grants WHERE account_id=? AND scope!='admin_only' ORDER BY datetime(created_at) DESC`).all(accountId) as any[]).map((row) => ({
    id: String(row.id),
    bindingId: String(row.binding_id),
    loginIdentifier: decryptSecret(String(row.login_identifier_enc || "")),
    scope: String(row.scope),
    visibleFrom: String(row.visible_from || ""),
    visibleTo: String(row.visible_to || ""),
    active: boolean(row.active),
    saleId: String(row.sale_id || ""),
    firstUsedAt: String(row.first_used_at || ""),
    lastUsedAt: String(row.last_used_at || ""),
    revokedAt: String(row.revoked_at || ""),
    revokeReason: String(row.revoke_reason || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  }));
}

export function applyBulkAction(accountIds: string[], action: string, value?: unknown): { updated: number } {
  const ids = [...new Set(accountIds.map(String).filter(Boolean))].slice(0, 500);
  if (!ids.length) throw new Error("没有选择账号");
  if (action === "deactivate") {
    for (const id of ids) deactivateAccount(id, "admin_bulk");
    return { updated: ids.length };
  }
  if (action === "delete") {
    let updated = 0;
    for (const id of ids) {
      try {
        deleteAccountTransition(id, "admin_bulk_delete");
        updated += 1;
      } catch (error) {
        // Bulk actions are idempotent from the UI perspective.  A row that
        // disappeared between list and click is simply not counted.
        if (!/不存在|已经删除/.test(String(error instanceof Error ? error.message : error))) throw error;
      }
    }
    return { updated };
  }
  if (action === "sold") {
    if (value) throw new Error("批量标记已售已停用；出售必须逐个生成客户授权");
    let updated = 0;
    for (const id of ids) if (cancelUnusedSale(id)) updated += 1;
    return { updated };
  }
  if (action === "markColor") {
    const color = String(value || "").trim().toLowerCase();
    if (!(new Set(["", "yellow", "orange", "green", "blue", "purple", "gray", "red"]).has(color))) {
      throw new Error("不支持的标记颜色");
    }
    const placeholders = ids.map(() => "?").join(",");
    const result = db.prepare(`UPDATE gpt_accounts SET mark_color=?, updated_at=? WHERE id IN (${placeholders}) AND deleted_at=''`)
      .run(color, new Date().toISOString(), ...ids);
    return { updated: result.changes };
  }
  if (action === "receiveDisabled") {
    const placeholders = ids.map(() => "?").join(",");
    const now = new Date().toISOString();
    const result = value
      ? db.prepare(`UPDATE email_bindings SET receive_disabled_at=CASE WHEN receive_disabled_at='' THEN ? ELSE receive_disabled_at END
          WHERE is_current=1 AND account_id IN (${placeholders})`).run(now, ...ids)
      : db.prepare(`UPDATE email_bindings SET receive_disabled_at=''
          WHERE is_current=1 AND account_id IN (${placeholders})`).run(...ids);
    return { updated: result.changes };
  }
  const allowed = new Map<string, string>([["groupBoundary", "group_boundary"], ["hidePromotion", "hide_promotion"]]);
  const column = allowed.get(action);
  if (!column) throw new Error("不支持的批量操作");
  const placeholders = ids.map(() => "?").join(",");
  const result = db.prepare(`UPDATE gpt_accounts SET ${column}=?, updated_at=? WHERE id IN (${placeholders}) AND deleted_at=''`)
    .run(value ? 1 : 0, new Date().toISOString(), ...ids);
  return { updated: result.changes };
}

export interface ImportAccountInput {
  email?: string;
  lifecycleStatus?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  sessionToken?: string;
  openaiPassword?: string;
  totpSecret?: string;
  openaiSubject?: string;
  plan?: string;
  note?: string;
  mfaEnabled?: boolean;
  authMethods?: string[];
  arrivedAt?: string;
  rebindPreviousEmail?: string;
  address?: string;
  outlookManagerEmail?: string;
  outlookManagerGroupId?: string;
}

export interface PaymentExposureIngestInput {
  email?: unknown;
  openaiSubjectHash?: unknown;
  openai_subject_hash?: unknown;
  target?: unknown;
  ipCountry?: unknown;
  ip_country?: unknown;
  billingCountry?: unknown;
  billing_country?: unknown;
  billingCurrency?: unknown;
  billing_currency?: unknown;
  expectedMethod?: unknown;
  expected_method?: unknown;
  availableMethods?: unknown;
  available_methods?: unknown;
  matchedMethods?: unknown;
  matched_methods?: unknown;
  paymentMethods?: unknown;
  payment_methods?: unknown;
  trialStatus?: unknown;
  trial_status?: unknown;
  exposed?: unknown;
  status?: unknown;
  checkoutType?: unknown;
  checkout_type?: unknown;
  detail?: unknown;
  promoEligible?: unknown;
  promo_eligible?: unknown;
  promoCampaign?: unknown;
  promo_campaign?: unknown;
  promoMode?: unknown;
  promo_mode?: unknown;
  observedAt?: unknown;
  observed_at?: unknown;
  source?: unknown;
}

function inputText(input: PaymentExposureIngestInput, camel: keyof PaymentExposureIngestInput, snake: keyof PaymentExposureIngestInput = camel): string {
  return String(input[camel] ?? input[snake] ?? "").trim();
}

function inputStringArray(input: PaymentExposureIngestInput, camel: keyof PaymentExposureIngestInput, snake: keyof PaymentExposureIngestInput = camel): string[] {
  const value = input[camel] ?? input[snake];
  return Array.isArray(value) ? [...new Set(value.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 64) : [];
}

function inputMethodArray(input: PaymentExposureIngestInput): PaymentExposureCheck["paymentMethods"] {
  const value = input.paymentMethods ?? input.payment_methods;
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object").map((item: any) => normalizePaymentMethod({
    id: item.id, type: item.type, provider: item.provider, name: item.name, code: item.code,
    displayName: item.displayName ?? item.display_name, source: item.source, sources: item.sources,
  })).filter((item) => item.id || item.type || item.name || item.code).slice(0, 128);
}

function canonicalExposureTarget(value: string): string {
  switch (value.toLowerCase()) {
    case "pp":
    case "paypal":
    case "paypal_ba": return "paypal";
    case "ideal_nl": return "ideal";
    case "ph_gcash":
    case "gcash_link": return "gcash";
    case "in_upi": return "upi";
    case "id_gopay": return "gopay";
    case "kakao_pay":
    case "kr_kakao": return "kakao";
    case "naver_pay":
    case "kr_naver": return "naver";
    case "momo_wallet":
    case "vn_momo": return "momo";
    default: return value.toLowerCase();
  }
}

function inputBoolean(value: unknown): boolean {
  return value === true || value === 1 || String(value || "").toLowerCase() === "true";
}

function matchPaymentExposureAccount(input: PaymentExposureIngestInput): string {
  const subjectHash = inputText(input, "openaiSubjectHash", "openai_subject_hash");
  const email = normalizeEmail(inputText(input, "email"));
  const subjectMatches = subjectHash ? (db.prepare(`SELECT account_id FROM credentials WHERE openai_subject_hash=? AND openai_subject_hash!=''
    UNION SELECT account_id FROM openai_identity_observations WHERE subject_hash=? AND status!='conflict'`).all(subjectHash, subjectHash) as any[])
    .map((row) => String(row.account_id)).filter(Boolean) : [];
  const distinctSubjects = [...new Set(subjectMatches)];
  if (distinctSubjects.length > 1) throw new Error("OpenAI subject_hash 匹配多个账号，拒绝自动写入");
  const emailMatches = email ? (db.prepare("SELECT DISTINCT account_id FROM email_bindings WHERE email_hash=?").all(emailHash(email)) as any[])
    .map((row) => String(row.account_id)).filter(Boolean) : [];
  const distinctEmails = [...new Set(emailMatches)];
  if (distinctEmails.length > 1) throw new Error("邮箱匹配多个账号，拒绝自动写入");
  if (distinctSubjects.length && distinctEmails.length && distinctSubjects[0] !== distinctEmails[0]) {
    throw new Error("subject_hash 与邮箱指向不同账号，拒绝自动写入");
  }
  const accountId = distinctSubjects[0] || distinctEmails[0];
  if (!accountId) throw new Error("找不到唯一的 Opus Mail V2 账号");
  return accountId;
}

function normalizePaymentExposureInput(input: PaymentExposureIngestInput): {
  accountId: string; target: string; ipCountry: string; billingCountry: string; billingCurrency: string;
  expectedMethod: string; availableMethods: string[]; matchedMethods: string[]; exposed: number; status: string;
  paymentMethods: PaymentExposureCheck["paymentMethods"]; trialStatus: string;
  checkoutType: string; detail: string; promoEligible: number; promoCampaign: string; promoMode: PaymentExposurePromoMode; observedAt: string; source: string;
} {
  const target = canonicalExposureTarget(inputText(input, "target"));
  const ipCountry = inputText(input, "ipCountry", "ip_country").toUpperCase();
  const billingCountry = inputText(input, "billingCountry", "billing_country").toUpperCase();
  const billingCurrency = inputText(input, "billingCurrency", "billing_currency").toUpperCase();
  const expectedMethod = canonicalExposureTarget(inputText(input, "expectedMethod", "expected_method") || target);
  if (!["ideal", "paypal", "gcash", "gopay", "upi", "kakao", "naver", "momo"].includes(target)) throw new Error("不支持的支付方式检查目标");
  if (!/^[A-Z]{2}$/.test(ipCountry) || !/^[A-Z]{2}$/.test(billingCountry)) throw new Error("IP或账单国家格式无效");
  if (!/^[A-Z0-9]{3,12}$/.test(billingCurrency)) throw new Error("账单币种格式无效");
  const statusValue = inputText(input, "status").toLowerCase();
  const status = statusValue === "complete" || statusValue === "unknown" ? statusValue : "unknown";
  const promoRaw = input.promoEligible ?? input.promo_eligible;
  const promoEligible = promoRaw === undefined || promoRaw === null || promoRaw === "" ? -1 : inputBoolean(promoRaw) ? 1 : 0;
  const observedRaw = inputText(input, "observedAt", "observed_at");
  const observedAt = Number.isFinite(Date.parse(observedRaw)) ? new Date(observedRaw).toISOString() : new Date().toISOString();
  const availableMethods = inputStringArray(input, "availableMethods", "available_methods").map((item) => item.slice(0, 64));
  const matchedMethods = inputStringArray(input, "matchedMethods", "matched_methods").map((item) => item.slice(0, 64));
  const promoCampaign = inputText(input, "promoCampaign", "promo_campaign").slice(0, 128);
  const requestedPromoMode = normalizePaymentExposurePromoMode(inputText(input, "promoMode", "promo_mode")
    || (promoCampaign === "plus-1-month-free" ? "one_month" : "unknown"));
  const promoMode = requestedPromoMode === "one_month" && promoEligible === 0 ? "none" : requestedPromoMode;
  const paymentMethods = inputMethodArray(input).map((method) => ({ ...method,
    promoMode: method.promoMode && method.promoMode !== "unknown" ? method.promoMode : promoMode }));
  const trialValue = inputText(input, "trialStatus", "trial_status").toLowerCase();
  const trialStatus = ["observed", "eligible", "ineligible", "unknown"].includes(trialValue) ? trialValue : "unknown";
  return {
    accountId: matchPaymentExposureAccount(input), target, ipCountry, billingCountry, billingCurrency, expectedMethod,
    availableMethods, matchedMethods, paymentMethods, trialStatus, exposed: inputBoolean(input.exposed) ? 1 : 0, status,
    checkoutType: inputText(input, "checkoutType", "checkout_type").slice(0, 32),
    detail: inputText(input, "detail").slice(0, 500), promoEligible, promoCampaign, promoMode,
    observedAt, source: inputText(input, "source").slice(0, 64) || "automyai",
  };
}

export function ingestPaymentExposureChecks(inputs: PaymentExposureIngestInput[]): { accepted: number; updated: number; errors: Array<{ index: number; error: string }> } {
  let accepted = 0;
  let updated = 0;
  const errors: Array<{ index: number; error: string }> = [];
  for (const [index, input] of inputs.slice(0, 500).entries()) {
    try {
      const normalized = normalizePaymentExposureInput(input);
      const now = new Date().toISOString();
      const key = [normalized.accountId, normalized.target, normalized.ipCountry, normalized.billingCountry, normalized.billingCurrency];
      const existing = db.prepare(`SELECT available_methods_json, matched_methods_json, payment_methods_json,
          promo_mode, promo_eligible, promo_campaign FROM payment_exposure_checks
        WHERE account_id=? AND target=? AND ip_country=? AND billing_country=? AND billing_currency=?`).get(...key) as any;
      const existed = Boolean(existing);
      const promoMode = mergePaymentExposurePromoMode(
        normalizePaymentExposurePromoMode(existing?.promo_mode), normalized.promoMode,
      );
      const preservePromoEvidence = normalizePaymentExposurePromoMode(existing?.promo_mode) === "one_month"
        && normalized.promoMode !== "one_month";
      const merged = mergePaymentExposureObservation(
        {
          availableMethods: jsonStringArray(existing?.available_methods_json),
          matchedMethods: jsonStringArray(existing?.matched_methods_json),
          paymentMethods: jsonMethodArray(existing?.payment_methods_json),
        },
        normalized,
      );
      const result = db.prepare(`INSERT INTO payment_exposure_checks(
        id, account_id, target, ip_country, billing_country, billing_currency, expected_method,
        available_methods_json, matched_methods_json, payment_methods_json, trial_status, exposed, status, checkout_type, detail,
        promo_eligible, promo_campaign, promo_mode, observed_at, source, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, target, ip_country, billing_country, billing_currency) DO UPDATE SET
          expected_method=excluded.expected_method, available_methods_json=excluded.available_methods_json,
          matched_methods_json=excluded.matched_methods_json, payment_methods_json=excluded.payment_methods_json,
          trial_status=excluded.trial_status, exposed=excluded.exposed, status=excluded.status,
          checkout_type=excluded.checkout_type, detail=excluded.detail, promo_eligible=excluded.promo_eligible,
          promo_campaign=excluded.promo_campaign, promo_mode=excluded.promo_mode, observed_at=excluded.observed_at, source=excluded.source,
          updated_at=excluded.updated_at`).run(
        crypto.randomUUID(), normalized.accountId, normalized.target, normalized.ipCountry, normalized.billingCountry,
        normalized.billingCurrency, normalized.expectedMethod, JSON.stringify(merged.availableMethods), JSON.stringify(merged.matchedMethods),
        JSON.stringify(merged.paymentMethods), normalized.trialStatus, normalized.exposed, normalized.status, normalized.checkoutType, normalized.detail,
        preservePromoEvidence ? Number(existing?.promo_eligible ?? -1) : normalized.promoEligible,
        preservePromoEvidence ? String(existing?.promo_campaign || "") : normalized.promoCampaign,
        promoMode, normalized.observedAt, normalized.source, now, now,
      );
      if (result.changes > 0) {
        accepted += 1;
        if (existed) updated += 1;
      }
    } catch (error) {
      errors.push({ index, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { accepted, updated, errors };
}

function upsertImportedCredentials(accountId: string, input: ImportAccountInput, subjectHash: string, now: string): void {
  const accessToken = String(input.accessToken || "");
  const refreshToken = String(input.refreshToken || "");
  const idToken = String(input.idToken || "");
  const sessionToken = String(input.sessionToken || "");
  if (input.openaiPassword !== undefined || input.totpSecret !== undefined) {
    const existing = db.prepare("SELECT password_enc,totp_secret_enc FROM account_passwords WHERE account_id=?").get(accountId) as any;
    const passwordEnc = input.openaiPassword === undefined ? String(existing?.password_enc || "") : encryptSecret(String(input.openaiPassword || ""));
    const totpSecretEnc = input.totpSecret === undefined ? String(existing?.totp_secret_enc || "") : encryptSecret(String(input.totpSecret || ""));
    db.prepare(`INSERT INTO account_passwords(account_id,password_enc,totp_secret_enc,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET password_enc=excluded.password_enc,totp_secret_enc=excluded.totp_secret_enc,updated_at=excluded.updated_at`)
      .run(accountId, passwordEnc, totpSecretEnc, now);
  }
  if (!accessToken && !refreshToken && !idToken && !sessionToken) return;
  const binding = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId) as any;
  const observed = observeCredentialVersion({
    accountId, bindingId: String(binding?.id || "") || null, accessToken,
    refreshToken, idToken, sessionToken,
    openaiPassword: String(input.openaiPassword || ""), subjectHash, source: "v2-import",
    observedAt: now, validityStatus: accessToken ? "alive" : "unknown",
    evidence: { import: true },
  });
  if (observed.conflict) throw new Error("凭证身份冲突，导入已回滚");
}

export { credentialHistory };

export function configureImportedMailboxConnection(accountId: string, input: ImportAccountInput): void {
  if (input.address === undefined && input.outlookManagerEmail === undefined) return;
  const binding = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(accountId) as any;
  if (!binding) throw new Error("账号没有当前邮箱绑定");
  const now = new Date().toISOString();
  const manager = normalizeEmail(input.outlookManagerEmail || "");
  const address = String(input.address || "");
  if (!manager && !address) {
    db.prepare("DELETE FROM mailbox_connections WHERE binding_id=?").run(binding.id);
    return;
  }
  if (manager && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(manager)) throw new Error("Outlook 管理邮箱格式无效");
  if (address.length > 16_384) throw new Error("邮箱连接地址过长");
  db.prepare(`INSERT INTO mailbox_connections(id,binding_id,provider,secret_ref,status,manager_email_enc,credentials_enc,
      external_group_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,secret_ref=excluded.secret_ref,status=excluded.status,
      manager_email_enc=excluded.manager_email_enc,credentials_enc=excluded.credentials_enc,
      external_group_id=excluded.external_group_id,updated_at=excluded.updated_at`).run(
    stableId("v2-mailbox-connection", binding.id), binding.id, manager ? "outlook-manager" : "external", `v2:${binding.id}:mailbox`, "active",
    encryptSecret(manager), encryptSecret(JSON.stringify({ address })), String(input.outlookManagerGroupId || ""), now, now,
  );
}

export function importAccounts(inputs: ImportAccountInput[]): { imported: number; created: number; rebound: number; errors: Array<{ index: number; error: string }> } {
  const items = inputs.slice(0, 200);
  let imported = 0, created = 0, rebound = 0;
  const errors: Array<{ index: number; error: string }> = [];
  for (let index = 0; index < items.length; index += 1) {
    const input = items[index];
    try {
      const email = normalizeEmail(input.email);
      const parts = splitEmail(email);
      if (!parts.localPart || !parts.domain) throw new Error("邮箱格式无效");
      const requestedLifecycleStatus = String(input.lifecycleStatus || "").trim().toLowerCase();
      if (requestedLifecycleStatus && !["active", "third_party_registered", "third_party_pending_recovery"].includes(requestedLifecycleStatus)) {
        throw new Error("导入状态只允许 active、third_party_registered 或 third_party_pending_recovery");
      }
      if (requestedLifecycleStatus === "third_party_pending_recovery"
        && [input.accessToken, input.refreshToken, input.idToken, input.sessionToken].some(Boolean)) {
        throw new Error("第三方待恢复账号不能同时导入身份令牌");
      }
      const subject = String(input.openaiSubject || parseJwtSubject(input.accessToken || input.idToken));
      const subjectHash = subject ? sha256(subject) : "";
      let match = resolveAccountMatch(subjectHash, email);
      const previousEmail = normalizeEmail(input.rebindPreviousEmail || "");
      if (previousEmail && previousEmail !== email) {
        const source = db.prepare(`SELECT b.account_id FROM email_bindings b JOIN gpt_accounts a ON a.id=b.account_id
          WHERE b.email_hash=? AND b.is_current=1 AND a.deleted_at=''`).get(emailHash(previousEmail)) as any;
        if (!source) throw new Error("明确改绑来源不存在或已经结束");
        if (match.accountId && match.accountId !== source.account_id) throw new Error("明确改绑来源与目标邮箱身份冲突");
        const existingSubjects = db.prepare("SELECT subject_hash FROM openai_identity_observations WHERE account_id=? AND status='confirmed'").all(source.account_id) as any[];
        if (subjectHash && existingSubjects.some((row) => row.subject_hash !== subjectHash)) throw new Error("明确改绑来源与凭证身份冲突");
        match = { kind: "account", accountId: source.account_id, method: "explicit_import_rebind", reason: "", candidateAccountIds: [source.account_id] };
      }
      if (match.kind === "conflict") {
        const sameCurrentMailboxOnly = match.method === "contradictory_identity"
          && Boolean(match.accountId) && match.candidateAccountIds.length === 1;
        if (match.accountId
          && ["identity_email_conflict", "contradictory_identity", "trusted_local_identity_conflict"].includes(match.method)
          && !sameCurrentMailboxOnly) {
          quarantineAccount(match.accountId, match.reason, "v2-import", { subjectHash, email, candidateAccountIds: match.candidateAccountIds });
        }
        const reason = sameCurrentMailboxOnly
          ? "同一当前邮箱出现新的 OpenAI 身份，已暂存待核对；未修改账号状态或客户链接"
          : match.reason;
        createPendingAssociationReview(match.accountId || null, email, reason, {
          subjectHash, candidateAccountIds: match.candidateAccountIds, source: "v2-import", matchMethod: match.method,
        });
        throw new Error(`${reason}，已进入待审查`);
      }
      let accountId = match.accountId;
      const now = new Date().toISOString();
      let createdItem = false;
      let reboundItem = false;
      db.transaction(() => {
      if (accountId) {
        const existingAccount = db.prepare("SELECT lifecycle_status, sold, deactivation_locked, deleted_at FROM gpt_accounts WHERE id=?").get(accountId) as any;
        if (requestedLifecycleStatus === "third_party_pending_recovery"
          && (existingAccount.lifecycle_status !== "third_party_pending_recovery" || existingAccount.sold || existingAccount.deactivation_locked || existingAccount.deleted_at)) {
          throw new Error("邮箱已存在且不属于第三方待恢复队列，拒绝覆盖");
        }
        const current = db.prepare("SELECT local_part, email_hash FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId) as any;
        if (!current) throw new Error("匹配账号没有当前邮箱绑定");
        if (String(current.email_hash) !== emailHash(email)) {
          if (match.method !== "recycled_mailbox_identity") {
            if (String(current.local_part) !== parts.localPart && !previousEmail) throw new Error("同身份邮箱本地部分不同，禁止自动改绑");
            try {
              rebindAccountTransition(accountId, email, {
                source: "v2-import",
                associationMethod: match.method === "trusted_exact_local_part" ? "trusted_exact_local_part" : "import_identity_rebind",
                evidence: { subjectHash, matchMethod: match.method },
                explicitPreviousEmail: previousEmail,
              });
            } catch (error) {
              createPendingAssociationReview(accountId, email, error instanceof Error ? error.message : String(error), { subjectHash, matchMethod: match.method, source: "v2-import" });
              throw error;
            }
            reboundItem = true;
          }
        }
      }
      if (!accountId) {
        accountId = crypto.randomUUID();
        const bindingId = crypto.randomUUID();
        const provider = mailboxProvider(email);
        const familyId = stableId("mailbox-family", provider, emailHash(email));
        const arrivedAt = Number.isFinite(Date.parse(String(input.arrivedAt || ""))) ? new Date(String(input.arrivedAt)).toISOString() : now;
        const lifecycleStatus = requestedLifecycleStatus || "active";
        db.transaction(() => {
          db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, plan, note, domain_mailbox, identity_status, source_status,
              openai_mfa_enabled, openai_auth_methods_json, arrived_at, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, 'v2', ?, ?, ?, ?, ?)`).run(
            accountId, lifecycleStatus, String(input.plan || "unknown").toLowerCase(), String(input.note || "").slice(0, 4_000), provider === "domain" ? 1 : 0,
            subjectHash ? "confirmed" : "unknown", input.mfaEnabled ? 1 : 0,
            JSON.stringify(Array.isArray(input.authMethods) ? input.authMethods.map(String).filter(Boolean).slice(0, 20) : []),
            arrivedAt, arrivedAt, now,
          );
          db.prepare(`INSERT OR IGNORE INTO mailbox_families(id, provider, canonical_address_enc, canonical_address_hash, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?)`).run(familyId, provider, encryptSecret(email), emailHash(email), now, now);
          db.prepare(`INSERT INTO email_bindings(id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider,
            valid_from, is_current, association_method, legacy_mapping_id, source_json, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'v2_import', ?, '{}', ?, ?)`).run(
            bindingId, accountId, familyId, encryptSecret(email), emailHash(email), parts.localPart, parts.domain, provider,
            arrivedAt, `v2:${bindingId}`, arrivedAt, now,
          );
          insertAdminOnlyGrant(accountId, bindingId, email, now);
          db.prepare(`INSERT INTO lifecycle_events(id, account_id, binding_id, event_type, occurred_at, source, payload_json, created_at)
            VALUES(?, ?, ?, 'account_imported', ?, 'v2-import', ?, ?)`).run(
            crypto.randomUUID(), accountId, bindingId, arrivedAt,
            JSON.stringify({ credentialsStoredSeparately: true, customerAccessInherited: false, lifecycleStatus }), now,
          );
        })();
        createdItem = true;
      } else if (input.note !== undefined || input.plan !== undefined) {
        const currentAccount = db.prepare("SELECT note, plan FROM gpt_accounts WHERE id=?").get(accountId) as any;
        db.prepare("UPDATE gpt_accounts SET note=?, plan=?, updated_at=? WHERE id=?").run(
          input.note === undefined ? currentAccount.note : String(input.note || "").slice(0, 4_000),
          input.plan === undefined ? currentAccount.plan : String(input.plan || "unknown").toLowerCase(),
          now, accountId,
        );
      }
      if (!createdItem && (input.mfaEnabled !== undefined || input.authMethods !== undefined)) {
        const currentAuth = db.prepare("SELECT openai_mfa_enabled,openai_auth_methods_json FROM gpt_accounts WHERE id=?").get(accountId) as any;
        db.prepare("UPDATE gpt_accounts SET openai_mfa_enabled=?,openai_auth_methods_json=?,updated_at=? WHERE id=?").run(
          input.mfaEnabled === undefined ? Number(currentAuth.openai_mfa_enabled || 0) : input.mfaEnabled ? 1 : 0,
          input.authMethods === undefined ? String(currentAuth.openai_auth_methods_json || "[]")
            : JSON.stringify(input.authMethods.map(String).filter(Boolean).slice(0, 20)),
          now, accountId,
        );
      }
      if (subjectHash) {
        const identity = recordIdentityObservation(accountId, subjectHash, "v2-import", { email });
        if (identity.conflict) throw new Error("OpenAI身份与其他GPT账号冲突，当前账号已隔离");
      }
      upsertImportedCredentials(accountId, input, subjectHash, now);
      configureImportedMailboxConnection(accountId, input);
      if (!createdItem && requestedLifecycleStatus === "third_party_registered") {
        const importedAt = Number.isFinite(Date.parse(String(input.arrivedAt || ""))) ? new Date(String(input.arrivedAt)).toISOString() : now;
        const registered = db.prepare(`UPDATE gpt_accounts SET lifecycle_status='third_party_registered',
            arrived_at=CASE WHEN lifecycle_status='third_party_pending_recovery' THEN ? ELSE arrived_at END, updated_at=?
          WHERE id=? AND lifecycle_status IN ('third_party_pending_recovery','third_party_registered')
            AND sold=0 AND deactivation_locked=0 AND deleted_at=''`).run(importedAt, now, accountId);
        if (!registered.changes) throw new Error("邮箱已存在且不属于可转换的第三方注册账号，拒绝覆盖");
      }
      if (!createdItem && [input.accessToken, input.idToken, input.sessionToken].some(Boolean)) {
        const activated = db.prepare(`UPDATE gpt_accounts SET lifecycle_status='third_party_registered', updated_at=?
          WHERE id=? AND lifecycle_status='third_party_pending_recovery' AND sold=0 AND deactivation_locked=0 AND deleted_at=''`).run(now, accountId);
        if (activated.changes > 0) {
          db.prepare(`INSERT INTO lifecycle_events(id, account_id, binding_id, event_type, occurred_at, source, payload_json, created_at)
            VALUES(?, ?, (SELECT id FROM email_bindings WHERE account_id=? AND is_current=1 LIMIT 1),
              'third_party_recovery_completed', ?, 'v2-import', '{}', ?)`).run(crypto.randomUUID(), accountId, accountId, now, now);
        }
      }
      })();
      created += createdItem ? 1 : 0;
      rebound += reboundItem ? 1 : 0;
      imported += 1;
    } catch (error) {
      errors.push({ index, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { imported, created, rebound, errors };
}
