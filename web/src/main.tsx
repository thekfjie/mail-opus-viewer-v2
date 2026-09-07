import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AtSign,
  Ban,
  Bot,
  Cloud,
  ChevronDown,
  ClipboardCopy,
  FileChartColumn,
  FileUp,
  Globe2,
  Layers3,
  LogOut,
  Mail,
  Moon,
  MoreHorizontal,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Sun,
  TriangleAlert,
  UserRound,
  Workflow,
} from "lucide-react";
import type {
  AccountDetail,
  AccountSummary,
  CheckRouteSummary,
  PaymentEligibilityApiSummary,
  PaymentExposureJobStatus,
  PaymentExposureRoute,
} from "../../src/shared/types";
import {
  adminLoadStatusText,
  beginAdminLoad,
  completeAdminLoad,
  failAdminLoad,
  idleAdminLoadState,
  markAdminListReady,
  type AdminLoadTrigger,
} from "./load-state";
import "./styles.css";

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && options.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 ${response.status}`);
  return data as T;
}

function settled<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then((value) => ({ value }), (error) => ({ error }));
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

interface CopyReceipt { characters: number; bytes: number; method: "clipboard" | "fallback"; }
interface CopyFeedbackState { kind: "success" | "error"; title: string; message: string; text: string; }
type CopyHandler = (title: string, text: string, extra?: string) => Promise<void>;

async function copyText(value: string): Promise<CopyReceipt> {
  const complete = String(value ?? "");
  if (!complete.length) throw new Error("没有可复制的内容");
  const receipt = (method: CopyReceipt["method"]): CopyReceipt => ({
    method,
    characters: complete.length,
    bytes: new TextEncoder().encode(complete).length,
  });
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(complete);
      return receipt("clipboard");
    } catch {
      // Some embedded/mobile browsers expose the API but reject the write.
      // Continue to the complete textarea fallback rather than losing data.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = complete;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(0, complete.length);
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("浏览器阻止了剪贴板写入");
  return receipt("fallback");
}

function joinCopyBlocks(values: string[]): string {
  return values.map((value) => String(value ?? "")).filter(Boolean).join("\n\n──────────\n\n");
}

function CopyFeedbackToast({ feedback, onClose, onPreview }: {
  feedback: CopyFeedbackState | null;
  onClose: () => void;
  onPreview: () => void;
}) {
  if (!feedback) return null;
  return <div className={`copy-feedback ${feedback.kind}`} role={feedback.kind === "success" ? "status" : "alert"} aria-live="assertive">
    <span className="copy-feedback-icon">{feedback.kind === "success" ? "✓" : "!"}</span>
    <div><strong>{feedback.title}</strong><p>{feedback.message}</p></div>
    {feedback.text && <button onClick={onPreview}>查看完整内容</button>}
    <button className="copy-feedback-close" aria-label="关闭复制提示" onClick={onClose}>×</button>
  </div>;
}

function CopyPreviewDialog({ text, onClose, onCopyAgain }: { text: string; onClose: () => void; onCopyAgain: () => void }) {
  return <div className="copy-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="copy-preview-dialog" role="dialog" aria-modal="true" aria-label="完整复制内容">
      <header><div><strong>完整复制内容</strong><small>{text.length} 个字符，内容不会省略</small></div><button aria-label="关闭完整内容" onClick={onClose}>×</button></header>
      <textarea readOnly value={text} onFocus={(event) => event.currentTarget.select()} aria-label="完整复制文本" />
      <footer><button onClick={onClose}>关闭</button><button className="primary" onClick={onCopyAgain}>再次完整复制</button></footer>
    </section>
  </div>;
}

const BEIJING_TIME_ZONE = "Asia/Shanghai";

function fmt(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
      timeZone: BEIJING_TIME_ZONE,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(date)
    : value;
}

function fmtBeijing(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
      timeZone: BEIJING_TIME_ZONE, month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date)
    : value;
}

function Badge({ tone = "neutral", children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

const paymentMethodLabels: Record<string, string> = {
  ideal: "iDEAL",
  paypal: "PayPal",
  gcash: "GCash",
  gopay: "GoPay",
  blik: "BLIK",
  momo: "MoMo",
  kakao: "Kakao Pay",
  upi: "UPI",
  pix: "PIX",
  twint: "TWINT",
};
const trialStatusLabels: Record<string, string> = {
  observed: "已发现试用",
  eligible: "可试用",
  ineligible: "不可试用",
  unknown: "试用未知",
};
const markColorLabels: Record<string, string> = {
  yellow: "黄",
  orange: "橙",
  green: "绿",
  blue: "蓝",
  purple: "紫",
  gray: "灰",
  red: "红",
};
const billingChannelLabels: Record<string, string> = {
  "us-paypal": "美区 PP",
  "eu-ideal": "欧洲 iDEAL",
  "uk-paypal": "英国 PP",
  "de-paypal": "德国 PP",
  "th-paypal": "泰国 PP",
  "ph-card": "菲律宾直卡",
  "ph-gcash": "菲律宾 GCash",
  "id-gopay": "印尼 GoPay",
  "br-paypal": "巴西 PP",
  "br-pix": "巴西 PIX",
  "in-upi": "印度 UPI",
  "vn-momo": "越南 MoMo",
  "ch-twint": "瑞士 TWINT",
  "kr-kakao": "韩国 KAKAO",
  "pl-blik": "波兰 BLIK",
};
const billingChannelBadgeLabels: Record<string, string> = {
  "us-paypal": "美区 PP",
  "eu-ideal": "欧洲 iDEAL",
  "uk-paypal": "英国 PP",
  "de-paypal": "德国 PP",
  "th-paypal": "泰国 PP",
  "ph-card": "菲律宾直卡",
  "ph-gcash": "GCash",
  "id-gopay": "GoPay",
  "br-paypal": "巴西 PP",
  "br-pix": "PIX",
  "in-upi": "UPI",
  "vn-momo": "MOMO",
  "ch-twint": "TWINT",
  "kr-kakao": "KAKAO",
  "pl-blik": "BLIK",
};
const billingChannelFilterOptions = [
  ["eu-ideal", "欧洲 iDEAL"],
  ["us-paypal", "美区 PP"],
  ["uk-paypal", "英国 PP"],
  ["de-paypal", "德国 PP"],
  ["th-paypal", "泰国 PP"],
  ["br-paypal", "巴西 PP"],
  ["br-pix", "巴西 PIX"],
  ["ph-card", "菲律宾直卡"],
  ["ph-gcash", "菲律宾 GCash"],
  ["id-gopay", "印尼 GoPay"],
  ["in-upi", "印度 UPI"],
  ["vn-momo", "越南 MoMo"],
  ["ch-twint", "瑞士 TWINT"],
  ["kr-kakao", "韩国 KAKAO"],
  ["pl-blik", "波兰 BLIK"],
  ["unknown", "渠道待确认"],
] as const;

function paymentMethodLabel(value: string): string {
  const normalized = String(value || "").toLowerCase();
  return paymentMethodLabels[normalized] || value || "—";
}

function lifecycleEventLabel(value: string): string {
  if (value === "email_rebind_notice_detected") return "检测到换绑邮件";
  if (value === "email_binding_changed") return "邮箱绑定已变更";
  if (value === "email_binding_imported") return "导入邮箱绑定";
  if (value === "recycled_mailbox_identity_observed") return "复用邮箱按 OpenAI 身份归代";
  if (value === "promotion_suspicion_changed") return "优惠存疑标记已调整";
  if (value === "promotion_suspicion_changed") return "优惠存疑标记已调整";
  return value;
}

function relationTypeLabel(value: string): string {
  if (value === "email_rebind") return "同一 GPT 的邮箱换绑";
  if (value === "mailbox_recycle") return "回收后新建 GPT 身份";
  return value;
}

function associationMethodLabel(value: string): string {
  if (value === "legacy_explicit_rebind") return "明确换绑任务";
  if (value === "openai_identity_evidence") return "OpenAI 身份一致";
  if (value === "legacy_recycle_chain") return "回收链（身份隔离）";
  if (value === "recycled_mailbox_identity") return "共享邮箱按 OpenAI 身份归代";
  return value;
}

function trialStatusLabel(value: string): string {
  return trialStatusLabels[String(value || "unknown").toLowerCase()] || "试用未知";
}

function trialStatusTone(value: string): string {
  switch (String(value || "unknown").toLowerCase()) {
    case "observed": return "purple";
    case "eligible": return "green";
    case "ineligible": return "gray";
    default: return "yellow";
  }
}

function markColorLabel(value: string): string {
  return markColorLabels[String(value || "").toLowerCase()] || "无标记";
}

function markColorTone(value: string): string {
  const normalized = String(value || "").toLowerCase();
  return ["yellow", "orange", "green", "blue", "purple", "gray", "red"].includes(normalized) ? normalized : "gray";
}

function MarkPalette({ value, disabled, saving, label, onSelect }: { value: string; disabled: boolean; saving?: boolean; label: string; onSelect: (color: string) => void }) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const select = (color: string) => {
    menuRef.current?.removeAttribute("open");
    onSelect(color);
  };
  return <details ref={menuRef} className={`mark-palette ${saving ? "is-saving" : ""}`} onClick={(event) => event.stopPropagation()}>
    <summary title={saving ? "颜色已更新，正在后台保存" : value ? `${markColorLabel(value)}标记；点击更改` : "设置颜色标记"} aria-label={`${label} 颜色标记`}>
      <span className={`mark-dot ${value || "mark-none"}`} /><ChevronDown size={11} />
    </summary>
    <div className="mark-palette-panel" role="group" aria-label="选择颜色">
      {Object.keys(markColorLabels).map((color) => <button
        type="button"
        key={color}
        className={`mark-swatch ${color} ${value === color ? "selected" : ""}`}
        disabled={disabled}
        title={`标记为${markColorLabel(color)}`}
        aria-label={`标记为${markColorLabel(color)}`}
        aria-pressed={value === color}
        onClick={() => select(color)}
      />)}
      <button type="button" className="mark-clear" disabled={disabled || !value} title="清除颜色标记" aria-label="清除颜色标记" onClick={() => select("")}>×</button>
    </div>
  </details>;
}

function billingChannelLabel(value: string): string {
  return billingChannelLabels[String(value || "").toLowerCase()] || value || "—";
}

function billingChannelBadgeLabel(value: string): string {
  const normalized = String(value || "").toLowerCase();
  return billingChannelBadgeLabels[normalized] || billingChannelLabel(value);
}

function planBadgeLabel(item: Pick<AccountSummary, "plan" | "billingChannel">): string {
  if (item.billingChannel) return billingChannelBadgeLabel(item.billingChannel);
  return String(item.plan || "").toLowerCase() === "plus" ? "PLUS" : "FREE";
}

function planBadgeClassName(item: Pick<AccountSummary, "plan" | "billingChannel">): string {
  if (item.billingChannel) return `plan-badge channel ${String(item.billingChannel).toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
  return `plan-badge ${String(item.plan || "").toLowerCase() === "plus" ? "plus" : "free"}`;
}

// Keep a Plus account's missing payment evidence visible instead of silently
// dropping the channel line from the table and account detail.
function billingChannelStatus(item: Pick<AccountSummary, "plan" | "billingChannel">): string {
  if (item.billingChannel) return `渠道：${billingChannelLabel(item.billingChannel)}`;
  return String(item.plan || "").toLowerCase() === "plus" ? "渠道待确认" : "";
}

function billingChannelStatusTone(item: Pick<AccountSummary, "plan" | "billingChannel">): string {
  return item.billingChannel ? "blue" : "yellow";
}

function paymentExposureTone(status: string, exposed = false): string {
  if (status !== "complete") return "yellow";
  return exposed ? "green" : "gray";
}

function paymentExposureLabel(status: string, exposed = false): string {
  if (status !== "complete") return "未知";
  return exposed ? "有资格" : "无资格";
}

function accountExposureLabel(item: AccountSummary): string {
  switch (item.paymentExposureStatus) {
    case "exposed": return `有资格 ${item.paymentExposureExposedCount}`;
    case "not_exposed": return "无资格";
    case "partial": return `部分完成 ${item.paymentExposureExposedCount}/${item.paymentExposureCount}`;
    case "unknown": return "结果未知";
    default: return "未检查";
  }
}

function exposureJobStatusLabel(value: string): string {
  switch (String(value || "").toLowerCase()) {
    case "queued": return "排队中";
    case "running": return "检测中";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
    case "interrupted": return "已中断";
    default: return "状态未知";
  }
}

function exposureJobStatusTone(value: string): string {
  switch (String(value || "").toLowerCase()) {
    case "completed": return "green";
    case "failed":
    case "cancelled":
    case "interrupted": return "red";
    case "running": return "blue";
    default: return "yellow";
  }
}

function lifecycleLabel(item: AccountSummary): string {
  if (item.deactivationLocked) return "永久停用";
  if (item.lifecycleStatus === "quarantined") return item.identityStatus === "conflict" ? "凭证归属冲突" : "归属待核对";
  if (item.lifecycleStatus === "retired") return "历史回收";
  return "活跃";
}

function lifecycleTone(item: AccountSummary): string {
  if (item.deactivationLocked) return "red";
  if (item.lifecycleStatus === "quarantined") return "yellow";
  if (item.lifecycleStatus === "retired") return "gray";
  return "green";
}

function providerLabel(value: string): string {
  const provider = String(value || "").toLowerCase();
  if (provider === "icloud") return "iCloud";
  if (provider === "outlook") return "Outlook";
  if (provider === "domain") return "域名邮箱";
  return value || "未知邮箱";
}

function promotionCampaignLabel(value: string): string {
  const labels: Record<string, string> = {
    "plus-1-month-free": "Plus · 1 个月免费",
    "plus-2-months-50-pct-off": "Plus · 2 个月五折",
    "go-1-month-free": "Go · 1 个月免费",
    "go-3-months-50-pct-off": "Go · 3 个月五折",
  };
  return labels[value] || value;
}

function promotionCampaignCompactLabel(value: string): string {
  const labels: Record<string, string> = {
    "plus-1-month-free": "Plus 1月免费",
    "plus-2-months-50-pct-off": "Plus 2月五折",
    "go-1-month-free": "Go 1月免费",
    "go-3-months-50-pct-off": "Go 3月五折",
  };
  return labels[value] || value;
}

function promotionCampaignClass(value: string): string {
  const id = String(value || "").toLowerCase();
  return id.startsWith("plus-") ? "plus" : id.startsWith("go-") ? "go" : "other";
}

function promotionCheckActive(status: string): boolean {
  return ["queued", "running", "dispatching"].includes(String(status || ""));
}

function promotionCheckUnavailableReason(item: Pick<AccountSummary, "plan" | "lifecycleStatus" | "deactivationLocked">): string {
  if (item.lifecycleStatus !== "active" || item.deactivationLocked) return "账号已停用，无需检测优惠";
  if (String(item.plan || "").toLowerCase() === "plus") return "Plus 已开通，无需检测优惠";
  return "";
}

function PromotionStatusCell({ item }: { item: AccountSummary }) {
  const unavailableReason = promotionCheckUnavailableReason(item);
  if (unavailableReason) return <>
    <div><span className="status-led gray" /><strong>无需检测</strong></div>
    <small>{unavailableReason}</small>
  </>;
  const active = promotionCheckActive(item.promotionCheckStatus);
  const campaigns = item.promoSuspicious ? item.historicalPromoCampaigns : item.promoCampaigns;
  if (active) return <>
    <div><span className="status-led blue pulse" /><strong>优惠检测中</strong></div>
    {campaigns.length > 0 && <div className="promotion-tag-list previous">{campaigns.map((campaign) => <span className={`promotion-tag ${promotionCampaignClass(campaign)}`} title={`上次记录：${campaign}`} key={campaign}>{promotionCampaignCompactLabel(campaign)}</span>)}</div>}
    <small>{item.promotionCheckStatus === "running" ? "正在通过 JP 出口读取优惠目录" : "已排队，马上开始"}</small>
  </>;
  if (item.promoSuspicious) return <>
    <div><span className="status-led yellow" /><strong className="promotion-suspicious-text">优惠存疑</strong></div>
    {item.historicalPromoCampaigns.length > 0 && <div className="promotion-tag-list previous">{item.historicalPromoCampaigns.map((campaign) => <span className={`promotion-tag ${promotionCampaignClass(campaign)}`} title={`历史曾检测到：${campaign}`} key={campaign}>{promotionCampaignCompactLabel(campaign)}</span>)}</div>}
    <small>{item.promoSuspiciousOverride ? `人工标记可能已掉优惠${item.trialCheckedAt ? ` · ${fmt(item.trialCheckedAt)}` : ""}` : item.trialCheckedAt ? `本次无优惠 · ${fmt(item.trialCheckedAt)}` : "历史有优惠，本次未返回"}</small>
  </>;
  if (item.promotionCheckStatus === "retry_wait") return <>
    <div><span className="status-led yellow" /><strong>检测待复查</strong></div>
    <small title={item.promotionCheckErrorDetail}>{item.promotionCheckErrorDetail || "接口暂未形成权威结论"}{item.promotionCheckNextRetryAt ? ` · ${fmt(item.promotionCheckNextRetryAt)} 重试` : " · 将自动重试"}</small>
  </>;
  if (item.promoEligible === true) return <>
    <div><span className="status-led green" /><strong>{item.promoCampaigns.length ? `${item.promoCampaigns.length} 项优惠` : "优惠可用"}</strong></div>
    {item.promoCampaigns.length > 0 && <div className="promotion-tag-list">{item.promoCampaigns.map((campaign) => <span className={`promotion-tag ${promotionCampaignClass(campaign)}`} title={campaign} key={campaign}>{promotionCampaignCompactLabel(campaign)}</span>)}</div>}
    <small>{item.trialCheckedAt ? `检测 ${fmt(item.trialCheckedAt)}` : "已取得优惠结果"}</small>
  </>;
  return <>
    <div><span className={`status-led ${item.promoEligible === false ? "gray" : "yellow"}`} /><strong>{item.promoEligible === false ? "暂无优惠" : item.trialStatus !== "unknown" ? trialStatusLabel(item.trialStatus) : "待检测"}</strong></div>
    <small>{item.autoTrialStatus !== "not_scheduled" ? `自动检测：${exposureJobStatusLabel(item.autoTrialStatus)}` : item.autoTrialDueAt ? `计划 ${fmt(item.autoTrialDueAt)}` : "暂无检测结果"}</small>
  </>;
}

function PaymentExposureSection({
  accountId,
  checks,
  promotion,
  promoSuspicious,
  promoSuspiciousOverride,
  historicalPromoCampaigns,
  promotionCheckStatus,
  autoTrialStatus,
  autoTrialDueAt,
  plan,
  lifecycleStatus,
  deactivationLocked,
  readOnly,
  onRefresh,
}: {
  accountId: string;
  checks: AccountDetail["paymentExposureChecks"];
  promotion: AccountDetail["promotion"];
  promoSuspicious: boolean;
  promoSuspiciousOverride: boolean;
  historicalPromoCampaigns: string[];
  promotionCheckStatus: string;
  autoTrialStatus: string;
  autoTrialDueAt: string;
  plan: string;
  lifecycleStatus: string;
  deactivationLocked: boolean;
  readOnly: boolean;
  onRefresh: () => void | Promise<void>;
}) {
  const [routes, setRoutes] = useState<PaymentExposureRoute[]>([]);
  const [promotionRoute, setPromotionRoute] = useState<CheckRouteSummary | null>(null);
  const [eligibilityApi, setEligibilityApi] = useState<PaymentEligibilityApiSummary | null>(null);
  const [selectedRoute, setSelectedRoute] = useState("");
  const [job, setJob] = useState<PaymentExposureJobStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [trialStarting, setTrialStarting] = useState(false);
  const [suspicionSaving, setSuspicionSaving] = useState(false);
  const [promotionTask, setPromotionTask] = useState<Record<string, any> | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [configProxy, setConfigProxy] = useState("");
  const [configSaving, setConfigSaving] = useState(false);
  const [eligibilityConfigOpen, setEligibilityConfigOpen] = useState(false);
  const [eligibilityEndpoint, setEligibilityEndpoint] = useState("");
  const [eligibilityApiToken, setEligibilityApiToken] = useState("");
  const [eligibilitySaving, setEligibilitySaving] = useState(false);
  const [eligibilityConfigFeedback, setEligibilityConfigFeedback] = useState("");
  const [error, setError] = useState("");

  const applyRouteData = (data: { routes?: PaymentExposureRoute[]; promotionRoute?: CheckRouteSummary; checkRoutes?: CheckRouteSummary[]; eligibilityApi?: PaymentEligibilityApiSummary }) => {
    const nextRoutes = Array.isArray(data.routes) ? data.routes : [];
    const nextCheckRoutes = Array.isArray(data.checkRoutes) ? data.checkRoutes : [];
    setRoutes(nextRoutes);
    setPromotionRoute(data.promotionRoute || nextCheckRoutes.find((route) => route.key === "promotion_jp") || null);
    setEligibilityApi(data.eligibilityApi || null);
    setEligibilityEndpoint(data.eligibilityApi?.endpoint || "");
    setSelectedRoute((current) => nextRoutes.some((route) => route.key === current && route.configured)
      ? current : "");
  };

  const refreshRoutes = async () => {
    const data = await api<{ routes: PaymentExposureRoute[]; promotionRoute: CheckRouteSummary; checkRoutes: CheckRouteSummary[]; eligibilityApi: PaymentEligibilityApiSummary }>("/api/v2/admin/payment-exposure/routes");
    applyRouteData(data);
  };

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setJob(null); setError("");
    api<{ routes: PaymentExposureRoute[]; promotionRoute: CheckRouteSummary; checkRoutes: CheckRouteSummary[]; eligibilityApi: PaymentEligibilityApiSummary }>("/api/v2/admin/payment-exposure/routes", { signal: controller.signal })
      .then((data) => {
        if (!active) return;
        applyRouteData(data);
      })
      .catch((reason) => { if (active && !isAbortError(reason)) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; controller.abort(); };
  }, [accountId]);

  useEffect(() => {
    if (!job?.jobId || ["completed", "failed", "cancelled", "interrupted"].includes(job.status)) return;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let consecutiveFailures = 0;
    let polling = false;
    const schedule = (delay: number) => {
      if (!active) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (!active || polling) return;
      polling = true;
      controller = new AbortController();
      try {
        const next = await api<PaymentExposureJobStatus>(`/api/v2/admin/accounts/${accountId}/payment-exposure-check/${encodeURIComponent(job.jobId)}`, { signal: controller.signal });
        if (!active) return;
        consecutiveFailures = 0; setError("");
        setJob(next);
        if (["completed", "failed", "cancelled", "interrupted"].includes(next.status)) {
          await onRefresh();
          return;
        }
        schedule(1500);
      } catch (reason) {
        if (active && !isAbortError(reason)) {
          consecutiveFailures += 1;
          const delay = Math.min(10_000, 1500 * (2 ** Math.min(consecutiveFailures - 1, 3)));
          setError(`状态连接中断，${Math.ceil(delay / 1000)} 秒后自动重连`);
          schedule(delay);
        }
      } finally {
        polling = false;
      }
    };
    const reconnect = () => { consecutiveFailures = 0; schedule(0); };
    window.addEventListener("online", reconnect);
    void poll();
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("online", reconnect);
    };
  }, [accountId, job?.jobId]);

  useEffect(() => {
    const taskId = String(promotionTask?.id || "");
    if (!taskId || !promotionCheckActive(String(promotionTask?.status || ""))) return;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    const terminal = new Set(["completed", "credential_invalid", "failed", "cancelled", "interrupted", "retry_wait"]);
    const poll = async () => {
      controller = new AbortController();
      try {
        const next = await api<Record<string, any>>(`/api/v2/admin/accounts/${accountId}/promotion-check/${encodeURIComponent(taskId)}`, { signal: controller.signal });
        if (!active) return;
        setPromotionTask(next);
        await onRefresh();
        if (!terminal.has(String(next.status || ""))) timer = window.setTimeout(() => void poll(), 1200);
      } catch (reason) {
        if (active && !isAbortError(reason)) {
          setError(reason instanceof Error ? reason.message : String(reason));
          timer = window.setTimeout(() => void poll(), 3000);
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 400);
    return () => { active = false; controller?.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [accountId, promotionTask?.id]);

  const selected = routes.find((route) => route.key === selectedRoute);
  const jobRunning = Boolean(job && !["completed", "failed", "cancelled", "interrupted"].includes(job.status));
  const promotionRunning = promotionCheckActive(String(promotionTask?.status || promotionCheckStatus));
  const start = async () => {
    if (!selected?.configured || starting || jobRunning) return;
    setStarting(true); setError("");
    try {
      const next = await api<PaymentExposureJobStatus>(`/api/v2/admin/accounts/${accountId}/payment-exposure-check`, {
        method: "POST", body: JSON.stringify({ routeKey: selected.key }),
      });
      setJob(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStarting(false);
    }
  };
  const startTrial = async () => {
    if (trialStarting || promotionRunning) return;
    setTrialStarting(true); setError("");
    try {
      const next = await api<Record<string, any>>(`/api/v2/admin/accounts/${accountId}/trial-check`, { method: "POST" });
      setPromotionTask(next);
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTrialStarting(false);
    }
  };
  const toggleSuspicion = async () => {
    if (readOnly || suspicionSaving) return;
    setSuspicionSaving(true); setError("");
    try {
      await api(`/api/v2/admin/accounts/${accountId}/promotion-suspicion`, {
        method: "POST", body: JSON.stringify({ suspicious: !promoSuspiciousOverride }),
      });
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSuspicionSaving(false);
    }
  };
  const saveRoute = async () => {
    if (!configProxy.trim() || configSaving) return;
    setConfigSaving(true); setError("");
    try {
      await api("/api/v2/admin/payment-exposure/routes/promotion_jp", {
        method: "PUT", body: JSON.stringify({ proxy: configProxy.trim() }),
      });
      setConfigProxy("");
      await refreshRoutes();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConfigSaving(false);
    }
  };
  const resetRoute = async () => {
    if (configSaving) return;
    setConfigSaving(true); setError("");
    try {
      await api("/api/v2/admin/payment-exposure/routes/promotion_jp", { method: "DELETE" });
      setConfigProxy("");
      await refreshRoutes();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConfigSaving(false);
    }
  };
  const saveEligibilityApiConfig = async () => {
    if (!eligibilityEndpoint.trim() || eligibilitySaving) return;
    setEligibilitySaving(true); setError(""); setEligibilityConfigFeedback("");
    try {
      const body: Record<string, string> = { endpoint: eligibilityEndpoint.trim() };
      if (eligibilityApiToken.trim()) body.apiToken = eligibilityApiToken.trim();
      const saved = await api<{ eligibilityApi: PaymentEligibilityApiSummary }>("/api/v2/admin/payment-exposure/api", {
        method: "PUT", body: JSON.stringify(body),
      });
      setEligibilityApi(saved.eligibilityApi);
      setEligibilityEndpoint(saved.eligibilityApi.endpoint);
      setEligibilityApiToken("");
      await refreshRoutes();
      setEligibilityConfigFeedback("资格接口配置已保存");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setEligibilitySaving(false);
    }
  };
  const resetEligibilityApiConfig = async () => {
    if (eligibilitySaving) return;
    setEligibilitySaving(true); setError(""); setEligibilityConfigFeedback("");
    try {
      const reset = await api<{ eligibilityApi: PaymentEligibilityApiSummary }>("/api/v2/admin/payment-exposure/api", { method: "DELETE" });
      setEligibilityApi(reset.eligibilityApi);
      setEligibilityEndpoint(reset.eligibilityApi.endpoint);
      setEligibilityApiToken("");
      await refreshRoutes();
      setEligibilityConfigFeedback("已恢复系统默认接口配置");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setEligibilitySaving(false);
    }
  };
  const revealEligibilityApiConfig = async () => {
    if (eligibilitySaving) return;
    setEligibilitySaving(true); setError(""); setEligibilityConfigFeedback("");
    try {
      const revealed = await api<{ endpoint: string; apiToken: string }>("/api/v2/admin/payment-exposure/api/reveal");
      setEligibilityEndpoint(revealed.endpoint || "");
      setEligibilityApiToken(revealed.apiToken || "");
      setEligibilityConfigFeedback(revealed.apiToken ? "已读取完整接口地址和令牌" : "已读取完整接口地址；当前未配置令牌");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setEligibilitySaving(false);
    }
  };
  const liveChecks = job?.items.flatMap((item) => item.paymentExposure || []) || [];
  const eligibilityChecks = checks.filter((check) => check.checkoutType === "eligibility_api");
  const evidence = promotion?.evidence && typeof promotion.evidence === "object" ? promotion.evidence as Record<string, any> : {};
  const promotionCampaigns = Array.isArray(evidence.campaigns)
    ? evidence.campaigns.map((item: any) => String(item?.id || "").trim()).filter(Boolean)
    : promotion?.eligible === true && promotion?.campaign ? [String(promotion.campaign)] : [];
  const displayedPromotionCampaigns = promoSuspicious ? historicalPromoCampaigns : promotionCampaigns;
  const promotionUnavailableReason = promotionCheckUnavailableReason({ plan, lifecycleStatus, deactivationLocked });
  return <section className="payment-exposure-section">
    <section className="promotion-detection-panel">
    <div className="payment-exposure-heading"><div><h3>优惠资格</h3><small>{promotionUnavailableReason || "每个新 AT 满 12 小时后仅自动检测一次，固定使用 JP 出口并读取 eligible_promo_campaigns 全部活动；手动或批量可重新检测"}</small></div><Badge tone={promotionUnavailableReason ? "gray" : promotionRunning ? "blue" : promoSuspicious ? "yellow" : promotion?.eligible === true ? "green" : promotion?.eligible === false ? "gray" : "yellow"}>{promotionUnavailableReason ? "无需检测" : promotionRunning ? "检测中" : promoSuspicious ? "优惠存疑" : promotion?.eligible === true ? `${promotionCampaigns.length || 1} 项优惠` : promotion?.eligible === false ? "暂无优惠" : "结果未知"}</Badge></div>
    <div className="promotion-route-row"><span><Badge tone={promotionRoute?.configured ? "green" : "red"}>JP</Badge><strong>优惠检测出口</strong><small className={promotionRoute?.configured ? "route-ready" : "route-missing"}>{promotionRoute?.configured ? `${promotionRoute.addressDisplay || "已配置"} · ${promotionRoute.source === "saved" ? "后台长期配置" : "环境配置"}` : "未配置，检测不会直连"}</small></span><button onClick={() => setConfigOpen((value) => !value)}>{configOpen ? "收起配置" : "管理出口"}</button></div>
    {configOpen && <div className="check-route-editor">
      <input aria-label="长期保存代理出口地址" type="password" autoComplete="off" value={configProxy} onChange={(event) => setConfigProxy(event.target.value)} placeholder="HTTP / HTTPS / SOCKS5 代理地址" />
      <button className="primary" disabled={!configProxy.trim() || configSaving} onClick={() => void saveRoute()}>{configSaving ? "保存中…" : "长期保存"}</button>
      <button disabled={configSaving || promotionRoute?.source !== "saved"} onClick={() => void resetRoute()}>清除后台配置</button>
      <small>代理凭证加密保存在 V2 数据库；登录管理员可查看完整当前地址。清除后会回退到服务器环境配置。</small>
    </div>}
    <div className="promotion-result-row"><span>{promotionRunning ? `进度：${promotionTask?.status === "running" || promotionCheckStatus === "running" ? "正在检测" : "已排队"}` : promoSuspicious ? promoSuspiciousOverride ? "状态：优惠存疑（人工标记可能已掉优惠）" : "状态：优惠存疑（历史有、本次无）" : promotion?.status ? `状态：${String(promotion.status)}` : "尚无权威检测结果"}</span><small>{promotion?.checkedAt ? `检测 ${fmt(String(promotion.checkedAt))}` : autoTrialDueAt ? `计划 ${fmt(autoTrialDueAt)}` : "等待有效 AT"}</small>{promotionTask?.errorDetail && <small className="route-missing">{promotionTask.errorDetail}</small>}</div>
    {displayedPromotionCampaigns.length > 0 && <div className={`promotion-campaign-list ${promoSuspicious ? "previous" : ""}`}><span>{promoSuspicious ? "历史命中" : "可用活动"}</span>{displayedPromotionCampaigns.map((campaign) => <Badge key={campaign} tone={promoSuspicious ? "yellow" : "green"}>{promotionCampaignLabel(campaign)}</Badge>)}</div>}
    <div className="promotion-detection-actions">
      <button className="primary" disabled={Boolean(promotionUnavailableReason || trialStarting || promotionRunning || !promotionRoute?.configured)} title={promotionUnavailableReason} onClick={() => void startTrial()}>{promotionUnavailableReason ? "无需检测" : trialStarting || promotionRunning ? "JP 检测中…" : "立即检测优惠"}</button>
      <button className={promoSuspiciousOverride ? "suspicion-active" : ""} disabled={readOnly || suspicionSaving || promotion?.eligible === true} onClick={() => void toggleSuspicion()}>{suspicionSaving ? "保存中…" : promoSuspiciousOverride ? "取消人工存疑" : "标记可能掉优惠"}</button>
      <div className="payment-exposure-auto-status"><span>自动优惠检测：<Badge tone={autoTrialStatus === "completed" ? "green" : ["queued", "running", "dispatching"].includes(autoTrialStatus) ? "blue" : autoTrialStatus === "failed" ? "red" : "gray"}>{exposureJobStatusLabel(autoTrialStatus === "not_scheduled" ? "unknown" : autoTrialStatus)}</Badge></span>{autoTrialDueAt && <small>首次 AT {fmt(autoTrialDueAt)} 前后执行</small>}</div>
    </div>
    </section>
    <section className="payment-method-panel">
    <div className="payment-exposure-heading payment-method-heading"><div><h3>支付资格接口检测</h3><small>每次只请求一次资格接口；不会创建 Checkout，也不会访问 Stripe 支付流程</small></div><span>{eligibilityChecks.length ? `最近 ${eligibilityChecks.length} 项` : "暂无结果"}</span></div>
    <div className="promotion-route-row"><span><Badge tone={eligibilityApi?.configured ? "green" : "red"}>API</Badge><strong>资格检查接口</strong><small className={eligibilityApi?.configured ? "route-ready" : "route-missing"}>{eligibilityApi?.configured ? `${eligibilityApi.endpoint} · ${eligibilityApi.source === "saved" ? "后台长期配置" : eligibilityApi.source === "default" ? "系统默认" : "环境配置"}${eligibilityApi.hasApiToken ? " · 已配置接口令牌" : ""}` : "未配置"}</small></span><button onClick={() => setEligibilityConfigOpen((value) => !value)}>{eligibilityConfigOpen ? "收起配置" : "管理接口"}</button></div>
    {eligibilityConfigOpen && <div className="check-route-editor eligibility-api-editor">
      <input aria-label="支付资格检查接口地址" type="url" autoComplete="off" value={eligibilityEndpoint} onChange={(event) => setEligibilityEndpoint(event.target.value)} placeholder="https://example.com/api/v1/check" />
      <input aria-label="支付资格检查接口令牌" type="password" autoComplete="off" value={eligibilityApiToken} onChange={(event) => setEligibilityApiToken(event.target.value)} placeholder={eligibilityApi?.hasApiToken ? "留空保留现有接口令牌" : "接口令牌（如接口不需要可留空）"} />
      <button disabled={eligibilitySaving} onClick={() => void revealEligibilityApiConfig()}>读取完整当前配置</button>
      <button className="primary" disabled={!eligibilityEndpoint.trim() || eligibilitySaving} onClick={() => void saveEligibilityApiConfig()}>{eligibilitySaving ? "保存中…" : "长期保存"}</button>
      <button disabled={eligibilitySaving || eligibilityApi?.source !== "saved"} onClick={() => void resetEligibilityApiConfig()}>恢复系统默认</button>
      <small>接口地址和令牌加密落盘；登录管理员可读取完整原文。这里只配置资格 API，不配置支付页。留空令牌会保留已保存值。</small>
      {eligibilityConfigFeedback && <small className="route-ready" role="status">{eligibilityConfigFeedback}</small>}
    </div>}
    <div className="payment-exposure-controls">
      <select aria-label="选择支付资格项目" value={selectedRoute} onChange={(event) => setSelectedRoute(event.target.value)} disabled={starting || jobRunning || !routes.length}>
        {!routes.length && <option value="">正在读取资格项目…</option>}
        {routes.length > 0 && <option value="">选择一个资格项目</option>}
        {routes.map((route) => <option key={route.key} value={route.key} disabled={!route.configured}>{paymentMethodLabel(route.expectedMethod)} · 读取 {route.target}_eligible</option>)}
      </select>
      <button className="primary" disabled={!selected?.configured || starting || jobRunning} onClick={() => void start()}>{starting ? "请求中…" : jobRunning ? "检测进行中…" : "检测所选资格"}</button>
      {selected && <span className={selected.configured ? "route-ready" : "route-missing"}>{selected.configured ? `接口已就绪 · 本次只保存 ${selected.target}_eligible 及原因` : "请先配置资格检查接口"}</span>}
      {!selected && routes.length > 0 && <span className="route-missing">请选择一个要检测的支付资格</span>}
    </div>
    {job && <div className="payment-exposure-job"><div className="payment-exposure-job-heading"><span><Badge tone={exposureJobStatusTone(job.status)}>{exposureJobStatusLabel(job.status)}</Badge><span>{job.route.label}</span></span><small>{job.jobId}</small></div>{job.items.map((item) => <div className="payment-exposure-job-item" key={`${job.jobId}-${item.index}`}><span>资格接口请求</span><span>{item.stage === "eligibility_api" ? "接口读取" : item.stage || item.extractionStatus || "等待阶段"}</span><span>{item.finishedAt ? fmt(item.finishedAt) : "进行中"}</span></div>)}{job.pollError && <small className="route-missing">{job.pollError}</small>}{liveChecks.length > 0 && <div className="payment-exposure-live-methods">{liveChecks.map((check) => <span key={check.id}><Badge tone={paymentExposureTone(check.status, check.exposed)}>{paymentMethodLabel(check.target)} · {paymentExposureLabel(check.status, check.exposed)}</Badge></span>)}</div>}</div>}
    {eligibilityChecks.length ? <div className="payment-exposure-list">{eligibilityChecks.map((check) => <div className="payment-exposure-row" key={check.id}>
      <div className="payment-exposure-target"><strong>{paymentMethodLabel(check.target)}</strong><small>资格字段：{check.target}_eligible</small></div>
      <div><Badge tone={paymentExposureTone(check.status, check.exposed)}>{paymentExposureLabel(check.status, check.exposed)}</Badge><Badge tone="blue">{check.status}</Badge></div>
      <div className="payment-exposure-methods">
        <span>接口资格结果</span>
        <small>{check.detail || (check.status === "complete" ? check.exposed ? "eligible" : "ineligible" : "接口未返回该资格字段")}</small>
      </div>
      <div className="payment-exposure-meta"><span>资格接口</span><time>{fmt(check.observedAt || check.updatedAt)}</time></div>
    </div>)}</div> : <p className="muted">该账号尚未完成支付资格接口检测。</p>}
    </section>
    {error && <div className="payment-exposure-error">{error}</div>}
  </section>;
}

function AdminLogin({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    try { await api("/api/v2/admin/login", { method: "POST", body: JSON.stringify({ password }) }); onDone(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <main className="login-shell"><form className="login-panel" onSubmit={submit}>
    <div className="brand-mark">O</div><h1>Opus Mail V2</h1><p>独立影子后台</p>
    <input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="后台口令" />
    <button className="primary" type="submit">登录</button>{error && <div className="error">{error}</div>}
  </form></main>;
}

interface Overview {
  accounts: number; active: number; deactivated: number; retired: number; quarantined: number; sold: number; domains: number; unused: number; recovered: number;
  visibleAccounts: number; visibleActive: number; visibleDomains: number; visibleUnused: number; internalPending: number; actionableMissingAt: number;
  visibleIcloud: number; visibleAuto: number; visibleOutlookFree: number;
  deactivatedToday: number; deactivatedThreeDays: number; deactivatedSevenDays: number; deactivatedThirtyDays: number;
  v1SourceRecords: number; readOnly: boolean; latestSync?: { status: string; finished_at: string; binding_count: number; relation_count: number };
  nativeReadOnly?: boolean; commandWriter?: "v1" | "v1-via-v2" | "v2"; accountAuthority?: "v1" | "v2"; independent?: boolean;
  latestSub2Sync?: { status: string; finished_at: string; active_openai_count: number; matched_count: number; created_count: number; skipped_count: number };
}

interface RedGroup { boundaryAccountId: string; boundaryEmail: string; startedAt: string; endedAt: string; count: number; deactivatedCount: number; activeCount: number; }
interface PendingReview { id: string; reviewType: string; accountId: string; candidateEmail: string; reason: string; createdAt: string; }
interface CurrentCustomerExport { currentEmail: string; loginIdentifier: string; publicUrl: string; text: string; }
interface BulkCurrentExport extends CurrentCustomerExport { id: string; available: boolean; reason?: string; }
interface BulkCredential { id: string; primaryEmail: string; accessToken: string; }
interface ReleaseInfo { gitCommit?: string; builtAt?: string; artifactSha256?: string; frontendEntry?: string; }
interface PromotionJobState { id: string; accountId: string; status: string; errorDetail?: string; }
interface PromotionBatchProgress {
  total: number;
  processed: number;
  queued: number;
  running: number;
  retrying: number;
  failed: number;
  status: "running" | "completed" | "error";
}
const PAGE_SIZE = 24;
const DEFAULT_ACCOUNT_FILTERS = {
  search: "", range: "all", status: "", provider: "", billingChannel: "", sold: "", plan: "", credential: "",
  sourceStatus: "", unused: "", redGroup: "", markColor: "", pending: "exclude", workbench: "", deactivationWindow: "",
};

function OutlookFreeWorkbench() {
  const [data, setData] = useState<Record<string, any> | null>(null);
  const [mailbox, setMailbox] = useState("");
  const [mails, setMails] = useState<any[]>([]);
  const [mail, setMail] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = async (refresh = false) => {
    setLoading(true); setError("");
    try {
      const next = refresh
        ? await api<Record<string, any>>("/api/v2/admin/outlook-free/refresh", { method: "POST", body: "{}" })
        : await api<Record<string, any>>("/api/v2/admin/outlook-free");
      setData(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const openMailbox = async (email: string) => {
    setMailbox(email); setMail(null); setError("");
    try {
      const next = await api<{ results: any[] }>(`/api/v2/admin/outlook-free/mails?email=${encodeURIComponent(email)}&limit=20&offset=0`);
      setMails(next.results || []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const openMail = async (item: any) => {
    setError("");
    try {
      const params = new URLSearchParams({ email: mailbox, id: String(item.detailId || item.id || ""), folder: String(item.folder || "inbox"), method: String(item.detailMethod || "graph"), idMode: String(item.detailIdMode || "") });
      const next = await api<any>(`/api/v2/admin/outlook-free/mail-detail?${params}`);
      setMail(next.mail || null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <section className="report-panel workbench-panel">
    <header className="workbench-heading"><div><h2>Outlook Free 号池</h2><p className="muted">已开通 GPT、尚未进入账号库的 Outlook 邮箱</p></div><button disabled={loading} onClick={() => void load(true)}><RefreshCw size={16} className={loading ? "spin" : ""} />刷新号池</button></header>
    {error && <div className="error">{error}</div>}
    {data && <div className="workbench-stats"><Badge tone="blue">共 {data.total || 0}</Badge><Badge tone="green">Free 活跃 {data.freeActive || 0}</Badge><Badge tone="yellow">Free 停用 {data.freeDeactivated || 0}</Badge><Badge tone="purple">Plus {data.plus || 0}</Badge><small>扫描 {fmt(data.scannedAt || "")}</small></div>}
    <div className="outlook-workbench-layout"><div className="outlook-pool-list">{(data?.results || []).map((item: any) => <button key={item.id || item.email} className={mailbox === item.email ? "active" : ""} onClick={() => void openMailbox(item.email)}><strong>{item.email}</strong><span>{item.status || item.bucket || "Free"}</span><small>{item.groupName || "未分组"} · 扫描 {item.mailScanned || 0} 封</small></button>)}</div>
      <div className="outlook-mail-list">{mailbox ? mails.map((item) => <button key={item.id} onClick={() => void openMail(item)}><strong>{item.subject || "(无主题)"}</strong><span>{item.from}</span><time>{fmt(item.created_at)}</time></button>) : <p className="muted">选择一个 Outlook 邮箱</p>}</div>
      <article className="outlook-mail-detail">{mail ? <><h3>{mail.subject}</h3><small>{mail.from} · {fmt(mail.created_at)}</small><pre>{mail.text || "无文本正文"}</pre></> : <p className="muted">选择邮件查看正文</p>}</article></div>
  </section>;
}

function ImportWorkbench({ readOnly, onRefresh }: { readOnly: boolean; onRefresh: () => void }) {
  const [mode, setMode] = useState("json");
  const [text, setText] = useState('[\n  {"email":"name@example.com","accessToken":"","refreshToken":"","plan":"free"}\n]');
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState("");
  const run = async (applyTransfer = false) => {
    setError(""); setResult(null);
    try {
      let url = "/api/v2/admin/import/accounts";
      let body: any;
      if (mode === "json") {
        const parsed = JSON.parse(text); const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts;
        if (!Array.isArray(accounts)) throw new Error("JSON 必须是账号数组或包含 accounts 数组");
        body = { accounts };
      } else {
        url = mode === "outlook" ? "/api/v2/admin/import/outlook"
          : mode === "session" ? "/api/v2/admin/import/session"
            : applyTransfer ? "/api/v2/admin/import/outlook-transfer" : "/api/v2/admin/import/outlook-transfer-preview";
        body = { accounts: text };
      }
      setResult(await api<Record<string, any>>(url, { method: "POST", body: JSON.stringify(body) }));
      if (mode !== "transfer" || applyTransfer) onRefresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <section className="report-panel import-panel"><header className="workbench-heading"><div><h2>账号与凭证导入</h2><p className="muted">逐行错误会保留；AT、RT、Session 和 Outlook 密钥只进入内部凭证链</p></div><select value={mode} onChange={(event) => { setMode(event.target.value); setResult(null); }}><option value="json">JSON / API</option><option value="outlook">Outlook 4/6 段</option><option value="session">OpenAI Session</option><option value="transfer">Outlook 转移</option></select></header>
    <textarea value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
    <div className="row-actions"><button className="primary" disabled={readOnly} onClick={() => void run(false)}>{mode === "transfer" ? "预览转移" : "开始导入"}</button>{mode === "transfer" && <button disabled={readOnly || !result} onClick={() => void run(true)}>确认转移</button>}</div>
    {error && <div className="error">{error}</div>}{result && <pre>{JSON.stringify(result, null, 2)}</pre>}
  </section>;
}

function OperationsWorkbench() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState("");
  const call = async (url: string, body: unknown = {}) => {
    setError("");
    try { const next = await api<Record<string, any>>(url, { method: "POST", body: JSON.stringify(body) }); setResult(next); return next; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return null; }
  };
  return <section className="report-panel operations-panel"><h2>批量 OAuth 与维护任务</h2>
    <div className="operations-grid"><section><h3>批量 OAuth 预览 / 应用</h3><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴 AT、RT 或结构化凭证" spellCheck={false} /><div className="row-actions"><button onClick={async () => { const next = await call("/api/v2/admin/oauth/batch-preview", { text }); if (next) setPreview(next); }}>预览</button><button className="primary" disabled={!preview} onClick={() => void call("/api/v2/admin/oauth/batch-apply", { text, previewHash: preview?.batchHash, confirm: true })}>确认应用</button></div></section>
      <section><h3>OAuth 验活与使用审计</h3><div className="operation-buttons"><button onClick={() => void call("/api/v2/admin/oauth-health/start")}>启动全量 OAuth 验活</button><button onClick={async () => { setError(""); try { setResult(await api("/api/v2/admin/oauth-health/status")); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }}>查看验活进度</button><button onClick={() => void call("/api/v2/admin/usage-audit", { force: false })}>运行使用痕迹审计</button></div></section></div>
    {error && <div className="error">{error}</div>}{(preview || result) && <pre>{JSON.stringify(result || preview, null, 2)}</pre>}
  </section>;
}

function ShareWorkbench({ onCopy }: { onCopy: CopyHandler }) {
  const [links, setLinks] = useState<any[]>([]);
  const [form, setForm] = useState({ label: "", ttlHours: 24, maxViews: 5, sold: "all", channel: "", plusOnly: false });
  const [error, setError] = useState("");
  const load = async () => {
    try { const data = await api<{ results: any[] }>("/api/v2/admin/share/links"); setLinks(data.results || []); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  useEffect(() => { void load(); }, []);
  const create = async () => {
    setError("");
    try { await api("/api/v2/admin/share/links", { method: "POST", body: JSON.stringify(form) }); setForm({ ...form, label: "" }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <section className="report-panel share-panel">
    <header className="workbench-heading"><div><h2>限时账号快照</h2><p className="muted">邮箱仅显示脱敏地址；链接按过期时间和查看次数自动失效</p></div><button onClick={() => void load()}><RefreshCw size={16} />刷新</button></header>
    <div className="share-create"><input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="快照名称" /><label>有效小时<input type="number" min={1} max={168} value={form.ttlHours} onChange={(event) => setForm({ ...form, ttlHours: Number(event.target.value) })} /></label><label>查看次数<input type="number" min={1} max={50} value={form.maxViews} onChange={(event) => setForm({ ...form, maxViews: Number(event.target.value) })} /></label><select value={form.sold} onChange={(event) => setForm({ ...form, sold: event.target.value })}><option value="all">全部账号</option><option value="sold">仅已售</option><option value="unsold">仅未售</option></select><label className="share-check"><input type="checkbox" checked={form.plusOnly} onChange={(event) => setForm({ ...form, plusOnly: event.target.checked })} />仅 Plus</label><button className="primary" onClick={() => void create()}><Share2 size={16} />创建链接</button></div>
    {error && <div className="error">{error}</div>}
    <div className="share-list">{links.map((item) => <div key={item.id} className="share-row"><div><strong>{item.label || "账号概览"}</strong><small>{fmt(item.createdAt)} · 剩余 {item.remainingViews}/{item.maxViews} 次 · {item.active ? "有效" : "已失效"}</small></div><div className="row-actions"><button disabled={!item.active} onClick={() => void onCopy("分享链接复制成功", String(item.url || ""), item.label || "账号概览")}>复制链接</button><button className="danger" disabled={item.revoked} onClick={async () => { await api(`/api/v2/admin/share/links/${item.id}`, { method: "DELETE" }); await load(); }}>撤销</button></div></div>)}</div>
  </section>;
}

function AccountExpanded({ id, readOnly, commandWriter, onRefresh, onCopy }: { id: string; readOnly: boolean; commandWriter: string; onRefresh: () => void; onCopy: CopyHandler }) {
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [error, setError] = useState("");
  const [credentials, setCredentials] = useState<Record<string, string> | null>(null);
  const [credentialEditorOpen, setCredentialEditorOpen] = useState(false);
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [credentialError, setCredentialError] = useState("");
  const [credentialSaveFeedback, setCredentialSaveFeedback] = useState("");
  const [grants, setGrants] = useState<Array<Record<string, any>>>([]);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [recentMails, setRecentMails] = useState<any[]>([]);
  const [recentMail, setRecentMail] = useState<any>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const loadDetail = () => Promise.all([
    api<AccountDetail>(`/api/v2/admin/accounts/${id}`),
    api<{ results: Array<Record<string, any>> }>(`/api/v2/admin/accounts/${id}/grants`),
  ]).then(([account, grantData]) => { setDetail(account); setGrants(grantData.results); }).catch((e) => setError(e.message));
  useEffect(() => { void loadDetail(); }, [id]);
  const write = async (url: string, method: string, body: unknown) => {
    setError(""); setResult(null);
    try {
      const output = await api<Record<string, unknown>>(url, { method, body: JSON.stringify(body) });
      setResult(output); await loadDetail(); onRefresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const openCurrentMailbox = async () => {
    const target = window.open("about:blank", "_blank");
    setError("");
    try {
      const output = await api<CurrentCustomerExport>(`/api/v2/admin/accounts/${id}/current-export`);
      if (!output.publicUrl) throw new Error("当前账号没有可打开的邮箱授权链接");
      if (target) target.location.href = output.publicUrl;
      else throw new Error("浏览器阻止了新窗口，请允许本站弹出窗口后重试");
    } catch (reason) {
      target?.close();
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const openCredentialEditor = async () => {
    setError(""); setCredentialError(""); setCredentialSaveFeedback("");
    try {
      const loaded = await api<Record<string, string>>(`/api/v2/admin/accounts/${id}/credentials`);
      setCredentials({
        accessToken: String(loaded.accessToken || ""), refreshToken: String(loaded.refreshToken || ""),
        idToken: String(loaded.idToken || ""), sessionToken: String(loaded.sessionToken || ""),
        openaiPassword: String(loaded.openaiPassword || ""),
      });
      setCredentialEditorOpen(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const saveCredentialEditor = async () => {
    if (!credentials) return;
    setCredentialSaving(true); setCredentialError(""); setResult(null);
    try {
      const output = await api<Record<string, unknown>>(`/api/v2/admin/accounts/${id}/credentials`, {
        method: "POST", body: JSON.stringify(credentials),
      });
      const syncing = output.syncPending === true;
      setCredentialEditorOpen(false);
      setCredentialSaveFeedback(syncing ? "凭证已保存到 V1，V2 正在后台同步" : "凭证保存成功");
      if (syncing) {
        window.setTimeout(() => { void loadDetail(); onRefresh(); }, 8_000);
      } else {
        await loadDetail(); onRefresh();
      }
      window.setTimeout(() => setCredentialSaveFeedback(""), 8_000);
    } catch (reason) { setCredentialError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setCredentialSaving(false); }
  };
  if (error) return <div className="expanded error">{error}</div>;
  if (!detail) return <div className="expanded muted">正在读取账号时间线…</div>;
  const currentBinding = detail.bindings.find((binding) => binding.isCurrent);
  const loadRecentMails = async () => {
    setError("");
    try { const next = await api<{ results: any[] }>(`/api/v2/admin/accounts/${id}/recent-mails?limit=10&offset=0`); setRecentMails(next.results || []); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const loadRecentMail = async (item: any) => {
    setError("");
    try {
      const params = new URLSearchParams({ id: String(item.id || ""), folder: String(item.folder || "inbox") });
      const next = await api<any>(`/api/v2/admin/accounts/${id}/recent-mail-detail?${params}`); setRecentMail(next.mail || null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const readVerificationCode = async () => {
    setError("");
    try {
      const next = await api<any>(`/api/v2/admin/accounts/${id}/verification-code?ignoreAccessWindow=1`);
      const code = String(next?.item?.verificationCode || ""); setVerificationCode(code || "暂无验证码");
      if (code) await onCopy("验证码复制成功", code, "最新验证码");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const canIssueGrant = detail.lifecycleStatus === "active" && !detail.deactivationLocked && detail.identityStatus !== "conflict"
    && (!detail.everSold || detail.saleStatus === "active");
  const currentCredential = detail.credentialVersions.find((version) => version.current);
  const activeGrantCount = grants.filter((grant) => grant.active).length;
  const promotionEvidence = detail.promotion?.evidence && typeof detail.promotion.evidence === "object"
    ? detail.promotion.evidence as Record<string, any> : {};
  const promotionCount = Array.isArray(promotionEvidence.campaigns) ? promotionEvidence.campaigns.length : detail.promoEligible === true ? 1 : 0;
  const credentialTone = !currentCredential ? "yellow" : currentCredential.validityStatus === "alive" ? "green"
    : ["invalid", "conflict"].includes(currentCredential.validityStatus) ? "red" : "blue";
  return <div className="expanded detail-content">
    <section className="account-context">
      <div className="account-context-heading"><h3>账号概览</h3><span>{detail.sourceStatus === "recovered" ? "历史备份记录" : detail.sourceStatus === "v2" ? "V2 原生记录" : "迁移记录"}</span></div>
      <div className="account-context-badges">
        {billingChannelStatus(detail) && <Badge tone={billingChannelStatusTone(detail)}>{billingChannelStatus(detail)}</Badge>}
        {detail.markColor && <Badge tone={markColorTone(detail.markColor)}><span className={`mark-dot ${detail.markColor}`} />{markColorLabel(detail.markColor)}标记</Badge>}
        {detail.groupBoundary && <Badge tone="red">红色分组边界</Badge>}
        {detail.suspectedUnused && <Badge tone="yellow">审计后空闲</Badge>}
        {detail.hidePromotion && <Badge tone="gray">隐藏广告</Badge>}
        {detail.saleStatus === "active" && <Badge tone="purple">当前已售</Badge>}
      </div>
    </section>

    <section className="detail-summary-grid" aria-label="账号状态摘要">
      <article className="detail-summary-card summary-blue"><span className="detail-summary-icon"><Workflow size={18} /></span><div><small>绑定状态</small><strong>{currentBinding ? "已绑定" : "未绑定"}</strong><span>{detail.bindings.length} 次邮箱绑定</span></div></article>
      <article className={`detail-summary-card summary-${credentialTone}`}><span className="detail-summary-icon"><Bot size={18} /></span><div><small>AT / RT</small><strong>{detail.credentialVersions.length} 个版本</strong><span>{currentCredential ? `当前 ${currentCredential.validityStatus}` : "等待有效凭证"}</span></div></article>
      <article className="detail-summary-card summary-purple"><span className="detail-summary-icon"><ShieldCheck size={18} /></span><div><small>客户授权</small><strong>{activeGrantCount} 条有效</strong><span>共 {grants.length} 条记录</span></div></article>
      <article className={`detail-summary-card summary-${promotionCheckActive(detail.promotionCheckStatus) ? "blue" : detail.promoSuspicious ? "yellow" : detail.promoEligible === true ? "green" : detail.promoEligible === false ? "gray" : "yellow"}`}><span className="detail-summary-icon"><Activity size={18} /></span><div><small>优惠检测</small><strong>{promotionCheckActive(detail.promotionCheckStatus) ? "正在检测" : detail.promoSuspicious ? "优惠存疑" : detail.promoEligible === true ? `${promotionCount || 1} 项可用` : detail.promoEligible === false ? "暂无优惠" : "结果未知"}</strong><span>{promotionCheckActive(detail.promotionCheckStatus) ? "结果完成后自动刷新" : detail.trialCheckedAt ? fmt(detail.trialCheckedAt) : "尚未完成检测"}</span></div></article>
    </section>

    <section className="detail-actions detail-quick-actions">
      <div className="detail-section-heading"><h3>常用操作</h3><small>{readOnly ? "业务命令未启用" : commandWriter === "v1-via-v2" ? "账号操作由 V1 规则执行" : "V2 独立写入"}</small></div>
      <div className="detail-action-grid">
        <button disabled={credentialSaving} onClick={() => void openCredentialEditor()}><Bot size={14} />编辑 OAuth / 填写 AT</button>
        <button disabled={readOnly} onClick={() => { const note = prompt("账号备注", detail.note); if (note !== null) void write(`/api/v2/admin/accounts/${id}`, "PATCH", { note }); }}><FileChartColumn size={14} />编辑备注</button>
        <button disabled={readOnly} onClick={() => { const paymentLink = prompt("Stripe / 支付链接", detail.paymentLink); if (paymentLink !== null) void write(`/api/v2/admin/accounts/${id}`, "PATCH", { paymentLink }); }}><ShoppingCart size={14} />支付链接</button>
        <button disabled={readOnly || !currentBinding || (detail.everSold && !detail.deactivationLocked)} onClick={() => { const email = prompt("改绑后的新邮箱（完整本地部分必须一致）"); if (email) void write(`/api/v2/admin/accounts/${id}/rebind`, "POST", { email }); }}><AtSign size={14} />新增改绑</button>
        <button disabled={readOnly || !currentBinding || !canIssueGrant} onClick={() => { if (currentBinding && confirm(detail.saleStatus === "active" ? "重置当前客户权限？旧链接和现有登录会立即失效。" : "为当前绑定建立首次出售并生成客户权限？")) void write(`/api/v2/admin/accounts/${id}/grants`, "POST", { bindingId: currentBinding.id }); }}><ShieldCheck size={14} />{detail.saleStatus === "active" ? "重置当前客户授权" : "生成首次客户授权"}</button>
        <button disabled={readOnly || !currentBinding} onClick={() => void write(`/api/v2/admin/accounts/${id}`, "PATCH", { receiveDisabled: !currentBinding?.receiveDisabledAt })}><Ban size={14} />{currentBinding?.receiveDisabledAt ? "恢复接收新邮件" : "停止接收新邮件"}</button>
        <button onClick={() => void readVerificationCode()}><ClipboardCopy size={14} />复制最新验证码</button>
        <button onClick={() => void loadRecentMails()}><Mail size={14} />读取最近邮件</button>
        <button onClick={() => void openCurrentMailbox()}><Globe2 size={14} />打开邮箱</button>
        <label className="detail-inline-select"><span>手动支付渠道</span><select aria-label="手动支付渠道" disabled={readOnly} value={detail.billingChannelOverride || ""} onChange={(event) => void write(`/api/v2/admin/accounts/${id}`, "PATCH", { billingChannelOverride: event.target.value })}><option value="">自动识别</option>{billingChannelFilterOptions.filter(([value]) => value !== "unknown").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {detail.saleStatus === "active" && !detail.saleFirstUsedAt && <button disabled={readOnly} onClick={() => { if (confirm("该授权尚未使用，确定取消并恢复未售？")) void write(`/api/v2/admin/accounts/${id}`, "PATCH", { sold: false }); }}>取消未使用出售</button>}
      </div>
      {credentialSaveFeedback && <div className="credential-save-feedback" role="status"><strong>✓ {credentialSaveFeedback}</strong><small>现在可以关闭详情或继续操作，不需要等待整库同步。</small></div>}
      {!canIssueGrant && detail.sellBlockers.length > 0 && <span className="muted">禁止出售：{detail.sellBlockers.join("、")}</span>}
      {verificationCode && <span className="verification-result">验证码：<strong>{verificationCode}</strong></span>}
    </section>

    <details className="detail-group detail-recent-mail-group" open={recentMails.length > 0}>
      <summary><span>管理员最近邮件与验证码</span><small>{recentMails.length} 封</small></summary>
      <div className="detail-group-body recent-mail-layout"><div>{recentMails.length ? recentMails.map((item) => <button key={item.id} onClick={() => void loadRecentMail(item)}><strong>{item.subject || "(无主题)"}</strong><span>{item.from}</span><time>{fmt(item.created_at)}</time></button>) : <p className="muted">点击“读取最近邮件”加载</p>}</div><article>{recentMail ? <><h3>{recentMail.subject}</h3><small>{recentMail.from} · {fmt(recentMail.created_at)}</small><pre>{recentMail.text || "无文本正文"}</pre></> : <p className="muted">选择邮件查看正文</p>}</article></div>
    </details>

    <details className="detail-group detail-recycle-group">
      <summary><span>回收模式</span><small>资格由 V2 领域规则判定</small></summary>
      <div className="detail-group-body detail-action-grid"><button className="danger" disabled={readOnly} onClick={() => { if (confirm("按停用满 7 天规则回收？")) void write(`/api/v2/admin/accounts/${id}/recycle`, "POST", { mode: "deactivated" }); }}>停用账号回收</button><button disabled={readOnly} onClick={() => { if (confirm("回收 Free 无特殊标记账号？")) void write(`/api/v2/admin/accounts/${id}/recycle`, "POST", { mode: "untagged_free" }); }}>Free 无标记回收</button><button disabled={readOnly} onClick={() => { if (confirm("回收 AT 已失效账号？")) void write(`/api/v2/admin/accounts/${id}/recycle`, "POST", { mode: "invalid_at" }); }}>失效 AT 回收</button><button disabled={readOnly} onClick={() => { if (confirm("轮换待注册 iCloud 点号别名？")) void write(`/api/v2/admin/accounts/${id}/recycle`, "POST", { mode: "alias_rotate" }); }}>注册别名轮换</button></div>
    </details>

    <details className="detail-group detail-identity-group" open>
      <summary><span>身份与绑定</span><small>{detail.bindings.length} 次绑定 · {detail.relations.length} 条关联</small></summary>
      <div className="detail-group-body detail-two-column">
        <section><h3>邮箱绑定时间线</h3>{detail.bindings.map((binding) => <div className="timeline-row" key={binding.id}>
          <span className="timeline-dot" /><strong>{binding.email}</strong><Badge tone={binding.isCurrent ? "green" : "gray"}>{binding.isCurrent ? "当前" : "历史"}</Badge>
          <span>{associationMethodLabel(binding.associationMethod)}</span><span>{fmt(binding.validFrom)} → {binding.validTo ? fmt(binding.validTo) : "现在"}</span>
        </div>)}</section>
        <section><h3>关联与跟踪</h3>{detail.relations.length ? detail.relations.map((relation) => <div className="timeline-row" key={relation.id}>
          <span className="timeline-dot relation" /><strong>{relationTypeLabel(relation.relationType)}</strong><span>{associationMethodLabel(relation.associationMethod)}</span><span>{fmt(relation.changedAt)}</span>
        </div>) : <p className="muted">暂无跨邮箱或回收关系</p>}</section>
      </div>
    </details>

    <details className="detail-group detail-credential-group">
      <summary><span>AT / RT 凭证版本链</span><small>{detail.credentialVersions.length} 个版本</small></summary>
      <div className="detail-group-body">{detail.credentialVersions.length ? detail.credentialVersions.map((version) => <div className="timeline-row credential-version-row" key={version.id}>
        <span className="timeline-dot" /><strong>{version.current ? "当前凭证" : "历史凭证"}</strong>
        <Badge tone={version.validityStatus === "alive" ? "green" : version.validityStatus === "conflict" || version.validityStatus === "invalid" ? "red" : "gray"}>{version.validityStatus}</Badge>
        <code title={version.tokenFingerprint}>{version.tokenFingerprint.slice(0, 12)}</code>
        <span>{version.source} · 首见 {fmt(version.firstSeenAt)} · 观察 {version.observationCount} 次</span>
      </div>) : <p className="muted">当前账号没有 AT / RT 版本</p>}</div>
    </details>

    {credentialEditorOpen && credentials && <div className="credential-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCredentialEditorOpen(false); }}>
      <section className="credential-editor" role="dialog" aria-modal="true" aria-label="编辑 OpenAI OAuth 凭证">
        <header><div><h3>OpenAI 凭证</h3><small>当前账号 · 保存由 {commandWriter === "v1-via-v2" ? "V1 账号规则" : "V2 凭证链"} 校验归属</small></div><button onClick={() => setCredentialEditorOpen(false)}>关闭</button></header>
        {([
          ["accessToken", "Access Token（AT）"], ["refreshToken", "Refresh Token（RT）"],
          ["idToken", "ID Token"], ["sessionToken", "Session Token"], ["openaiPassword", "OpenAI 登录密码"],
        ] as const).map(([key, label]) => <label key={key}><span>{label}</span><textarea value={credentials[key] || ""} onChange={(event) => setCredentials({ ...credentials, [key]: event.target.value })} spellCheck={false} /><button disabled={!credentials[key]} onClick={() => void onCopy(`${label} 复制成功`, credentials[key], label)}>复制</button></label>)}
        {credentialError && <div className="credential-editor-error" role="alert">{credentialError}</div>}
        <div className="credential-editor-actions"><small>先读取现有字段，再修改并保存；这样不会误清空没有改动的 RT 或 Session。</small><div className="row-actions"><button onClick={() => setCredentialEditorOpen(false)}>取消</button><button className="primary" disabled={readOnly || credentialSaving} onClick={() => void saveCredentialEditor()}>{credentialSaving ? "保存中…" : "保存凭证"}</button></div></div>
      </section>
    </div>}

    <details className="detail-group detail-grant-group">
      <summary><span>客户授权</span><small>{grants.length} 条记录</small></summary>
      <div className="detail-group-body">{grants.length ? grants.map((grant) => <div className="timeline-row grant-row" key={grant.id}>
        <strong>{grant.loginIdentifier}</strong><Badge tone={grant.active ? "green" : "gray"}>{grant.active ? grant.scope : "已撤销"}</Badge>
        <span>{grant.visibleTo ? `截止 ${fmt(grant.visibleTo)}` : "当前授权"}{grant.firstUsedAt ? ` · 已使用 ${fmt(grant.firstUsedAt)}` : " · 尚未使用"}</span>
        {grant.active && <button disabled={readOnly} onClick={() => { if (confirm("撤销这个客户取件授权？")) void write(`/api/v2/admin/accounts/${id}/grants/${grant.id}`, "DELETE", {}); }}>撤销</button>}
      </div>) : <p className="muted">暂无客户授权；admin_only 不展示</p>}</div>
    </details>

    <details className="detail-group detail-payment-group" open>
      <summary><span>支付与试用检测</span><small>{detail.paymentExposureChecks?.length || 0} 项结果</small></summary>
      <div className="detail-group-body"><PaymentExposureSection accountId={id} checks={detail.paymentExposureChecks || []} promotion={detail.promotion} promoSuspicious={detail.promoSuspicious} promoSuspiciousOverride={detail.promoSuspiciousOverride} historicalPromoCampaigns={detail.historicalPromoCampaigns} promotionCheckStatus={detail.promotionCheckStatus} autoTrialStatus={detail.autoTrialStatus} autoTrialDueAt={detail.autoTrialDueAt} plan={detail.plan} lifecycleStatus={detail.lifecycleStatus} deactivationLocked={detail.deactivationLocked} readOnly={readOnly} onRefresh={async () => { await loadDetail(); onRefresh(); }} /></div>
    </details>

    <details className="detail-group detail-routing-group" open>
      <summary><span>内部收件路由</span><small>{detail.routingRules.length} 条规则 · {detail.mailboxConnections.length} 个连接</small></summary>
      <div className="detail-group-body detail-two-column"><section><h3>路由规则</h3>{detail.routingRules.length ? detail.routingRules.map((rule) => <div className="timeline-row" key={rule.id}><strong>优先级 {rule.priority}</strong><span>FROM {rule.senderPattern || "任意"}</span><span>TO {rule.recipientPattern || "任意"}</span></div>) : <p className="muted">无独立路由规则</p>}</section><section><h3>邮箱连接</h3>{detail.mailboxConnections.length ? detail.mailboxConnections.map((connection) => <div className="timeline-row" key={connection.id}><strong>{connection.provider}</strong><Badge tone={connection.status === "active" ? "green" : "gray"}>{connection.status}</Badge><span>{connection.externalGroupId || "默认分组"}</span></div>) : <p className="muted">使用共享邮件 API</p>}</section></div>
    </details>

    <details className="detail-group detail-lifecycle-group" open>
      <summary><span>生命周期</span><small>{Math.min(detail.timeline.length, 12)} 项最近事件</small></summary>
      <div className="detail-group-body">{detail.timeline.slice(0, 12).map((event) => <div className="timeline-row" key={event.id}>
        <span className="timeline-dot event" /><strong>{lifecycleEventLabel(event.eventType)}</strong><span>{fmt(event.occurredAt)}</span>
      </div>)}</div>
    </details>

    <details className="detail-group detail-note-group">
      <summary><span>备注与支付链接</span><small>{detail.note ? "已有备注" : "暂无备注"}</small></summary>
      <div className="detail-group-body detail-note"><p>{detail.note || "暂无备注"}</p>{detail.paymentLink && <p className="muted">支付链接已填写</p>}</div>
    </details>

    {result && <section className="action-result-card" role="status">
      <header><div><strong>✓ 操作已完成</strong><small>账号资料已经刷新</small></div><button aria-label="关闭操作结果" onClick={() => setResult(null)}>×</button></header>
      {typeof result.loginIdentifier === "string" && <div className="action-result-fields">
        <label><span>客户登录邮箱</span><strong>{String(result.loginIdentifier)}</strong><button onClick={() => void onCopy("客户登录邮箱复制成功", String(result.loginIdentifier), "客户登录邮箱")}>复制</button></label>
        <label><span>客户接码密码</span><strong>{String(result.password || "")}</strong><button disabled={!result.password} onClick={() => void onCopy("客户接码密码复制成功", String(result.password || ""), "客户接码密码")}>复制</button></label>
        <label><span>客户邮箱链接</span><strong>{String(result.publicUrl || "")}</strong><button disabled={!result.publicUrl} onClick={() => void onCopy("客户邮箱链接复制成功", String(result.publicUrl || ""), "客户邮箱链接")}>复制</button></label>
      </div>}
    </section>}
  </div>;
}

function AdminApp() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [overviewData, setOverview] = useState<Overview | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState("");
  const dragSelection = useRef<{ active: boolean; selecting: boolean; seen: Set<string> }>({ active: false, selecting: true, seen: new Set() });
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedbackState | null>(null);
  const [copyingAccountId, setCopyingAccountId] = useState("");
  const [copyPreviewOpen, setCopyPreviewOpen] = useState(false);
  const [writing, setWriting] = useState(false);
  const [markSavingIds, setMarkSavingIds] = useState<Set<string>>(new Set());
  const markSaveChains = useRef(new Map<string, Promise<void>>());
  const markSaveRevisions = useRef(new Map<string, number>());
  const [promotionBatching, setPromotionBatching] = useState(false);
  const [promotionBatchProgress, setPromotionBatchProgress] = useState<PromotionBatchProgress | null>(null);
  const promotionBatchRun = useRef(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadState, setLoadState] = useState(idleAdminLoadState);
  const [loadClock, setLoadClock] = useState(() => Date.now());
  const loadRequest = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const loadInvoker = useRef<(trigger?: AdminLoadTrigger) => Promise<void>>(async () => undefined);
  const loadStateRef = useRef(loadState);
  const hasUsableAccountList = useRef(false);
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState("accounts");
  const [redGroups, setRedGroups] = useState<RedGroup[]>([]);
  const [reviews, setReviews] = useState<PendingReview[]>([]);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [theme, setTheme] = useState(localStorage.getItem("opus-v2-admin-theme-reference") || "dark");
  const [bulkMarkColor, setBulkMarkColor] = useState("yellow");
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [filters, setFilters] = useState({ ...DEFAULT_ACCOUNT_FILTERS });

  useEffect(() => { document.documentElement.dataset.theme = localStorage.getItem("opus-v2-theme") || "dark"; }, []);
  useEffect(() => { localStorage.setItem("opus-v2-admin-theme-reference", theme); }, [theme]);
  useEffect(() => { loadStateRef.current = loadState; }, [loadState]);
  useEffect(() => {
    if (loadState.phase !== "initial" && loadState.phase !== "usable-background") return;
    setLoadClock(Date.now());
    const timer = window.setInterval(() => setLoadClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [loadState.requestId, loadState.phase]);
  useEffect(() => { void api<{ release: ReleaseInfo }>("/api/v2/version").then((data) => setRelease(data.release || null)).catch(() => undefined); }, []);
  useEffect(() => {
    if (!copyFeedback || copyFeedback.kind !== "success" || copyPreviewOpen) return;
    const timer = window.setTimeout(() => setCopyFeedback(null), 6500);
    return () => window.clearTimeout(timer);
  }, [copyFeedback, copyPreviewOpen]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (promotionBatchProgress?.status !== "completed") return;
    const timer = window.setTimeout(() => setPromotionBatchProgress(null), 4800);
    return () => window.clearTimeout(timer);
  }, [promotionBatchProgress?.status]);
  useEffect(() => {
    if (!expanded && !copyPreviewOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (copyPreviewOpen) setCopyPreviewOpen(false);
      else setExpanded("");
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", closeOnEscape); };
  }, [expanded, copyPreviewOpen]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragSelection.current;
      if (!drag.active) return;
      event.preventDefault();
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-account-id]");
      const id = row?.dataset.accountId || "";
      if (!id || drag.seen.has(id)) return;
      drag.seen.add(id);
      setSelected((current) => {
        const next = new Set(current);
        if (drag.selecting) next.add(id); else next.delete(id);
        return next;
      });
      setSelectionAnchor(id);
    };
    const stop = () => { dragSelection.current.active = false; dragSelection.current.seen.clear(); };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
    };
  }, []);
  const checkSession = () => api("/api/v2/admin/session").then(() => setAuthenticated(true)).catch(() => setAuthenticated(false));
  useEffect(() => { void checkSession(); }, []);
  const load = async (trigger: AdminLoadTrigger = "navigation") => {
    const requestId = loadRequest.current.id + 1;
    loadRequest.current.controller?.abort();
    const controller = new AbortController();
    loadRequest.current = { id: requestId, controller };
    const isCurrent = () => loadRequest.current.id === requestId && !controller.signal.aborted;
    const nextLoadState = beginAdminLoad(requestId, Date.now(), hasUsableAccountList.current, trigger);
    setLoadState(nextLoadState); setLoadClock(nextLoadState.startedAt);
    setLoading(true); setError("");
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    query.set("limit", String(PAGE_SIZE)); query.set("offset", String(page * PAGE_SIZE));
    const summaryResult = settled(api<Overview>("/api/v2/admin/overview", { signal: controller.signal }));
    const groupsResult = settled(api<{ results: RedGroup[] }>("/api/v2/admin/red-groups", { signal: controller.signal }));
    try {
      // The account list defines first-screen usability.  Overview, groups and
      // tab-specific reports are supplementary and must not hold the list in a
      // foreground loading state.
      const list = await api<{ results: AccountSummary[]; total: number }>(`/api/v2/admin/accounts?${query}`, { signal: controller.signal });
      if (!isCurrent()) return;
      setAccounts(list.results); setTotal(list.total); hasUsableAccountList.current = true;
      setLoadState((current) => current.requestId === requestId ? markAdminListReady(current, Date.now()) : current);
      setSelected((current) => {
        const visibleIds = new Set(list.results.map((item) => item.id));
        const next = new Set([...current].filter((id) => visibleIds.has(id)));
        return next.size === current.size ? current : next;
      });
      const tabResult = tab === "reviews"
        ? settled(api<{ results: PendingReview[] }>("/api/v2/admin/pending-reviews", { signal: controller.signal }))
        : tab === "migration"
          ? settled(api<Record<string, unknown>>("/api/v2/admin/migration-report", { signal: controller.signal }))
          : Promise.resolve({});
      const [summary, groups, extra] = await Promise.all([summaryResult, groupsResult, tabResult]);
      if (!isCurrent()) return;
      if (summary.value) setOverview(summary.value);
      if (groups.value) setRedGroups(groups.value.results);
      if (tab === "reviews" && "value" in extra && extra.value) setReviews((extra.value as { results: PendingReview[] }).results);
      if (tab === "migration" && "value" in extra && extra.value) setReport(extra.value as Record<string, unknown>);
      const backgroundError = summary.error || groups.error || ("error" in extra ? extra.error : undefined);
      if (backgroundError) {
        const message = backgroundError instanceof Error ? backgroundError.message : String(backgroundError);
        setError(`账号列表已加载；后台数据同步失败：${message}`);
        setLoadState((current) => current.requestId === requestId ? failAdminLoad(current, Date.now(), message) : current);
      } else {
        setLoadState((current) => current.requestId === requestId ? completeAdminLoad(current, Date.now()) : current);
      }
    } catch (reason) {
      if (isAbortError(reason) || !isCurrent()) return;
      controller.abort();
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setLoadState((current) => current.requestId === requestId ? failAdminLoad(current, Date.now(), message) : current);
    } finally {
      if (loadRequest.current.id === requestId) setLoading(false);
    }
  };
  loadInvoker.current = load;
  useEffect(() => { if (authenticated) void load(hasUsableAccountList.current ? "navigation" : "initial"); }, [authenticated, filters, page, tab]);
  useEffect(() => {
    const onPageHide = () => loadRequest.current.controller?.abort();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && authenticated) void loadInvoker.current("restore");
    };
    const onOnline = () => {
      if (authenticated && loadStateRef.current.phase === "error") void loadInvoker.current("reconnect");
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    return () => {
      promotionBatchRun.current += 1;
      loadRequest.current.controller?.abort();
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
    };
  }, [authenticated]);
  if (authenticated === null) return <main className="center muted">正在检查登录状态…</main>;
  if (!authenticated) return <AdminLogin onDone={() => setAuthenticated(true)} />;

  const allSelected = accounts.length > 0 && accounts.every((item) => selected.has(item.id));
  const clearSelection = () => { setSelected(new Set()); setSelectionAnchor(""); };
  const selectAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) accounts.forEach((item) => next.delete(item.id));
      else accounts.forEach((item) => next.add(item.id));
      return next;
    });
    setSelectionAnchor(accounts[0]?.id || "");
  };
  const invertPageSelection = () => {
    setSelected((current) => {
      const next = new Set(current);
      accounts.forEach((item) => next.has(item.id) ? next.delete(item.id) : next.add(item.id));
      return next;
    });
  };
  const selectAccount = (id: string, range = false) => {
    setSelected((current) => {
      const next = new Set(current);
      if (range && selectionAnchor) {
        const start = accounts.findIndex((item) => item.id === selectionAnchor);
        const end = accounts.findIndex((item) => item.id === id);
        if (start >= 0 && end >= 0) {
          const shouldSelect = !current.has(id);
          accounts.slice(Math.min(start, end), Math.max(start, end) + 1).forEach((item) => shouldSelect ? next.add(item.id) : next.delete(item.id));
        } else next.has(id) ? next.delete(id) : next.add(id);
      } else next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setSelectionAnchor(id);
  };
  const startDragSelection = (event: React.PointerEvent, id: string) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const selecting = !selected.has(id);
    dragSelection.current = { active: true, selecting, seen: new Set([id]) };
    setSelected((current) => {
      const next = new Set(current);
      if (selecting) next.add(id); else next.delete(id);
      return next;
    });
    setSelectionAnchor(id);
  };
  const changeFilter = (name: string, value: string) => { setPage(0); clearSelection(); setExpanded(""); setFilters((current) => ({ ...current, [name]: value })); };
  const workbenchForTab = (value: string) => value === "icloud" ? "icloud" : value === "domains" ? "domain"
    : value === "auto" ? "auto" : value === "missing-at" ? "missing_at" : value === "outlook-free" ? "outlook_free"
      : value === "deactivations" ? "deactivations" : "";
  const resetFilters = () => { setPage(0); clearSelection(); setExpanded(""); setShowAdvancedFilters(false); setFilters({ ...DEFAULT_ACCOUNT_FILTERS, workbench: workbenchForTab(tab), deactivationWindow: tab === "deactivations" ? "today" : "" }); };
  const openTab = (next: string) => {
    setTab(next); setPage(0); clearSelection(); setExpanded("");
    if (next === "deactivations") setFilters({ ...DEFAULT_ACCOUNT_FILTERS, workbench: "deactivations", deactivationWindow: "today", pending: "" });
    else if (["icloud", "domains", "auto", "missing-at", "outlook-free"].includes(next)) setFilters((value) => ({ ...value, workbench: workbenchForTab(next), deactivationWindow: "", provider: "", billingChannel: "", plan: "", credential: "", unused: "", redGroup: "", markColor: "", pending: "exclude" }));
    else if (next === "idle") setFilters((value) => ({ ...value, provider: "", billingChannel: "", plan: "free", credential: "missing", unused: "true", redGroup: "", markColor: "", pending: "exclude" }));
    else if (next === "red-groups") setFilters((value) => ({ ...value, provider: "", billingChannel: "", plan: "", credential: "", unused: "", redGroup: redGroups[0]?.boundaryAccountId || "", markColor: "", pending: "exclude" }));
    else if (next === "accounts") setFilters((value) => ({ ...value, workbench: "", provider: "", billingChannel: "", plan: "", credential: "", unused: "", redGroup: "", markColor: "", pending: "exclude" }));
  };
  const runBulk = async (action: string, value: unknown) => {
    if (overviewData?.readOnly || !selected.size || writing) return;
    if (action === "deactivate" && !confirm(`确定永久停用选中的 ${selected.size} 个账号？此操作不可撤销。`)) return;
    if (action === "delete" && !confirm(`删除选中的 ${selected.size} 个账号？这是软删除：记录会保留在历史审计中，客户权限会立即撤销。`)) return;
    setWriting(true); setError(""); setNotice("");
    try {
      const result = await api<{ updated: number }>("/api/v2/admin/accounts/bulk", { method: "POST", body: JSON.stringify({ accountIds: [...selected], action, value }) });
      setNotice(`已更新 ${result.updated} 个账号`); clearSelection(); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWriting(false); }
  };
  const refreshAccountListQuietly = async (): Promise<AccountSummary[]> => {
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    query.set("limit", String(PAGE_SIZE)); query.set("offset", String(page * PAGE_SIZE));
    const list = await api<{ results: AccountSummary[]; total: number }>(`/api/v2/admin/accounts?${query}`);
    setAccounts(list.results); setTotal(list.total);
    return list.results;
  };
  const runBulkPromotionCheck = async () => {
    if (!selected.size || promotionBatching) return;
    if (!confirm(`确定使用 JP 出口重新检测选中的 ${selected.size} 个账号？没有 AT 的账号会被跳过。`)) return;
    const runId = promotionBatchRun.current + 1;
    promotionBatchRun.current = runId;
    const accountIds = [...selected];
    setPromotionBatching(true); setError(""); setNotice("");
    setPromotionBatchProgress({ total: accountIds.length, processed: 0, queued: accountIds.length, running: 0, retrying: 0, failed: 0, status: "running" });
    try {
      const result = await api<{ requested: number; queued: number; alreadyRunning: number; skipped: number; failed: number; jobs: PromotionJobState[]; errors: Array<{ accountId: string; error: string; skipped?: boolean }> }>("/api/v2/admin/accounts/promotion-check", {
        method: "POST", body: JSON.stringify({ accountIds }),
      });
      const jobIds = result.jobs.map((job) => job.id).filter(Boolean);
      setNotice(`优惠检测已启动 ${jobIds.length} 个${result.skipped ? ` · ${result.skipped} 个 Plus/停用账号已跳过` : ""}${result.failed ? ` · ${result.failed} 个无可用 AT 或配置异常` : ""}`);
      let jobs = result.jobs;
      let consecutiveFailures = 0;
      while (promotionBatchRun.current === runId) {
        try {
          if (jobIds.length) {
            const statusResult = await api<{ jobs: PromotionJobState[] }>("/api/v2/admin/accounts/promotion-check/status", {
              method: "POST", body: JSON.stringify({ jobIds }),
            });
            jobs = statusResult.jobs;
          }
          await refreshAccountListQuietly();
          consecutiveFailures = 0;
          const queued = jobs.filter((job) => job.status === "queued").length;
          const running = jobs.filter((job) => ["running", "dispatching"].includes(job.status)).length;
          const retrying = jobs.filter((job) => job.status === "retry_wait").length;
          const failedJobs = jobs.filter((job) => ["credential_invalid", "failed", "cancelled", "interrupted"].includes(job.status)).length;
          const active = queued + running;
          const processed = Math.min(result.requested, result.skipped + result.failed + jobs.length - active);
          setPromotionBatchProgress({ total: result.requested, processed, queued, running, retrying,
            failed: result.failed + failedJobs, status: active ? "running" : "completed" });
          if (!active) {
            await refreshAccountListQuietly();
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1200));
        } catch (reason) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 5) throw reason;
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(5000, 1200 * consecutiveFailures)));
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPromotionBatchProgress((current) => current ? { ...current, status: "error" } : null);
    } finally {
      if (promotionBatchRun.current === runId) setPromotionBatching(false);
    }
  };
  const patchAccount = async (item: AccountSummary, patch: Record<string, unknown>, label: string) => {
    if (overviewData?.readOnly || writing) return;
    setWriting(true); setError(""); setNotice("");
    try {
      await api(`/api/v2/admin/accounts/${item.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      setNotice(`${item.primaryEmail}：${label}`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWriting(false); }
  };
  const patchMarkColor = (item: AccountSummary, color: string) => {
    if (overviewData?.readOnly) return;
    const revision = (markSaveRevisions.current.get(item.id) || 0) + 1;
    markSaveRevisions.current.set(item.id, revision);
    setError(""); setNotice("");
    setAccounts((current) => current.map((account) => account.id === item.id ? { ...account, markColor: color } : account));
    setMarkSavingIds((current) => new Set(current).add(item.id));

    const previous = markSaveChains.current.get(item.id) || Promise.resolve();
    const save = previous.catch(() => undefined).then(async () => {
      await api(`/api/v2/admin/accounts/${item.id}`, { method: "PATCH", body: JSON.stringify({ markColor: color }) });
      if (markSaveRevisions.current.get(item.id) === revision) {
        setNotice(`${item.primaryEmail}：${color ? `已设为${markColorLabel(color)}标记` : "已清除颜色标记"}`);
      }
    }).catch(async (reason) => {
      if (markSaveRevisions.current.get(item.id) !== revision) return;
      setError(`${item.primaryEmail}：颜色保存失败，已恢复服务器记录。${reason instanceof Error ? reason.message : String(reason)}`);
      try { await refreshAccountListQuietly(); } catch { /* 保留明确的保存错误 */ }
    }).finally(() => {
      if (markSaveRevisions.current.get(item.id) !== revision) return;
      setMarkSavingIds((current) => {
        const next = new Set(current); next.delete(item.id); return next;
      });
      if (markSaveChains.current.get(item.id) === save) markSaveChains.current.delete(item.id);
    });
    markSaveChains.current.set(item.id, save);
  };
  const setAccountPromotionSuspicion = async (item: AccountSummary) => {
    if (overviewData?.readOnly || writing) return;
    setWriting(true); setError(""); setNotice("");
    try {
      const suspicious = !item.promoSuspiciousOverride;
      await api(`/api/v2/admin/accounts/${item.id}/promotion-suspicion`, {
        method: "POST", body: JSON.stringify({ suspicious }),
      });
      setNotice(`${item.primaryEmail}：${suspicious ? "已标记可能掉优惠" : "已取消人工存疑"}`);
      await refreshAccountListQuietly();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWriting(false); }
  };
  const copySucceeded = (title: string, text: string, receipt: CopyReceipt, extra = "") => {
    setError(""); setNotice("");
    setCopyFeedback({
      kind: "success",
      title,
      message: `已完整写入剪贴板 · ${receipt.characters} 个字符${extra ? ` · ${extra}` : ""}`,
      text,
    });
  };
  const copyFailed = (reason: unknown, text = "") => {
    const message = reason instanceof Error ? reason.message : String(reason);
    setError(""); setNotice("");
    setCopyFeedback({ kind: "error", title: "复制失败", message, text });
  };
  const copyCurrentExport = async (item: AccountSummary) => {
    if (copyingAccountId) return;
    setCopyingAccountId(item.id);
    setError(""); setNotice(""); setCopyFeedback(null);
    let completeText = "";
    try {
      const output = await api<CurrentCustomerExport>(`/api/v2/admin/accounts/${item.id}/current-export`);
      completeText = String(output.text || "");
      const receipt = await copyText(completeText);
      copySucceeded(`${output.currentEmail}：复制成功`, completeText, receipt, "当前邮箱说明");
    } catch (reason) { copyFailed(reason, completeText); }
    finally { setCopyingAccountId(""); }
  };
  const copyValue: CopyHandler = async (title, value, extra = "") => {
    const completeText = String(value || "");
    setCopyFeedback(null);
    try {
      const receipt = await copyText(completeText);
      copySucceeded(title, completeText, receipt, extra);
    } catch (reason) { copyFailed(reason, completeText); }
  };
  const selectedAccounts = () => accounts.filter((item) => selected.has(item.id));
  const copySelectedExports = async () => {
    const items = selectedAccounts();
    if (!items.length) return;
    setError(""); setNotice(""); setCopyFeedback(null);
    let completeText = "";
    try {
      const data = await api<{ results: BulkCurrentExport[] }>("/api/v2/admin/accounts/bulk-current-export", {
        method: "POST", body: JSON.stringify({ accountIds: items.map((item) => item.id) }),
      });
      const available = (data.results || []).filter((item) => item.available && item.text);
      if (!available.length) throw new Error("选中账号都没有可复制的当前客户授权");
      completeText = joinCopyBlocks(available.map((item) => item.text));
      const receipt = await copyText(completeText);
      const skipped = (data.results || []).length - available.length;
      copySucceeded(`已完整复制 ${available.length} 个账号说明`, completeText, receipt, skipped ? `跳过 ${skipped} 个无当前授权账号` : "未跳过账号");
    } catch (reason) { copyFailed(reason, completeText); }
  };
  const copySelectedAccessTokens = async () => {
    const items = selectedAccounts();
    if (!items.length) return;
    setError(""); setNotice(""); setCopyFeedback(null);
    let completeText = "";
    try {
      const data = await api<{ results: BulkCredential[] }>("/api/v2/admin/accounts/bulk-credentials", {
        method: "POST", body: JSON.stringify({ accountIds: items.map((item) => item.id) }),
      });
      const tokens = (data.results || []).map((item) => String(item.accessToken || "").trim()).filter(Boolean);
      if (!tokens.length) throw new Error("选中账号没有 AT（access_token）");
      completeText = tokens.join("\n");
      const receipt = await copyText(completeText);
      const skipped = (data.results || []).length - tokens.length;
      copySucceeded(`已完整复制 ${tokens.length} 个 AT`, completeText, receipt, skipped ? `缺少 ${skipped} 个` : "未跳过账号");
    } catch (reason) { copyFailed(reason, completeText); }
  };
  const exportSelected = async (format: "txt" | "csv" | "json") => {
    const items = selectedAccounts();
    if (!items.length) return;
    setError(""); setNotice("");
    try {
      const data = await api<{ results: BulkCurrentExport[] }>("/api/v2/admin/accounts/bulk-current-export", {
        method: "POST", body: JSON.stringify({ accountIds: items.map((item) => item.id) }),
      });
      const rows = (data.results || []).filter((item) => item.available && item.text);
      if (!rows.length) throw new Error("选中账号都没有可导出的当前客户授权");
      let content = "";
      let mime = "text/plain;charset=utf-8";
      let filename = "opus-mail-selected.txt";
      if (format === "json") {
        content = JSON.stringify(rows.map((item) => ({ accountId: item.id, email: item.currentEmail, loginIdentifier: item.loginIdentifier, publicUrl: item.publicUrl, text: item.text })), null, 2);
        mime = "application/json;charset=utf-8"; filename = "opus-mail-selected.json";
      } else if (format === "csv") {
        const csvCell = (value: unknown) => { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
        content = [["账号ID", "当前邮箱", "登录标识", "客户链接", "说明"], ...rows.map((item) => [item.id, item.currentEmail, item.loginIdentifier, item.publicUrl, item.text])]
          .map((row) => row.map(csvCell).join(",")).join("\n");
        mime = "text/csv;charset=utf-8"; filename = "opus-mail-selected.csv";
      } else {
        content = rows.map((item) => item.text).join("\n");
      }
      const blob = new Blob([format === "csv" ? `\ufeff${content}` : content], { type: mime });
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setCopyFeedback({ kind: "success", title: `已导出 ${rows.length} 个账号`, message: `${filename} 已生成，长文本按完整字段写入文件`, text: content });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const deactivateOne = async (item: AccountSummary) => {
    if (overviewData?.readOnly || writing || item.deactivationLocked || !confirm(`永久停用 ${item.primaryEmail}？停用后不可恢复。`)) return;
    setWriting(true); setError(""); setNotice("");
    try {
      await api(`/api/v2/admin/accounts/${item.id}/deactivate`, { method: "POST", body: JSON.stringify({ reason: "admin_ui_quick" }) });
      setNotice(`${item.primaryEmail}：已永久停用`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWriting(false); }
  };
  const toggleExpanded = (id: string) => setExpanded((current) => current === id ? "" : id);
  const refreshPage = async () => { setError(""); setNotice(""); await load("manual"); };
  const goToPage = (next: number) => { clearSelection(); setExpanded(""); setPage(next); };
  const resolveReview = async (review: PendingReview, action: "dismiss" | "keep_separate" | "confirm_rebind") => {
    if (overviewData?.readOnly || writing) return;
    setWriting(true); setError("");
    try {
      await api(`/api/v2/admin/pending-reviews/${review.id}/resolve`, { method: "POST", body: JSON.stringify({ action }) });
      setNotice("审查记录已处理"); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWriting(false); }
  };
  const tabLabels: Record<string, string> = {
    accounts: "GPT 账号",
    icloud: "iCloud",
    domains: "域名邮箱",
    auto: "Auto / API",
    "missing-at": "暂无 AT",
    "outlook-free": "Outlook Free",
    deactivations: "封禁记录",
    idle: "审计空闲",
    "red-groups": "红色分组",
    import: "导入账号",
    operations: "批量与维护",
    share: "分享快照",
    reviews: "待审查",
    migration: "迁移报告",
  };
  const navItems = [
    ["accounts", "GPT 账号", Bot],
    ["icloud", "iCloud", Cloud],
    ["domains", "域名邮箱", Globe2],
    ["auto", "Auto / API", Workflow],
    ["missing-at", "暂无 AT", AtSign],
    ["outlook-free", "Outlook Free", Mail],
    ["deactivations", "封禁记录", Ban],
    ["idle", "审计空闲", Activity],
    ["red-groups", "红色分组", Layers3],
    ["import", "导入账号", FileUp],
    ["operations", "批量与维护", Activity],
    ["share", "分享快照", Share2],
    ["reviews", "待审查", ShieldCheck],
    ["migration", "迁移报告", FileChartColumn],
  ] as const;
  const listTab = !["reviews", "migration", "import", "operations", "share", "outlook-free"].includes(tab);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeFilterCount = Object.entries(filters).filter(([name, value]) => value && !(name === "range" && value === "all") && !(name === "pending" && value === "exclude")).length;
  const expandedItem = accounts.find((item) => item.id === expanded) || null;
  const loadStatus = adminLoadStatusText(loadState, loadClock);
  const copyPreviewAgain = async () => {
    if (!copyFeedback?.text) return;
    try {
      const receipt = await copyText(copyFeedback.text);
      copySucceeded("再次复制成功", copyFeedback.text, receipt, "完整内容");
      setCopyPreviewOpen(false);
    } catch (reason) { copyFailed(reason, copyFeedback.text); }
  };

  return <div className={`admin-app admin-theme-${theme}`}>
    <aside className="admin-sidebar">
      <div className="sidebar-brand"><span className="sidebar-brand-mark">O</span><div><strong>Opus Mail</strong><small>V2 账号管理</small></div></div>
      <nav className="sidebar-nav sidebar-nav-all" aria-label="V2 功能导航">{navItems.map(([value, label, Icon]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => openTab(value)}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{value === "accounts" && <small>{overviewData?.visibleAccounts || 0}</small>}{value === "icloud" && <small>{overviewData?.visibleIcloud || 0}</small>}{value === "domains" && <small>{overviewData?.visibleDomains || 0}</small>}{value === "auto" && <small>{overviewData?.visibleAuto || 0}</small>}{value === "missing-at" && <small>{overviewData?.actionableMissingAt || 0}</small>}{value === "outlook-free" && <small>{overviewData?.visibleOutlookFree || 0}</small>}{value === "deactivations" && <small>{overviewData?.deactivatedToday || 0}</small>}{value === "idle" && <small>{overviewData?.visibleUnused || 0}</small>}</button>)}</nav>
      <div className="sidebar-status"><div><ShieldCheck size={16} /><Badge tone={overviewData?.readOnly ? "yellow" : "green"}>{overviewData?.readOnly ? "业务命令停用" : overviewData?.accountAuthority === "v1" ? "V1 账号规则已接管" : "V2 独立运行"}</Badge></div><small>{overviewData?.accountAuthority === "v1" ? "V2 提供后台；账号写入与排序来源遵循 V1" : "账号、凭证与邮件均由 V2 原生服务处理"}</small></div>
    </aside>

    <main className="admin-main">
      <header className="topbar"><div><p className="eyebrow">账号管理</p><h1>{tabLabels[tab] || "Opus Mail"}</h1><p>集中查看账号状态、OAuth 凭证、客户授权与试用资格</p><small className="release-id">版本 {String(release?.gitCommit || "未标记").slice(0, 8)} · 构建 {release?.builtAt ? fmt(release.builtAt) : "未知"}</small></div><div className="top-actions"><button className="icon-button" title={theme === "dark" ? "切换浅色模式" : "切换深色模式"} aria-label={theme === "dark" ? "切换浅色模式" : "切换深色模式"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button><button disabled={loading} onClick={() => void refreshPage()}><RefreshCw size={16} className={loading ? "spin" : ""} />{loading ? (loadState.listReadyAt ? "同步中" : "刷新中") : "刷新数据"}</button><button className="icon-button" title="退出管理后台" aria-label="退出管理后台" onClick={async () => { loadRequest.current.controller?.abort(); await api("/api/v2/admin/logout", { method: "POST" }); hasUsableAccountList.current = false; setLoadState(idleAdminLoadState); setAuthenticated(false); }}><LogOut size={17} /></button></div></header>

      {loadStatus && loadStatus.tone !== "complete" && <section className={`load-status load-status-${loadStatus.tone}`} role={loadStatus.tone === "error" ? "alert" : "status"} aria-live="polite" data-load-phase={loadStatus.tone}><span className="load-status-indicator" /><div><strong>{loadStatus.title}</strong><small>{loadStatus.detail}</small></div></section>}

      {overviewData && listTab && <section className="metric-grid" aria-label="账号概览">
        <article className="metric-card metric-neutral"><span className="metric-icon"><UserRound size={22} /></span><div><span>普通账号</span><strong>{overviewData.visibleAccounts}</strong><small>总账号数</small></div></article>
        <article className="metric-card metric-green"><span className="metric-icon"><Activity size={22} /></span><div><span>活跃账号</span><strong>{overviewData.visibleActive}</strong><small>当前可继续处理</small></div></article>
        <article className="metric-card metric-red"><span className="metric-icon"><TriangleAlert size={22} /></span><div><span>永久停用</span><strong>{overviewData.deactivated}</strong><small>停用锁持续保留</small></div></article>
        <article className="metric-card metric-purple"><span className="metric-icon"><ShoppingCart size={22} /></span><div><span>已售账号</span><strong>{overviewData.sold}</strong><small>当前客户使用中</small></div></article>
        <article className="metric-card metric-blue"><span className="metric-icon"><Mail size={22} /></span><div><span>域名邮箱</span><strong>{overviewData.visibleDomains}</strong><small>已绑定域名地址</small></div></article>
        <article className="metric-card metric-yellow"><span className="metric-icon"><AtSign size={22} /></span><div><span>待处理无 AT</span><strong>{overviewData.actionableMissingAt}</strong><small>需要补充凭证</small></div></article>
      </section>}

      {overviewData && tab === "deactivations" && <section className="deactivation-monitor" aria-label="北京时间封禁时间范围">
        <div><strong>北京时间</strong><small>本地索引更新 {fmtBeijing(overviewData.latestSync?.finished_at || "")}</small></div>
        <div className="deactivation-window-tabs">
          {([["today", "当天", overviewData.deactivatedToday], ["3d", "3天", overviewData.deactivatedThreeDays], ["7d", "7天", overviewData.deactivatedSevenDays], ["30d", "一个月", overviewData.deactivatedThirtyDays]] as const).map(([value, label, count]) => <button key={value} className={filters.deactivationWindow === value ? "active" : ""} onClick={() => changeFilter("deactivationWindow", value)}><span>{label}</span><strong>{count}</strong></button>)}
        </div>
      </section>}

      {listTab && <section className={`filters ${showAdvancedFilters ? "show-advanced" : ""}`}>
        <div className="filter-main-row"><label className="search-field"><Search size={17} /><input className="search" aria-label="搜索账号" value={filters.search} onChange={(e) => changeFilter("search", e.target.value)} placeholder="搜索邮箱、渠道或备注" /></label><div className="quick-filters"><select value={filters.range} onChange={(e) => changeFilter("range", e.target.value)}><option value="all">全部时间</option><option value="day">一天内</option><option value="week">一周内</option><option value="two_weeks">两周内</option></select><select value={filters.status} onChange={(e) => changeFilter("status", e.target.value)}><option value="">全部状态</option><option value="active">活跃</option><option value="deactivated">永久停用</option><option value="retired">历史回收</option><option value="quarantined">归属待核对</option></select><select value={filters.provider} onChange={(e) => changeFilter("provider", e.target.value)}><option value="">全部邮箱</option><option value="icloud">iCloud</option><option value="outlook">Outlook</option><option value="domain">域名邮箱</option></select><select value={filters.plan} onChange={(e) => changeFilter("plan", e.target.value)}><option value="">全部套餐</option><option value="plus">Plus</option><option value="free">Free</option></select></div><button className={`filter-toggle ${showAdvancedFilters || activeFilterCount ? "filter-active" : ""}`} onClick={() => setShowAdvancedFilters((value) => !value)}><SlidersHorizontal size={16} />筛选{activeFilterCount ? ` ${activeFilterCount}` : ""}</button><button className="reset-filter" disabled={!activeFilterCount} onClick={resetFilters}><RotateCcw size={16} />重置</button></div>
        {showAdvancedFilters && <div className="filter-advanced-row"><select aria-label="支付渠道筛选" value={filters.billingChannel} onChange={(e) => changeFilter("billingChannel", e.target.value)}><option value="">全部支付渠道</option>{billingChannelFilterOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={filters.credential} onChange={(e) => changeFilter("credential", e.target.value)}><option value="">全部凭证</option><option value="at">有 AT</option><option value="rt">有 RT</option><option value="missing">无 AT/RT</option></select><select value={filters.sold} onChange={(e) => changeFilter("sold", e.target.value)}><option value="">全部出售状态</option><option value="true">已售</option><option value="false">未售</option></select><select value={filters.markColor} onChange={(e) => changeFilter("markColor", e.target.value)}><option value="">全部颜色标记</option><option value="none">无标记</option>{Object.entries(markColorLabels).map(([value, label]) => <option key={value} value={value}>{label}标记</option>)}</select><button className={filters.unused ? "filter-active" : ""} onClick={() => changeFilter("unused", filters.unused ? "" : "true")}>审计后空闲</button><button className={filters.sourceStatus ? "filter-active" : ""} onClick={() => changeFilter("sourceStatus", filters.sourceStatus ? "" : "recovered")}>备份恢复</button>{tab === "red-groups" && <select value={filters.redGroup} onChange={(e) => changeFilter("redGroup", e.target.value)}><option value="">选择红色分组</option>{redGroups.map((group, index) => <option key={group.boundaryAccountId} value={group.boundaryAccountId}>第 {index + 1} 组 · {group.count} 个 · {group.boundaryEmail}</option>)}</select>}</div>}
      </section>}

      {tab === "red-groups" && <section className="group-grid">{redGroups.map((group, index) => <button className={filters.redGroup === group.boundaryAccountId ? "active" : ""} key={group.boundaryAccountId} onClick={() => changeFilter("redGroup", group.boundaryAccountId)}><strong>第 {index + 1} 组 · {group.count} 个</strong><span>{group.boundaryEmail}</span><small>活跃 {group.activeCount} · 停用 {group.deactivatedCount}</small><time>{fmt(group.startedAt)} → {fmt(group.endedAt)}</time></button>)}</section>}

      {selected.size > 0 && listTab && <div className="selection-toolbar has-selection"><strong>已选 {selected.size} 个</strong><button className="batch-primary" onClick={() => void copySelectedExports()}>复制选中说明</button><button onClick={() => void copySelectedAccessTokens()}>复制选中 AT</button><button disabled={promotionBatching} onClick={() => void runBulkPromotionCheck()}>{promotionBatching && promotionBatchProgress ? `检测 ${promotionBatchProgress.processed}/${promotionBatchProgress.total}` : "批量检测优惠"}</button><button onClick={() => void exportSelected("txt")}>导出 TXT</button><span className="selection-divider" /><button onClick={selectAll}>{allSelected ? "取消本页" : "全选本页"}</button><button onClick={invertPageSelection}>反选本页</button><button className="toolbar-refresh" disabled={loading} onClick={() => void refreshPage()}>{loading ? "刷新中" : "刷新"}</button><button onClick={clearSelection}>清除选择</button><span className="selection-divider" /><button onClick={() => void exportSelected("csv")}>导出 CSV</button><button onClick={() => void exportSelected("json")}>导出 JSON</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("receiveDisabled", true)}>停止新邮件</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("receiveDisabled", false)}>恢复收件</button><button disabled={overviewData?.readOnly || writing} title="V2 的已售状态必须由客户授权原子创建，不能直接伪造出售记录" onClick={() => setNotice("V2 中“标记已售”必须通过生成客户授权完成，未提供直接批量伪造出售记录的操作。")}>标记已售</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("sold", false)}>恢复未售</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("hidePromotion", true)}>隐藏广告</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("hidePromotion", false)}>显示广告</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("groupBoundary", true)}>设为边界</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("groupBoundary", false)}>取消边界</button><select aria-label="批量颜色标记" value={bulkMarkColor} onChange={(event) => setBulkMarkColor(event.target.value)}><option value="yellow">黄标</option><option value="orange">橙标</option><option value="green">绿标</option><option value="blue">蓝标</option><option value="purple">紫标</option><option value="gray">灰标</option><option value="red">红标</option><option value="none">清除标记</option></select><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("markColor", bulkMarkColor === "none" ? "" : bulkMarkColor)}>应用</button><button disabled={overviewData?.readOnly || writing} className="danger" onClick={() => void runBulk("deactivate", true)}>永久停用</button><button disabled={overviewData?.readOnly || writing} className="danger" onClick={() => void runBulk("delete", true)}>删除选中</button><span className="selection-hint">拖过左侧选择点可连续多选 · 左右滑动查看更多操作</span></div>}

      {promotionBatchProgress && <section className={`promotion-batch-progress ${promotionBatchProgress.status}`} role="status" aria-live="polite">
        <div><span className={`status-led ${promotionBatchProgress.status === "running" ? "blue pulse" : promotionBatchProgress.status === "error" ? "red" : "green"}`} /><strong>{promotionBatchProgress.status === "running" ? "批量优惠检测进行中" : promotionBatchProgress.status === "error" ? "批量优惠检测连接中断" : "批量优惠检测完成"}</strong><span>{promotionBatchProgress.processed} / {promotionBatchProgress.total}</span><button className="promotion-batch-close" aria-label="关闭批量检测状态" onClick={() => setPromotionBatchProgress(null)}>×</button></div>
        <div className="promotion-batch-track"><i style={{ width: `${promotionBatchProgress.total ? Math.round(promotionBatchProgress.processed / promotionBatchProgress.total * 100) : 100}%` }} /></div>
        <small>{promotionBatchProgress.status === "running" ? `检测中 ${promotionBatchProgress.running} · 排队 ${promotionBatchProgress.queued} · 待复查 ${promotionBatchProgress.retrying} · 失败 ${promotionBatchProgress.failed}；结果会逐条刷新。` : promotionBatchProgress.status === "completed" ? `已完成；待复查 ${promotionBatchProgress.retrying} · 失败 ${promotionBatchProgress.failed}。此提示将自动收起。` : "进度连接已中断，可关闭后重新发起或刷新页面查看账号状态。"}</small>
      </section>}

      {error && <div className="page-error">{error}</div>}{notice && <div className="page-notice">{notice}</div>}
      {tab === "import" ? <ImportWorkbench readOnly={Boolean(overviewData?.readOnly)} onRefresh={() => void load()} />
      : tab === "operations" ? <OperationsWorkbench />
      : tab === "share" ? <ShareWorkbench onCopy={copyValue} />
      : tab === "outlook-free" ? <OutlookFreeWorkbench />
      : tab === "reviews" ? <section className="report-panel"><h2>待人工审查</h2>{reviews.length ? reviews.map((review) => <article key={review.id}><strong>{review.candidateEmail || "未识别邮箱"}</strong><Badge tone="yellow">{review.reviewType}</Badge><p>{review.reason}</p><small>{fmt(review.createdAt)} · 账号 {review.accountId || "未关联"}</small><div className="row-actions"><button disabled={overviewData?.readOnly || writing} onClick={() => void resolveReview(review, "keep_separate")}>确认保持分离</button>{review.accountId && review.candidateEmail && <button disabled={overviewData?.readOnly || writing} onClick={() => { if (confirm("确认这是同一GPT身份的改绑？冻结和出售状态不会被清除。")) void resolveReview(review, "confirm_rebind"); }}>确认改绑</button>}<button disabled={overviewData?.readOnly || writing} onClick={() => void resolveReview(review, "dismiss")}>忽略记录</button></div></article>) : <p className="muted">当前没有待审查冲突</p>}</section>
      : tab === "migration" ? <section className="report-panel"><h2>迁移审计与独立同步报告</h2><pre>{JSON.stringify(report, null, 2)}</pre></section>
      : <section className="table-wrap">
        <table><thead><tr><th className="select-col"><input aria-label="选择本页" type="checkbox" checked={allSelected} onChange={selectAll} /></th><th>邮箱</th><th>套餐</th><th>GPT 状态</th><th>OAuth</th><th>{tab === "deactivations" ? "封禁时间" : "试用 / 优惠"}</th><th>操作</th></tr></thead>
        <tbody>{accounts.map((item) => <React.Fragment key={item.id}>
          <tr data-account-id={item.id} className={`account-table-row selection-mode ${item.deactivationLocked ? "deactivated" : ""} ${item.groupBoundary ? "group-boundary" : ""} ${selected.has(item.id) ? "selected-row" : ""}`} onClick={(event) => { if (!(event.target as HTMLElement).closest("button,input,select,summary,details,a")) selectAccount(item.id, event.shiftKey); }}>
            <td className="select-col"><button type="button" className={`selection-handle ${selected.has(item.id) ? "selected" : ""}`} aria-label={`选择 ${item.primaryEmail}`} aria-pressed={selected.has(item.id)} title="按住并上下滑动可连续选择" onPointerDown={(event) => startDragSelection(event, item.id)} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>{selected.has(item.id) ? "✓" : ""}</button></td>
            <td><div className="email-cell"><div className="account-title"><span className={`mark-dot ${item.markColor || "mark-none"}`} title={item.markColor ? `${markColorLabel(item.markColor)}标记` : "无颜色标记"} /><strong title={item.primaryEmail}>{item.primaryEmail}</strong></div><div className="email-meta"><small>{providerLabel(item.provider)} · 录入 {fmt(item.arrivedAt)}{item.sourceStatus === "recovered" ? " · 备份恢复" : ""}</small>{item.isAuto && <small className="auto-text">Auto/API</small>}{item.groupBoundary && <small className="danger-text">红色边界</small>}</div></div></td>
            <td className="plan-cell"><span className={planBadgeClassName(item)}>{planBadgeLabel(item)}</span>{!item.billingChannel && billingChannelStatus(item) && <small className="billing-channel-unconfirmed">{billingChannelStatus(item)}</small>}</td>
            <td className="state-cell"><div><span className={`status-led ${lifecycleTone(item)}`} /><strong>{lifecycleLabel(item)}</strong></div><small>{item.quarantineReason ? `原因：${item.quarantineReason}` : item.deactivationLocked && item.bindingCount > 1 ? "停用锁已继承" : item.suspectedUnused ? "审计后空闲" : item.accountStateLabel || "账号可用"}</small></td>
            <td className="credential-cell"><Badge tone={item.hasAccessToken ? "green" : item.hasStoredAccessToken ? "red" : "gray"} title={item.hasStoredAccessToken && !item.hasAccessToken ? "AT 仍加密保存，可在详情中查看和复制" : ""}>AT {item.hasAccessToken ? "有" : item.hasStoredAccessToken ? "失效" : "无"}</Badge><Badge tone={item.hasRefreshToken ? "green" : item.hasStoredRefreshToken ? "yellow" : "gray"}>RT {item.hasRefreshToken ? "有" : item.hasStoredRefreshToken ? "不可用" : "无"}</Badge>{!item.hasAccessToken && <small className={item.internalPending ? "billing-channel-unconfirmed" : "warning-text"}>{item.credentialStateLabel}</small>}</td>
            <td className="trial-cell">{tab === "deactivations" ? <><div><span className="status-led red" /><strong>{fmtBeijing(item.deactivatedAt)}</strong></div><small>OpenAI 停用锁</small></> : <PromotionStatusCell item={item} />}</td>
            <td><div className="row-actions"><MarkPalette value={item.markColor} disabled={Boolean(overviewData?.readOnly)} saving={markSavingIds.has(item.id)} label={item.primaryEmail} onSelect={(color) => patchMarkColor(item, color)} /><button className="copy-current" disabled={Boolean(copyingAccountId)} title="复制当前账号说明" onClick={(event) => { event.stopPropagation(); void copyCurrentExport(item); }}><ClipboardCopy size={14} />{copyingAccountId === item.id ? "复制中…" : "复制"}</button><button className="detail-toggle" onClick={(event) => { event.stopPropagation(); toggleExpanded(item.id); }}><PanelRightOpen size={14} />{expanded === item.id ? "收起" : "详情"}</button><details className="action-menu" onClick={(event) => event.stopPropagation()}><summary><MoreHorizontal size={15} /><span>更多</span><ChevronDown size={12} /></summary><div className="action-menu-panel">{item.saleStatus === "active" && !item.saleFirstUsedAt && <button disabled={overviewData?.readOnly || writing} onClick={() => void patchAccount(item, { sold: false }, "已取消未使用出售")}>恢复未售</button>}<button onClick={() => toggleExpanded(item.id)}>{item.everSold ? "出售与授权记录" : "出售设置"}</button><button disabled={overviewData?.readOnly || writing || item.promoEligible === true} onClick={() => void setAccountPromotionSuspicion(item)}>{item.promoSuspiciousOverride ? "取消人工优惠存疑" : "标记可能掉优惠"}</button><button disabled={overviewData?.readOnly || writing} onClick={() => void patchAccount(item, { hidePromotion: !item.hidePromotion }, item.hidePromotion ? "已显示广告" : "已隐藏广告")}>{item.hidePromotion ? "显示广告" : "隐藏广告"}</button><button disabled={overviewData?.readOnly || writing} onClick={() => void patchAccount(item, { groupBoundary: !item.groupBoundary }, item.groupBoundary ? "已取消边界" : "已设置边界")}>{item.groupBoundary ? "取消红色边界" : "设为红色边界"}</button><button disabled={overviewData?.readOnly || writing || item.deactivationLocked} className="quick-danger" onClick={() => void deactivateOne(item)}>永久停用</button></div></details></div></td>
          </tr>
        </React.Fragment>)}</tbody></table>
        <div className="pagination"><span className="pagination-total">{tab === "deactivations" ? `共 ${total} 条 · 按封禁时间从新到旧` : `共 ${total} 条 · 新账号在上、旧账号在下；停用、归档和回收不会改变原始到达顺序`}</span><div><button disabled={page === 0} onClick={() => goToPage(0)}>首页</button><button disabled={page === 0} onClick={() => goToPage(Math.max(0, page - 1))}>上一页</button><span>第 {page + 1} / {totalPages} 页</span><button disabled={page + 1 >= totalPages} onClick={() => goToPage(page + 1)}>下一页</button><button disabled={page + 1 >= totalPages} onClick={() => goToPage(totalPages - 1)}>末页</button></div></div>
      </section>}
    </main>
    {expanded && <div className="detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(""); }}>
      <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label={`${expandedItem?.primaryEmail || "账号"}详情`}>
        <header className="detail-drawer-header"><div><span>账号详情</span><strong>{expandedItem?.primaryEmail || "正在读取账号"}</strong><small>绑定 · 授权 · 生命周期 · 支付检查</small>{expandedItem && <div className="detail-drawer-badges"><Badge tone={expandedItem.plan === "plus" ? "green" : "gray"}>{expandedItem.accountStateLabel || (expandedItem.plan === "plus" ? "Plus" : "Free")}</Badge><Badge tone="blue">{providerLabel(expandedItem.provider)}</Badge>{expandedItem.isAuto && <Badge tone="purple">Auto/API</Badge>}<Badge tone={expandedItem.deactivationLocked || expandedItem.identityStatus === "conflict" ? "red" : !expandedItem.hasAccessToken ? "yellow" : "green"}>{expandedItem.deactivationLocked ? "已停用" : expandedItem.identityStatus === "conflict" ? "身份待核对" : !expandedItem.hasAccessToken ? "待补 AT" : "健康"}</Badge></div>}</div><button aria-label="关闭账号详情" onClick={() => setExpanded("")}>×</button></header>
        <div className="detail-drawer-scroll"><AccountExpanded id={expanded} readOnly={Boolean(overviewData?.readOnly)} commandWriter={String(overviewData?.commandWriter || "v2")} onRefresh={load} onCopy={copyValue} /></div>
      </aside>
    </div>}
    <CopyFeedbackToast feedback={copyFeedback} onClose={() => setCopyFeedback(null)} onPreview={() => setCopyPreviewOpen(true)} />
    {copyPreviewOpen && copyFeedback?.text && <CopyPreviewDialog text={copyFeedback.text} onClose={() => setCopyPreviewOpen(false)} onCopyAgain={() => void copyPreviewAgain()} />}
  </div>;
}

function ShareSnapshotApp() {
  const token = useMemo(() => new URLSearchParams(location.hash.replace(/^#/, "")).get("t") || "", []);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api(`/api/share/snapshot?t=${encodeURIComponent(token)}`).then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [token]);
  return <main className="share-snapshot"><header><div><span className="sidebar-brand-mark">O</span><div><h1>{data?.label || "账号概览"}</h1><p>{data ? `${data.count} 个账号 · 剩余 ${data.remainingViews}/${data.maxViews} 次查看` : "正在读取快照"}</p></div></div></header>
    {error && <div className="error">{error}</div>}
    {data && <section className="share-snapshot-table"><table><thead><tr><th>邮箱</th><th>套餐 / 渠道</th><th>邮箱类型</th><th>状态</th></tr></thead><tbody>{data.results.map((item: any, index: number) => <tr key={`${item.emailMasked}-${index}`}><td><strong>{item.emailMasked}</strong></td><td>{item.billingChannel || (item.hasPlus ? "Plus" : "Free")}</td><td>{providerLabel(item.mailboxType)}</td><td>{item.hasDeactivation ? "已停用" : "可用"}</td></tr>)}</tbody></table></section>}
  </main>;
}

const rootElement = document.getElementById("root")!;
if (!location.pathname.startsWith("/adminshare") && !location.pathname.startsWith("/admin")) {
  const legacyMailbox = new URL("https://legacy-mail.example.com/");
  legacyMailbox.search = location.search;
  legacyMailbox.hash = location.hash;
  location.replace(legacyMailbox.toString());
} else {
  const root = createRoot(rootElement);
  root.render(location.pathname.startsWith("/adminshare") ? <ShareSnapshotApp /> : <AdminApp />);
}
