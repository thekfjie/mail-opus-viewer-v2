import crypto from "node:crypto";
import { AccountDetail, AccountSummary, PaymentExposureCheck } from "../shared/types.js";
import { emailHash, normalizeEmail, parseJwtSubject, splitEmail, stableId } from "./association.js";
import { config } from "./config.js";
import { decryptSecret, digestToken, encryptSecret, hashPassword, verifyPassword } from "./crypto.js";
import { db } from "./db.js";
import { observeAccessToken } from "./access-token-observation.js";
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

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
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
  const note = String(row.note || "").trim();
  if (hasAccessToken) return { state: "ready", label: "AT 已就绪", internalPending: false };
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
  const accessTokenFirstSeenAt = String(row.access_token_first_seen_at || "");
  const firstSeenMs = Date.parse(accessTokenFirstSeenAt);
  const autoTrialDueAt = Number.isFinite(firstSeenMs)
    ? new Date(firstSeenMs + config.autoTrialDelayMs).toISOString() : "";
  return {
    id: String(row.id),
    primaryEmail,
    primaryEmailMasked: maskEmail(primaryEmail),
    lifecycleStatus: row.lifecycle_status,
    quarantineReason: String(row.quarantine_reason || ""),
    deactivationLocked: boolean(row.deactivation_locked),
    deactivatedAt: String(row.deactivated_at || ""),
    sold: boolean(row.sold),
    everSold: boolean(row.sold) || Boolean(row.sale_id),
    saleStatus: String(row.sale_status || "none") as AccountSummary["saleStatus"],
    saleId: String(row.sale_id || ""),
    saleFirstUsedAt: String(row.sale_first_used_at || ""),
    sellable: String(row.lifecycle_status) === "active" && !boolean(row.deactivation_locked)
      && String(row.identity_status || "unknown") !== "conflict" && !boolean(row.sold) && !credentials.internalPending,
    sellBlockers: [
      ...(boolean(row.deactivation_locked) ? ["永久停用"] : []),
      ...(String(row.lifecycle_status) !== "active" ? [String(row.lifecycle_status) === "quarantined" ? "归属待核对" : "非活跃账号"] : []),
      ...(String(row.identity_status || "unknown") === "conflict" ? ["OpenAI身份冲突"] : []),
      ...(boolean(row.sold) ? ["该GPT身份已经出售"] : []),
      ...(credentials.internalPending ? [credentials.label] : []),
    ],
    identityStatus: String(row.identity_status || "unknown"),
    accountState,
    accountStateLabel,
    hidePromotion: boolean(row.hide_promotion),
    plan: String(row.plan || "unknown"),
    billingChannel: String(row.billing_channel || ""),
    provider: String(row.provider || "unknown"),
    domainMailbox: boolean(row.domain_mailbox),
    suspectedUnused: boolean(row.suspected_unused),
    hasAccessToken: boolean(row.has_access_token),
    hasRefreshToken: boolean(row.has_refresh_token),
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
    paymentExposureCount,
    paymentExposureExposedCount,
    paymentExposureUnknownCount,
    paymentExposureCheckedAt: String(row.payment_exposure_checked_at || ""),
    trialStatus: String(row.latest_trial_status || "unknown"),
    promoEligible: Number.isFinite(trialPromoValue) && trialPromoValue >= 0 ? trialPromoValue === 1 : null,
    promoCampaign: String(row.latest_promo_campaign || ""),
    trialCheckedAt: String(row.latest_trial_checked_at || ""),
    accessTokenFirstSeenAt,
    autoTrialDueAt,
    autoTrialStatus: String(row.auto_trial_status || "not_scheduled"),
  };
}

const ACCOUNT_SELECT = `
SELECT a.*,
  cb.email_enc AS primary_email_enc,
  cb.provider AS provider,
  COALESCE(c.access_token_alive, 0) AS has_access_token,
  COALESCE(c.refresh_token_alive, 0) AS has_refresh_token,
  s.id AS sale_id,
  COALESCE(s.status, 'none') AS sale_status,
  COALESCE(s.first_used_at, '') AS sale_first_used_at,
  (SELECT COUNT(*) FROM email_bindings b WHERE b.account_id=a.id) AS binding_count,
  (SELECT COUNT(*) FROM account_relations r WHERE r.from_account_id=a.id OR r.to_account_id=a.id) AS relation_count,
  (SELECT COUNT(*) FROM access_grants g WHERE g.account_id=a.id AND g.active=1 AND g.scope!='admin_only') AS customer_grant_count,
  COALESCE((SELECT MAX(m.received_at) FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id WHERE oc.account_id=a.id), '') AS latest_mail_at,
  (SELECT COUNT(*) FROM payment_exposure_checks p WHERE p.account_id=a.id) AS payment_exposure_count,
  (SELECT COUNT(*) FROM payment_exposure_checks p WHERE p.account_id=a.id AND p.exposed=1 AND p.status='complete') AS payment_exposure_exposed_count,
  (SELECT COUNT(*) FROM payment_exposure_checks p WHERE p.account_id=a.id AND p.status='unknown') AS payment_exposure_unknown_count,
  COALESCE((SELECT GROUP_CONCAT(p.target || ':' || p.status, ', ') FROM payment_exposure_checks p WHERE p.account_id=a.id), '') AS payment_exposure_summary,
  COALESCE((SELECT MAX(p.updated_at) FROM payment_exposure_checks p WHERE p.account_id=a.id), '') AS payment_exposure_checked_at,
  COALESCE((SELECT p.trial_status FROM payment_exposure_checks p WHERE p.account_id=a.id ORDER BY p.updated_at DESC, p.id DESC LIMIT 1), 'unknown') AS latest_trial_status,
  COALESCE((SELECT p.promo_eligible FROM payment_exposure_checks p WHERE p.account_id=a.id ORDER BY p.updated_at DESC, p.id DESC LIMIT 1), -1) AS latest_promo_eligible,
  COALESCE((SELECT p.promo_campaign FROM payment_exposure_checks p WHERE p.account_id=a.id ORDER BY p.updated_at DESC, p.id DESC LIMIT 1), '') AS latest_promo_campaign,
  COALESCE((SELECT p.updated_at FROM payment_exposure_checks p WHERE p.account_id=a.id ORDER BY p.updated_at DESC, p.id DESC LIMIT 1), '') AS latest_trial_checked_at,
  COALESCE(c.access_token_first_seen_at, '') AS access_token_first_seen_at,
  COALESCE((SELECT j.status FROM payment_exposure_jobs j WHERE j.account_id=a.id AND j.job_kind='auto_trial' ORDER BY j.created_at DESC, j.job_id DESC LIMIT 1), '') AS auto_trial_status
FROM gpt_accounts a
LEFT JOIN email_bindings cb ON cb.id=(
  SELECT b2.id FROM email_bindings b2 WHERE b2.account_id=a.id ORDER BY b2.is_current DESC, b2.valid_from DESC, b2.created_at DESC LIMIT 1
)
LEFT JOIN credentials c ON c.account_id=a.id
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
  limit?: number;
  offset?: number;
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
  if (filters.billingChannel === "unknown") where.push("a.billing_channel=''");
  else if (filters.billingChannel) { where.push("a.billing_channel=?"); params.push(filters.billingChannel); }
  if (filters.sold === "true" || filters.sold === "false") { where.push("a.sold=?"); params.push(filters.sold === "true" ? 1 : 0); }
  if (filters.plan) { where.push("a.plan=?"); params.push(filters.plan); }
  if (filters.sourceStatus) { where.push("a.source_status=?"); params.push(filters.sourceStatus); }
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
  const rows = db.prepare(`${ACCOUNT_SELECT}${clause} ORDER BY a.arrived_at DESC, a.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
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
  const rows = db.prepare(`${ACCOUNT_SELECT} WHERE a.deleted_at='' ORDER BY a.arrived_at DESC, a.id DESC`).all() as any[];
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
    candidateEmail: decryptSecret(String(row.candidate_email_enc || "")),
    reason: String(row.reason || ""),
    evidence: JSON.parse(String(row.evidence_json || "{}")),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  }));
}

export function resolvePendingReview(reviewId: string, action: string): Record<string, unknown> {
  const review = db.prepare("SELECT * FROM pending_reviews WHERE id=? AND status='pending'").get(reviewId) as any;
  if (!review) throw new Error("待审查记录不存在或已经处理");
  const allowed = new Set(["dismiss", "keep_separate", "confirm_rebind"]);
  if (!allowed.has(action)) throw new Error("不支持的审查操作");
  const now = new Date().toISOString();
  if (action === "confirm_rebind") {
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
  const audit = {
    frozenWithUnboundedCurrentGrant: Number((db.prepare(`SELECT COUNT(DISTINCT a.id) AS count FROM gpt_accounts a
      JOIN access_grants g ON g.account_id=a.id WHERE a.deactivation_locked=1 AND g.active=1 AND g.scope='current' AND g.visible_to=''`).get() as any).count || 0),
    accountsWithMultipleCurrentBindings: Number((db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT account_id FROM email_bindings WHERE is_current=1 GROUP BY account_id HAVING COUNT(*)>1)`).get() as any).count || 0),
    currentGrantsOnHistoricalBindings: Number((db.prepare(`SELECT COUNT(*) AS count FROM access_grants g JOIN email_bindings b ON b.id=g.binding_id
      WHERE g.active=1 AND g.scope='current' AND b.is_current=0`).get() as any).count || 0),
    accountsWithMultipleActiveCustomerGrants: Number((db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT account_id FROM access_grants WHERE active=1 AND scope='current' GROUP BY account_id HAVING COUNT(*)>1)`).get() as any).count || 0),
    duplicateEmailAcrossAccounts: Number((db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT email_hash FROM email_bindings GROUP BY email_hash HAVING COUNT(DISTINCT account_id)>1)`).get() as any).count || 0),
    messagesClaimedByMultipleAccounts: Number((db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT message_id FROM mail_ownership_claims GROUP BY message_id HAVING COUNT(DISTINCT account_id)>1)`).get() as any).count || 0),
    quarantinedAccounts: Number((db.prepare("SELECT COUNT(*) AS count FROM gpt_accounts WHERE lifecycle_status='quarantined' OR identity_status='conflict'").get() as any).count || 0),
    pendingReviews: Number((db.prepare("SELECT COUNT(*) AS count FROM pending_reviews WHERE status='pending'").get() as any).count || 0),
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

function jsonMethodArray(value: unknown): PaymentExposureCheck["paymentMethods"] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === "object").map((item: any) => ({
      id: String(item.id || ""), type: String(item.type || ""), provider: String(item.provider || ""),
      name: String(item.name || ""), code: String(item.code || ""), displayName: String(item.displayName || ""),
      source: String(item.source || ""),
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
    observedAt: String(row.observed_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

export function listPaymentExposureChecks(accountId: string): PaymentExposureCheck[] {
  return (db.prepare(`SELECT * FROM payment_exposure_checks WHERE account_id=?
    ORDER BY datetime(updated_at) DESC, target ASC`).all(accountId) as any[]).map(paymentExposureRow);
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
  return { ...summary, note: row.note, paymentLink: row.payment_link, hidePromotion: boolean(row.hide_promotion), bindings, relations, timeline, paymentExposureChecks: listPaymentExposureChecks(id) };
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
    SUM(CASE WHEN suspected_unused=1 THEN 1 ELSE 0 END) AS unused,
    SUM(CASE WHEN source_status='recovered' THEN 1 ELSE 0 END) AS recovered
    FROM gpt_accounts WHERE deleted_at=''`).get() as any;
  const credentialCounts = db.prepare(`${ACCOUNT_SELECT} WHERE a.deleted_at=''`).all() as any[];
  const internalPending = credentialCounts.filter((row) => credentialState(row).internalPending).length;
  const visibleCredentialRows = credentialCounts.filter((row) => !credentialState(row).internalPending);
  const actionableMissingAt = credentialCounts.filter((row) => !boolean(row.has_access_token) && !credentialState(row).internalPending).length;
  const source = db.prepare("SELECT value FROM settings WHERE key='v1_source_count'").get() as any;
  const sync = db.prepare("SELECT * FROM shadow_sync_runs ORDER BY started_at DESC LIMIT 1").get() as any;
  const sub2Sync = db.prepare("SELECT * FROM sub2api_sync_runs ORDER BY started_at DESC LIMIT 1").get() as any;
  return {
    ...counts,
    visibleAccounts: Math.max(0, Number(counts.accounts || 0) - internalPending),
    visibleActive: visibleCredentialRows.filter((row) => String(row.lifecycle_status) === "active").length,
    visibleDomains: visibleCredentialRows.filter((row) => boolean(row.domain_mailbox)).length,
    visibleUnused: visibleCredentialRows.filter((row) => boolean(row.suspected_unused)).length,
    internalPending,
    actionableMissingAt,
    v1SourceRecords: Number(source?.value || 0), readOnly: config.readOnly,
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
    label: row.lifecycle_status === "deactivated" ? "账号已停用" : "Mailbox",
  };
}

export function grantByPublicToken(token: string): GrantRecord | null {
  const row = db.prepare(`SELECT g.*, a.hide_promotion, a.lifecycle_status FROM access_grants g
    JOIN gpt_accounts a ON a.id=g.account_id WHERE g.public_token_hash=? AND g.active=1 AND g.scope!='admin_only'`).get(digestToken(token)) as any;
  if (!row) return null;
  markGrantUsed(String(row.id));
  return grantRow(row);
}

export function grantById(id: string): GrantRecord | null {
  const row = db.prepare(`SELECT g.*, a.hide_promotion, a.lifecycle_status FROM access_grants g
    JOIN gpt_accounts a ON a.id=g.account_id WHERE g.id=? AND g.active=1 AND g.scope!='admin_only'`).get(id) as any;
  return row ? grantRow(row) : null;
}

export function authenticateCustomer(email: string, password: string): GrantRecord | null {
  const rows = db.prepare(`SELECT g.*, a.hide_promotion, a.lifecycle_status FROM access_grants g
    JOIN gpt_accounts a ON a.id=g.account_id WHERE g.login_identifier_hash=? AND g.active=1 AND g.scope!='admin_only'`).all(emailHash(normalizeEmail(email))) as any[];
  const matched = rows.filter((row) => verifyPassword(password, String(row.password_hash || "")));
  if (matched.length !== 1) return null;
  markGrantUsed(String(matched[0].id));
  return grantRow(matched[0]);
}

function visibleMailWhere(grant: GrantRecord): { clause: string; params: unknown[] } {
  const dateClauses: string[] = [];
  const params: unknown[] = [];
  if (grant.visibleFrom) { dateClauses.push("datetime(m.received_at) >= datetime(?)"); params.push(grant.visibleFrom); }
  if (grant.visibleTo) { dateClauses.push("datetime(m.received_at) < datetime(?)"); params.push(grant.visibleTo); }
  const dateClause = dateClauses.length ? ` AND ${dateClauses.join(" AND ")}` : "";
  return {
    clause: `oc.binding_id=? AND NOT EXISTS (
      SELECT 1 FROM mail_ownership_claims conflicting
      WHERE conflicting.message_id=m.id AND conflicting.account_id<>oc.account_id
    )${dateClause}`,
    params: [grant.bindingId, ...params],
  };
}

export function listCustomerMails(grant: GrantRecord, offset: number, limit: number): { results: any[]; count: number } {
  const visible = visibleMailWhere(grant);
  const promotionClause = grant.hidePromotion ? " AND m.category!='promotion'" : "";
  const from = `FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id WHERE ${visible.clause} AND oc.visible_to_customer=1${promotionClause}`;
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
    WHERE m.id=? AND ${visible.clause} AND oc.visible_to_customer=1${promotionClause}`).get(messageId, ...visible.params) as any;
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
  const row = db.prepare("SELECT * FROM credentials WHERE account_id=?").get(accountId) as any;
  if (!row) return null;
  return {
    accessToken: decryptSecret(row.access_token_enc),
    refreshToken: decryptSecret(row.refresh_token_enc),
    idToken: decryptSecret(row.id_token_enc),
    sessionToken: decryptSecret(row.session_token_enc),
    openaiPassword: decryptSecret(row.openai_password_enc),
  };
}

export function primaryEmailForAccount(accountId: string): string {
  const row = db.prepare(`SELECT b.email_enc FROM email_bindings b
    WHERE b.account_id=? ORDER BY b.is_current DESC, datetime(b.valid_from) DESC, datetime(b.created_at) DESC LIMIT 1`).get(accountId) as any;
  return row ? normalizeEmail(decryptSecret(String(row.email_enc || ""))) : "";
}

export interface PaymentExposureCredentials {
  accessToken: string;
  sessionToken: string;
  email: string;
  accessTokenFingerprint: string;
  accessTokenFirstSeenAt: string;
}

// This is an internal handoff to the server-side AutoMyAI bridge. The route
// handler must never serialize this object into an admin response.
export function getPaymentExposureCredentials(accountId: string): PaymentExposureCredentials | null {
  const row = db.prepare(`SELECT c.access_token_enc, c.session_token_enc, c.access_token_fingerprint, c.access_token_first_seen_at, b.email_enc
    FROM gpt_accounts a
    JOIN credentials c ON c.account_id=a.id
    LEFT JOIN email_bindings b ON b.id=(
      SELECT b2.id FROM email_bindings b2 WHERE b2.account_id=a.id
      ORDER BY b2.is_current DESC, b2.valid_from DESC, b2.created_at DESC LIMIT 1
    )
    WHERE a.id=? AND a.deleted_at=''`).get(accountId) as any;
  if (!row) return null;
  return {
    accessToken: decryptSecret(String(row.access_token_enc || "")),
    sessionToken: decryptSecret(String(row.session_token_enc || "")),
    email: normalizeEmail(decryptSecret(String(row.email_enc || ""))),
    accessTokenFingerprint: String(row.access_token_fingerprint || ""),
    accessTokenFirstSeenAt: String(row.access_token_first_seen_at || ""),
  };
}

export interface PaymentExposureJobRecord {
  jobId: string;
  accountId: string;
  routeKey: string;
  target: string;
  ipCountry: string;
  billingCountry: string;
  billingCurrency: string;
  jobKind: string;
  accessTokenFingerprint: string;
  scheduledAt: string;
  status: string;
  lastError: string;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
  updatedAt: string;
}

function paymentExposureJobRow(row: any): PaymentExposureJobRecord {
  return {
    jobId: String(row.job_id || ""), accountId: String(row.account_id || ""), routeKey: String(row.route_key || ""),
    target: String(row.target || ""), ipCountry: String(row.ip_country || ""), billingCountry: String(row.billing_country || ""),
    billingCurrency: String(row.billing_currency || ""), jobKind: String(row.job_kind || "manual"),
    accessTokenFingerprint: String(row.access_token_fingerprint || ""), scheduledAt: String(row.scheduled_at || ""),
    status: String(row.status || "unknown"), lastError: String(row.last_error || ""),
    startedAt: String(row.started_at || ""), finishedAt: String(row.finished_at || ""), createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

export type PaymentExposureJobInput = Omit<PaymentExposureJobRecord, "updatedAt" | "jobKind" | "accessTokenFingerprint" | "scheduledAt">
  & Partial<Pick<PaymentExposureJobRecord, "jobKind" | "accessTokenFingerprint" | "scheduledAt">>;

export function createPaymentExposureJob(input: PaymentExposureJobInput): PaymentExposureJobRecord {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO payment_exposure_jobs(
    job_id, account_id, route_key, target, ip_country, billing_country, billing_currency,
    job_kind, access_token_fingerprint, scheduled_at, status, last_error, started_at, finished_at, created_at, updated_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(
    input.jobId, input.accountId, input.routeKey, input.target, input.ipCountry, input.billingCountry, input.billingCurrency,
    input.jobKind || "manual", input.accessTokenFingerprint || "", input.scheduledAt || "",
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
  db.prepare(`UPDATE payment_exposure_jobs SET job_id=?, status=?, last_error=?, started_at=?, finished_at=?, updated_at=? WHERE job_id=?`).run(
    remoteJobId, String(patch.status || "queued"), patch.lastError === undefined ? existing.last_error : String(patch.lastError || "").slice(0, 500),
    patch.startedAt === undefined ? existing.started_at : String(patch.startedAt || "").slice(0, 64),
    patch.finishedAt === undefined ? existing.finished_at : String(patch.finishedAt || "").slice(0, 64), now, reservationId,
  );
  return paymentExposureJobRow(db.prepare("SELECT * FROM payment_exposure_jobs WHERE job_id=?").get(remoteJobId));
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

export function formatCurrentCustomerExportText(currentEmail: string, loginIdentifier: string, publicUrl: string): string {
  const email = String(currentEmail || "");
  const login = String(loginIdentifier || "");
  const url = String(publicUrl || "");
  const lines = [`ai账号：${email}`];
  if (login && login.toLowerCase() !== email.toLowerCase()) lines.push(`登录标识：${login}`);
  lines.push(`邮箱验证码：${url}`);
  return lines.join("\n");
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
    text: formatCurrentCustomerExportText(currentEmail, base.loginIdentifier, publicUrl),
    reason: "",
  };
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
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  openaiPassword?: string;
  openaiSubject?: string;
  plan?: string;
  note?: string;
  arrivedAt?: string;
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
  return value.filter((item) => item && typeof item === "object").map((item: any) => ({
    id: String(item.id || "").trim().slice(0, 128), type: String(item.type || "").trim().toLowerCase().slice(0, 64),
    provider: String(item.provider || "").trim().toLowerCase().slice(0, 64), name: String(item.name || "").trim().slice(0, 128),
    code: String(item.code || "").trim().slice(0, 128), displayName: String(item.displayName || item.display_name || "").trim().slice(0, 128),
    source: String(item.source || "").trim().toLowerCase().slice(0, 64),
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
  checkoutType: string; detail: string; promoEligible: number; promoCampaign: string; observedAt: string; source: string;
} {
  const target = canonicalExposureTarget(inputText(input, "target"));
  const ipCountry = inputText(input, "ipCountry", "ip_country").toUpperCase();
  const billingCountry = inputText(input, "billingCountry", "billing_country").toUpperCase();
  const billingCurrency = inputText(input, "billingCurrency", "billing_currency").toUpperCase();
  const expectedMethod = canonicalExposureTarget(inputText(input, "expectedMethod", "expected_method") || target);
  if (!["ideal", "paypal", "gcash"].includes(target)) throw new Error("不支持的支付方式检查目标");
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
  const paymentMethods = inputMethodArray(input);
  const trialValue = inputText(input, "trialStatus", "trial_status").toLowerCase();
  const trialStatus = ["observed", "eligible", "ineligible", "unknown"].includes(trialValue) ? trialValue : "unknown";
  return {
    accountId: matchPaymentExposureAccount(input), target, ipCountry, billingCountry, billingCurrency, expectedMethod,
    availableMethods, matchedMethods, paymentMethods, trialStatus, exposed: inputBoolean(input.exposed) ? 1 : 0, status,
    checkoutType: inputText(input, "checkoutType", "checkout_type").slice(0, 32),
    detail: inputText(input, "detail").slice(0, 500), promoEligible, promoCampaign: inputText(input, "promoCampaign", "promo_campaign").slice(0, 128),
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
      const existed = Boolean(db.prepare(`SELECT 1 FROM payment_exposure_checks
        WHERE account_id=? AND target=? AND ip_country=? AND billing_country=? AND billing_currency=?`).get(...key));
      const result = db.prepare(`INSERT INTO payment_exposure_checks(
        id, account_id, target, ip_country, billing_country, billing_currency, expected_method,
        available_methods_json, matched_methods_json, payment_methods_json, trial_status, exposed, status, checkout_type, detail,
        promo_eligible, promo_campaign, observed_at, source, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, target, ip_country, billing_country, billing_currency) DO UPDATE SET
          expected_method=excluded.expected_method, available_methods_json=excluded.available_methods_json,
          matched_methods_json=excluded.matched_methods_json, payment_methods_json=excluded.payment_methods_json,
          trial_status=excluded.trial_status, exposed=excluded.exposed, status=excluded.status,
          checkout_type=excluded.checkout_type, detail=excluded.detail, promo_eligible=excluded.promo_eligible,
          promo_campaign=excluded.promo_campaign, observed_at=excluded.observed_at, source=excluded.source,
          updated_at=excluded.updated_at`).run(
        crypto.randomUUID(), normalized.accountId, normalized.target, normalized.ipCountry, normalized.billingCountry,
        normalized.billingCurrency, normalized.expectedMethod, JSON.stringify(normalized.availableMethods), JSON.stringify(normalized.matchedMethods),
        JSON.stringify(normalized.paymentMethods), normalized.trialStatus, normalized.exposed, normalized.status, normalized.checkoutType, normalized.detail, normalized.promoEligible,
        normalized.promoCampaign, normalized.observedAt, normalized.source, now, now,
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
  const existing = db.prepare("SELECT access_token_fingerprint, access_token_first_seen_at FROM credentials WHERE account_id=?").get(accountId) as any;
  const tokenObservation = observeAccessToken(accessToken, existing ? {
    fingerprint: String(existing.access_token_fingerprint || ""),
    firstSeenAt: String(existing.access_token_first_seen_at || ""),
  } : null, now);
  db.prepare(`INSERT INTO credentials(account_id, access_token_enc, refresh_token_enc, id_token_enc, openai_password_enc,
    openai_subject_hash, access_token_alive, refresh_token_alive, source, source_updated_at, access_token_fingerprint, access_token_first_seen_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'v2-import', ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      access_token_enc=CASE WHEN excluded.access_token_enc!='' THEN excluded.access_token_enc ELSE credentials.access_token_enc END,
      refresh_token_enc=CASE WHEN excluded.refresh_token_enc!='' THEN excluded.refresh_token_enc ELSE credentials.refresh_token_enc END,
      id_token_enc=CASE WHEN excluded.id_token_enc!='' THEN excluded.id_token_enc ELSE credentials.id_token_enc END,
      openai_password_enc=CASE WHEN excluded.openai_password_enc!='' THEN excluded.openai_password_enc ELSE credentials.openai_password_enc END,
      openai_subject_hash=CASE WHEN excluded.openai_subject_hash!='' THEN excluded.openai_subject_hash ELSE credentials.openai_subject_hash END,
      access_token_alive=CASE WHEN excluded.access_token_enc!='' THEN 1 ELSE credentials.access_token_alive END,
      refresh_token_alive=CASE WHEN excluded.refresh_token_enc!='' THEN 1 ELSE credentials.refresh_token_alive END,
      access_token_fingerprint=CASE WHEN excluded.access_token_fingerprint!='' THEN excluded.access_token_fingerprint ELSE credentials.access_token_fingerprint END,
      access_token_first_seen_at=CASE WHEN excluded.access_token_fingerprint!='' THEN excluded.access_token_first_seen_at ELSE credentials.access_token_first_seen_at END,
      source='v2-import', source_updated_at=excluded.source_updated_at, updated_at=excluded.updated_at`).run(
    accountId, encryptSecret(accessToken), encryptSecret(String(input.refreshToken || "")),
    encryptSecret(String(input.idToken || "")), encryptSecret(String(input.openaiPassword || "")), subjectHash,
    accessToken ? 1 : 0, input.refreshToken ? 1 : 0, now, tokenObservation.fingerprint, tokenObservation.firstSeenAt, now,
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
      const subject = String(input.openaiSubject || parseJwtSubject(input.accessToken || input.idToken));
      const subjectHash = subject ? sha256(subject) : "";
      const match = resolveAccountMatch(subjectHash, email);
      if (match.kind === "conflict") {
        if (match.accountId && ["identity_email_conflict", "contradictory_identity", "trusted_local_identity_conflict"].includes(match.method)) {
          quarantineAccount(match.accountId, match.reason, "v2-import", { subjectHash, email, candidateAccountIds: match.candidateAccountIds });
        }
        createPendingAssociationReview(match.accountId || null, email, match.reason, { subjectHash, candidateAccountIds: match.candidateAccountIds, source: "v2-import" });
        throw new Error(`${match.reason}，已进入待审查`);
      }
      let accountId = match.accountId;
      const now = new Date().toISOString();
      if (accountId) {
        const current = db.prepare("SELECT local_part, email_hash FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId) as any;
        if (!current) throw new Error("匹配账号没有当前邮箱绑定");
        if (String(current.email_hash) !== emailHash(email)) {
          if (match.method !== "recycled_mailbox_identity") {
            if (String(current.local_part) !== parts.localPart) throw new Error("同身份邮箱本地部分不同，禁止自动改绑");
            try {
              rebindAccountTransition(accountId, email, {
                source: "v2-import",
                associationMethod: match.method === "trusted_exact_local_part" ? "trusted_exact_local_part" : "import_identity_rebind",
                evidence: { subjectHash, matchMethod: match.method },
              });
            } catch (error) {
              createPendingAssociationReview(accountId, email, error instanceof Error ? error.message : String(error), { subjectHash, matchMethod: match.method, source: "v2-import" });
              throw error;
            }
            rebound += 1;
          }
        }
      }
      if (!accountId) {
        accountId = crypto.randomUUID();
        const bindingId = crypto.randomUUID();
        const provider = mailboxProvider(email);
        const familyId = stableId("mailbox-family", provider, emailHash(email));
        const arrivedAt = Number.isFinite(Date.parse(String(input.arrivedAt || ""))) ? new Date(String(input.arrivedAt)).toISOString() : now;
        db.transaction(() => {
          db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, plan, note, domain_mailbox, identity_status, source_status, arrived_at, created_at, updated_at)
            VALUES(?, 'active', ?, ?, ?, ?, 'v2', ?, ?, ?)`).run(
            accountId, String(input.plan || "unknown").toLowerCase(), String(input.note || "").slice(0, 4_000), provider === "domain" ? 1 : 0,
            subjectHash ? "confirmed" : "unknown", arrivedAt, arrivedAt, now,
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
            crypto.randomUUID(), accountId, bindingId, arrivedAt, JSON.stringify({ credentialsStoredSeparately: true, customerAccessInherited: false }), now,
          );
        })();
        created += 1;
      } else if (input.note !== undefined || input.plan !== undefined) {
        const currentAccount = db.prepare("SELECT note, plan FROM gpt_accounts WHERE id=?").get(accountId) as any;
        db.prepare("UPDATE gpt_accounts SET note=?, plan=?, updated_at=? WHERE id=?").run(
          input.note === undefined ? currentAccount.note : String(input.note || "").slice(0, 4_000),
          input.plan === undefined ? currentAccount.plan : String(input.plan || "unknown").toLowerCase(),
          now, accountId,
        );
      }
      if (subjectHash) {
        const identity = recordIdentityObservation(accountId, subjectHash, "v2-import", { email });
        if (identity.conflict) throw new Error("OpenAI身份与其他GPT账号冲突，当前账号已隔离");
      }
      upsertImportedCredentials(accountId, input, subjectHash, now);
      imported += 1;
    } catch (error) {
      errors.push({ index, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { imported, created, rebound, errors };
}
