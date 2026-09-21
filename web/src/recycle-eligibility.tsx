import React from "react";
import type { RecycleEligibility } from "../../src/shared/types";

export const recycleModeLabels = {
  deactivated: "停用账号回收", untagged_free: "Free 无标记回收", invalid_at: "失效 AT 回收", alias_rotate: "注册别名轮换",
} as const;
export type RecycleMode = keyof typeof recycleModeLabels;

export function recycleConfirmationMessage(mode: RecycleMode, email: string): string {
  return `确认对 ${email} 执行“${recycleModeLabels[mode]}”？\n回收将撤销原客户链接和会话，并建立独立的新邮箱身份。\n仅管理员确认后执行，达到条件不会自动回收。`;
}

interface Props {
  data: RecycleEligibility | null;
  loading: boolean;
  busy: boolean;
  readOnly: boolean;
  error: string;
  formatTime: (value: string) => string;
  onRefresh: () => void;
  onExecute: (mode: RecycleMode) => void;
}

export function RecycleEligibilityPanel({ data, loading, busy, readOnly, error, formatTime, onRefresh, onExecute }: Props) {
  return <div className="detail-group-body recycle-eligibility-panel">
    <p className="recycle-confirmation-note">仅管理员确认后执行，达到条件不会自动回收；回收将撤销原客户链接和会话。</p>
    <div className="recycle-eligibility-toolbar"><small>{data ? `核对时间：${formatTime(data.checkedAt)}（北京时间）` : "展开后读取本地资格"}</small>
      <button disabled={loading || busy} onClick={onRefresh}>{loading ? "正在核对资格…" : "刷新资格"}</button></div>
    {error && <p role="alert" className="error">{error}</p>}
    {data && <div className="recycle-audit-summary">
      <span>回收代次：{data.generation} / {data.maxGeneration}</span>
      <span>客户状态：{data.account.customerOpened ? "已使用邮箱" : data.account.sold ? "已售未使用" : "未售未使用"}</span>
      <span>封禁时间：{data.account.deactivatedAt ? formatTime(data.account.deactivatedAt) : data.account.deactivationLocked ? "待核实" : "未封禁"}</span>
      <span>套餐证据：{data.evidence.tokenPlan || "unknown"}{data.evidence.hasPlusEvidence ? " · 存在 Plus 证据" : ""}</span>
      <span>邮件检查：{data.evidence.mailVerifiedNoPlus ? "已确认无 Plus 证据" : "尚无完整无 Plus 证据"}</span>
      <span>特殊标记：{data.evidence.specialMarkerCount} 项</span>
    </div>}
    <div className="recycle-mode-grid">{Object.entries(recycleModeLabels).map(([key, label]) => {
      const mode = key as RecycleMode;
      const state = data?.modes[mode];
      const disabled = readOnly || loading || busy || Boolean(error) || !state?.eligible;
      return <article key={mode} className="recycle-mode-card" data-recycle-mode={mode}>
        <header><strong>{label}</strong><span className={`badge ${state?.eligible ? "green" : "yellow"}`}>{state ? state.eligible ? "符合条件" : "暂不可回收" : "待核对"}</span></header>
        <p className="recycle-mode-reason">{state?.reason || (state?.eligible ? "条件已满足，等待管理员确认" : loading ? "正在读取资格…" : "尚未读取资格")}</p>
        {state?.eligibleAt && <small>时间门槛：{formatTime(state.eligibleAt)}（北京时间）</small>}
        {readOnly && <small>当前后台只读，不能执行回收</small>}
        <button className={mode === "deactivated" ? "danger" : ""} disabled={disabled}
          title={readOnly ? "当前后台只读" : state?.reason || "需要管理员确认"} onClick={() => onExecute(mode)}>{busy ? "正在处理…" : label}</button>
      </article>;
    })}</div>
  </div>;
}
