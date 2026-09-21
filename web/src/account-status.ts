import type { AccountSummary } from "../../src/shared/types";

type AccountStatus = Pick<AccountSummary, "lifecycleStatus" | "deactivationLocked" | "identityStatus">;

function isDeactivated(item: AccountStatus): boolean {
  return item.deactivationLocked || item.lifecycleStatus === "deactivated";
}

function isOperationallyActive(item: AccountStatus): boolean {
  return ["active", "third_party_registered"].includes(item.lifecycleStatus) && !item.deactivationLocked;
}

export function lifecycleLabel(item: AccountStatus): string {
  if (isDeactivated(item)) return "永久停用";
  if (item.lifecycleStatus === "third_party_registered") return "第三方注册";
  if (item.lifecycleStatus === "third_party_pending_recovery") return "第三方待恢复";
  if (item.lifecycleStatus === "quarantined") return item.identityStatus === "conflict" ? "凭证归属冲突" : "归属待核对";
  if (item.lifecycleStatus === "retired") return "历史回收";
  if (item.lifecycleStatus === "deleted") return "已删除";
  return "活跃";
}

export function lifecycleTone(item: AccountStatus): string {
  if (isDeactivated(item)) return "red";
  if (item.lifecycleStatus === "third_party_registered") return "green";
  if (item.lifecycleStatus === "third_party_pending_recovery") return "yellow";
  if (item.lifecycleStatus === "quarantined") return "yellow";
  if (item.lifecycleStatus === "retired" || item.lifecycleStatus === "deleted") return "gray";
  return "green";
}

// Restore the original V2 row semantics: confirmed deactivation takes priority
// over Plus. Provider, payment channel and manual markColor are independent.
export function accountRowStatusClass(item: AccountStatus & Pick<AccountSummary, "plan">): string {
  if (isDeactivated(item)) return "deactivated";
  if (isOperationallyActive(item) && String(item.plan || "").trim().toLowerCase() === "plus") return "plus-account";
  return "";
}

export function promotionCheckUnavailableReason(
  item: Pick<AccountSummary, "plan" | "lifecycleStatus" | "deactivationLocked">,
): string {
  if (!["active", "third_party_registered"].includes(item.lifecycleStatus) || item.deactivationLocked) {
    return "账号已停用，无需检测优惠";
  }
  if (String(item.plan || "").toLowerCase() === "plus") return "Plus 已开通，无需检测优惠";
  return "";
}
