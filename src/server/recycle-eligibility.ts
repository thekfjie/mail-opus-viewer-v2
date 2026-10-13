import type { RecycleEligibility, RecycleMode, RecycleModeEligibility } from "../shared/types.js";
import { credentialPlan, normalizeHiddenTags } from "./business-evidence.js";
import { decryptSecret } from "./crypto.js";
import { db } from "./db.js";

// Eligibility never schedules work or changes a grant. These are the V1
// administrator recycle rules; opening a customer link is not a time trigger.
export const RECYCLE_WAIT_MS = 7 * 24 * 60 * 60 * 1_000;
export const RECYCLE_MAX_GENERATION = 2;
const SIGNUP_PENDING = "automyai OpenAI signup pool pending";
const REGISTERED_PENDING = "automyai UC signup registered; OAuth pending";
const asBoolean = (value: unknown) => Boolean(Number(value));

export async function recycleGeneration(accountId: string): Promise<number> {
  const explicit = (await db.prepare("SELECT recycle_generation FROM account_business_evidence WHERE account_id=?").get(accountId)) as any;
  const value = Number(explicit?.recycle_generation);
  if (explicit?.recycle_generation != null && Number.isInteger(value) && value >= 0) return value;
  const row = (await db.prepare(`WITH RECURSIVE lineage(id, depth) AS (
    SELECT ?, 0 UNION ALL SELECT r.from_account_id, lineage.depth+1 FROM account_relations r
    JOIN lineage ON r.to_account_id=lineage.id
    WHERE r.relation_type='mailbox_recycle' AND r.status='confirmed' AND lineage.depth<20
  ) SELECT COALESCE(MAX(depth),0) depth FROM lineage`).get(accountId)) as any;
  return Number(row?.depth || 0);
}

export async function getRecycleEligibility(accountId: string, nowMs = Date.now()): Promise<RecycleEligibility | null> {
  if (!Number.isFinite(nowMs)) throw new Error("回收资格检查时间无效");
  const row = (await db.prepare(`SELECT a.*,b.id binding_id,b.provider,b.domain,b.valid_from,
      EXISTS(SELECT 1 FROM account_origins o WHERE o.account_id=a.id AND o.is_auto=1) is_auto,
      EXISTS(SELECT 1 FROM mailbox_connections mc WHERE mc.binding_id=b.id) direct_mailbox,
      EXISTS(SELECT 1 FROM access_grants g WHERE g.account_id=a.id AND g.first_used_at!='') customer_opened,
      cv.validity_status credential_validity,cv.access_token_enc,cv.refresh_token_enc,cv.id_token_enc,
      e.hidden_tags_json,e.mail_verified_no_plus,e.mail_verified_at,e.audit_binding_id
    FROM gpt_accounts a LEFT JOIN email_bindings b ON b.account_id=a.id AND b.is_current=1
    LEFT JOIN account_current_credentials cc ON cc.account_id=a.id
    LEFT JOIN credential_versions cv ON cv.id=cc.credential_version_id
    LEFT JOIN account_business_evidence e ON e.account_id=a.id WHERE a.id=?
    ORDER BY b.valid_from DESC LIMIT 1`).get(accountId)) as any;
  if (!row) return null;
  const generation = (await recycleGeneration(accountId));
  let tokenPlan: "free" | "paid" | "unknown" = "unknown";
  let hasAccessToken = false, hasRefreshToken = false, credentialUnreadable = false;
  try {
    const accessToken = decryptSecret(String(row.access_token_enc || "")).trim();
    hasAccessToken = Boolean(accessToken);
    hasRefreshToken = Boolean(decryptSecret(String(row.refresh_token_enc || "")).trim());
    tokenPlan = credentialPlan(accessToken, decryptSecret(String(row.id_token_enc || "")));
  } catch { credentialUnreadable = true; }
  const deactivationLocked = asBoolean(row.deactivation_locked);
  const deactivatedAt = String(row.deactivated_at || "");
  const banAt = Date.parse(deactivatedAt);
  const eligibleAt = deactivationLocked && Number.isFinite(banAt) ? new Date(banAt + RECYCLE_WAIT_MS).toISOString() : "";
  // V1 restoration can retain a historical recycle relation. Only the current
  // retirement state blocks eligibility; V2 reclaim always records retired_at.
  const retired = Boolean(row.retired_at || String(row.lifecycle_status).toLowerCase() === "retired");
  const deleted = Boolean(row.deleted_at || row.lifecycle_status === "deleted");
  const sold = asBoolean(row.sold), isAuto = asBoolean(row.is_auto);
  const sharedMailbox = Boolean(row.binding_id) && !asBoolean(row.direct_mailbox);
  const mailVerifiedAt = Date.parse(String(row.mail_verified_at || ""));
  const bindingFrom = Date.parse(String(row.valid_from || ""));
  // V1 cache validity depended on the mailbox configuration. Never accept
  // evidence predating a rebind or tied to a different current binding.
  const mailVerifiedNoPlus = asBoolean(row.mail_verified_no_plus) && Number.isFinite(mailVerifiedAt)
    && mailVerifiedAt <= nowMs && (!Number.isFinite(bindingFrom) || mailVerifiedAt >= bindingFrom)
    && (!row.audit_binding_id || row.audit_binding_id === row.binding_id);
  const hasPlusEvidence = ["plus", "pro", "team", "business", "enterprise", "edu"].includes(String(row.plan).toLowerCase()) || tokenPlan === "paid";
  const noATMailFree = !hasAccessToken && tokenPlan === "unknown" && mailVerifiedNoPlus;
  const reusableNoATAutoICloud = row.domain === "icloud.com" && isAuto && noATMailFree && !hasPlusEvidence;
  let hiddenTags: unknown = [];
  try { hiddenTags = JSON.parse(String(row.hidden_tags_json || "[]")); } catch { hiddenTags = [null]; }
  const invalidHiddenTags = !Array.isArray(hiddenTags) || hiddenTags.some((item) => item === null);
  const specialMarkerCount = normalizeHiddenTags(hiddenTags).length + [row.mark_color, row.payment_link, row.billing_channel_override, sold].filter(Boolean).length;
  const note = String(row.note || "").trim();
  const signupPending = note === SIGNUP_PENDING && !sold && row.lifecycle_status === "active" && !hasAccessToken && !hasRefreshToken;
  const retryPending = [SIGNUP_PENDING, REGISTERED_PENDING].includes(note) && !sold && isAuto
    && row.lifecycle_status === "active" && !hasAccessToken && !hasRefreshToken;
  const common = deleted ? "账号已删除，不能回收"
    : retired ? "该旧邮箱身份已经完成回收"
    : !row.binding_id ? "账号没有当前邮箱绑定"
    : asBoolean(row.domain_mailbox) || row.provider !== "icloud" || row.domain !== "icloud.com" ? "回收只适用于 iCloud 共享收件账号；域名邮箱和 Outlook 固定保留"
    : !sharedMailbox ? "仅共享收件池邮箱支持回收"
    : row.lifecycle_status === "quarantined" || row.identity_status === "conflict" || row.quarantine_reason ? "存在身份冲突或业务隔离的账号不能回收"
    : sold && !deactivationLocked ? "已售且未停用的账号不能回收" : "";
  const generationReason = generation >= RECYCLE_MAX_GENERATION ? "该账号链已达到最多 2 次回收限制" : "";
  const deactivatedReason = common || generationReason || (!deactivationLocked ? "尚未检测到 GPT 停用证据"
    : !eligibleAt ? "缺少已确认的停用时间，不能按创建时间推算"
    : nowMs < Date.parse(eligibleAt) ? "账号停用未满 7 天" : "");
  const freeReason = common || (!reusableNoATAutoICloud ? generationReason : "")
    || (credentialUnreadable ? "凭证不可读取，无法确认 Free 资格"
      : hasPlusEvidence ? "检测到 Plus/付费套餐证据，已保护不回收"
      : tokenPlan !== "free" && hasAccessToken ? "Token 套餐状态不明确，已保护不回收"
      : tokenPlan !== "free" && !mailVerifiedNoPlus ? "缺少 Token 明确 Free 或当前邮箱无 Plus 检查证据"
      : deactivationLocked ? "已停用账号应使用停用账号回收"
      : (signupPending || retryPending) && !reusableNoATAutoICloud ? "该账号仍在待注册或待授权队列"
      : specialMarkerCount || invalidHiddenTags ? "账号存在颜色、支付、已售或隐藏探查标记，已保护不回收" : "");
  const invalidAT = row.credential_validity === "invalid";
  const invalidReason = freeReason || (!hasAccessToken ? "该账号没有 AT，请使用 Free 无特殊标记回收"
    : !invalidAT ? "当前 AT 尚未明确判定为失效" : "");
  const aliasReason = common || (credentialUnreadable ? "凭证不可读取，不能轮换注册后缀"
    : deactivationLocked ? "已停用账号应使用停用账号回收"
    : !isAuto ? "仅自动注册池账号支持后缀轮换"
    : !signupPending ? "仅未注册成功且尚无令牌的待注册账号支持后缀轮换"
    : hasPlusEvidence ? "检测到 Plus 证据，不能轮换注册后缀" : "");
  const mode = (reason: string, at = ""): RecycleModeEligibility => ({ eligible: !reason, reason, eligibleAt: at, trigger: "admin_only" });
  return { accountId, generation, maxGeneration: RECYCLE_MAX_GENERATION, waitMs: RECYCLE_WAIT_MS, checkedAt: new Date(nowMs).toISOString(),
    account: { lifecycleStatus: row.lifecycle_status, deactivationLocked, deactivatedAt, retired, deleted, sold, customerOpened: asBoolean(row.customer_opened) },
    evidence: { tokenPlan, hasAccessToken, invalidAT, mailVerifiedNoPlus, hasPlusEvidence, isAuto, sharedMailbox, specialMarkerCount, reusableNoATAutoICloud },
    modes: { deactivated: mode(deactivatedReason, eligibleAt), untagged_free: mode(freeReason), invalid_at: mode(invalidReason), alias_rotate: mode(aliasReason) } };
}

export async function assertRecycleEligibility(accountId: string, mode: RecycleMode, nowMs = Date.now()): Promise<RecycleEligibility> {
  const result = (await getRecycleEligibility(accountId, nowMs));
  if (!result) throw new Error("账号不存在");
  if (!result.modes[mode]?.eligible) throw new Error(result.modes[mode]?.reason || "回收模式无效");
  return result;
}

export function recycleEligibilityAudit(eligibility: RecycleEligibility, mode: RecycleMode) {
  return { checkedAt: eligibility.checkedAt, generation: eligibility.generation, waitMs: eligibility.waitMs,
    eligibleAt: eligibility.modes[mode].eligibleAt, trigger: "admin_only" as const,
    account: { ...eligibility.account }, evidence: { ...eligibility.evidence } };
}
