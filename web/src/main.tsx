import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AccountDetail,
  AccountSummary,
  PaymentExposureJobStatus,
  PaymentExposureMethod,
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
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
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

function fmt(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : value;
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
const mailCategoryLabels: Record<string, string> = {
  rebind: "换绑通知", security: "安全邮件", deactivation: "停用通知", billing: "账单", policy: "政策", promotion: "推广", general: "一般",
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

function mailCategoryLabel(value: string): string {
  return mailCategoryLabels[String(value || "").toLowerCase()] || value || "一般";
}

function mailCategoryTone(value: string): string {
  return ["rebind", "security", "deactivation"].includes(String(value || "").toLowerCase()) ? "yellow" : "blue";
}

function lifecycleEventLabel(value: string): string {
  if (value === "email_rebind_notice_detected") return "检测到换绑邮件";
  if (value === "email_binding_changed") return "邮箱绑定已变更";
  if (value === "email_binding_imported") return "导入邮箱绑定";
  if (value === "recycled_mailbox_identity_observed") return "复用邮箱按 OpenAI 身份归代";
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

function paymentMethodSnapshotLabel(method: PaymentExposureMethod): string {
  return method.displayName || method.name || method.type || method.code || method.id || "未命名方法";
}

function paymentMethodSnapshotTone(method: PaymentExposureMethod): string {
  return method.id || method.type === "custom" ? "purple" : "blue";
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

function billingChannelLabel(value: string): string {
  return billingChannelLabels[String(value || "").toLowerCase()] || value || "—";
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
  return exposed ? "red" : "green";
}

function paymentExposureLabel(status: string, exposed = false): string {
  if (status !== "complete") return "未知";
  return exposed ? "已暴露" : "未暴露";
}

function accountExposureLabel(item: AccountSummary): string {
  switch (item.paymentExposureStatus) {
    case "exposed": return `已暴露 ${item.paymentExposureExposedCount}`;
    case "not_exposed": return "未暴露";
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

function PaymentExposureSection({
  accountId,
  checks,
  autoTrialStatus,
  autoTrialDueAt,
  onRefresh,
}: {
  accountId: string;
  checks: AccountDetail["paymentExposureChecks"];
  autoTrialStatus: string;
  autoTrialDueAt: string;
  onRefresh: () => void | Promise<void>;
}) {
  const [routes, setRoutes] = useState<PaymentExposureRoute[]>([]);
  const [selectedRoute, setSelectedRoute] = useState("");
  const [job, setJob] = useState<PaymentExposureJobStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [trialStarting, setTrialStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setJob(null); setError("");
    api<{ routes: PaymentExposureRoute[] }>("/api/v2/admin/payment-exposure/routes", { signal: controller.signal })
      .then((data) => {
        if (!active) return;
        const nextRoutes = Array.isArray(data.routes) ? data.routes : [];
        setRoutes(nextRoutes);
        setSelectedRoute((current) => nextRoutes.some((route) => route.key === current) ? current : "");
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

  const selected = routes.find((route) => route.key === selectedRoute);
  const jobRunning = Boolean(job && !["completed", "failed", "cancelled", "interrupted"].includes(job.status));
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
    if (trialStarting || jobRunning) return;
    setTrialStarting(true); setError("");
    try {
      const next = await api<PaymentExposureJobStatus>(`/api/v2/admin/accounts/${accountId}/trial-check`, { method: "POST" });
      setJob(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTrialStarting(false);
    }
  };
  const liveChecks = job?.items.flatMap((item) => item.paymentExposure || []) || [];
  return <section className="payment-exposure-section">
    <div className="payment-exposure-heading"><div><h3>支付方式 / 试用检测</h3><small>新 AT 首次发现满 12 小时后由 Worker 自动检测；手动试用检测使用默认线路，优惠统一通过 JP 节点查询 plus-1-month-free</small></div><span>{checks.length ? `最近 ${checks.length} 项` : "暂无结果"}</span></div>
    <div className="payment-exposure-controls">
      <select aria-label="选择支付检查 IP 出口" value={selectedRoute} onChange={(event) => setSelectedRoute(event.target.value)} disabled={starting || jobRunning || !routes.length}>
        {!routes.length && <option value="">正在读取检测出口…</option>}
        {routes.length > 0 && <option value="">选择检测 IP / 出口</option>}
        {routes.map((route) => <option key={route.key} value={route.key} disabled={!route.configured || !route.promotionConfigured}>{route.ipCountry} 出口 · {paymentMethodLabel(route.expectedMethod)} · {route.billingCurrency}{route.configured && route.promotionConfigured ? "" : " · 未配置"}</option>)}
      </select>
      <button className="primary" disabled={!selected?.configured || !selected?.promotionConfigured || starting || jobRunning} onClick={() => void start()}>{starting ? "提交中…" : jobRunning ? "检测进行中…" : "开始检测"}</button>
      <button disabled={trialStarting || jobRunning} onClick={() => void startTrial()}>{trialStarting ? "试用提交中…" : "试用检测"}</button>
      {selected && <span className={selected.configured && selected.promotionConfigured ? "route-ready" : "route-missing"}>{selected.configured ? `${selected.ipCountry} 出口已就绪 · 账单 ${selected.billingCountry}/${selected.billingCurrency}${selected.promotionConfigured ? ` · ${selected.promotionIpCountry} 优惠预检` : " · JP 优惠节点未配置"}` : "需要先配置服务端代理"}</span>}
      {!selected && routes.length > 0 && <span className="route-missing">请选择一个已配置的检测 IP / 出口</span>}
    </div>
    <div className="payment-exposure-auto-status"><span>自动试用：<Badge tone={autoTrialStatus === "completed" ? "green" : ["queued", "running", "dispatching"].includes(autoTrialStatus) ? "blue" : autoTrialStatus === "failed" ? "red" : "gray"}>{exposureJobStatusLabel(autoTrialStatus === "not_scheduled" ? "unknown" : autoTrialStatus)}</Badge></span>{autoTrialDueAt && <small>首次 AT {fmt(autoTrialDueAt)} 前后到期</small>}</div>
    {error && <div className="payment-exposure-error">{error}</div>}
    {job && <div className="payment-exposure-job"><div className="payment-exposure-job-heading"><span><Badge tone={exposureJobStatusTone(job.status)}>{exposureJobStatusLabel(job.status)}</Badge><span>{job.route.label}</span></span><small>{job.jobId}</small></div>{job.items.map((item) => <div className="payment-exposure-job-item" key={`${job.jobId}-${item.index}`}><span>账号任务 {item.index}</span><span>{item.stage || item.extractionStatus || "等待阶段"}</span><span>{item.finishedAt ? fmt(item.finishedAt) : "进行中"}</span></div>)}{job.pollError && <small className="route-missing">{job.pollError}</small>}{liveChecks.length > 0 && <div className="payment-exposure-live-methods">{liveChecks.map((check) => <span key={check.id}><Badge tone={paymentExposureTone(check.status, check.exposed)}>{paymentMethodLabel(check.target)} · {paymentExposureLabel(check.status, check.exposed)}</Badge>{check.paymentMethods.map((method, index) => <Badge key={`${check.id}-${index}`} tone={paymentMethodSnapshotTone(method)}>{paymentMethodSnapshotLabel(method)}{method.id ? ` · ${method.id}` : ""}</Badge>)}</span>)}</div>}</div>}
    {checks.length ? <div className="payment-exposure-list">{checks.map((check) => <div className="payment-exposure-row" key={check.id}>
      <div className="payment-exposure-target"><strong>{paymentMethodLabel(check.target)}</strong><small>{check.ipCountry} IP · 账单 {check.billingCountry}/{check.billingCurrency}</small></div>
      <div><Badge tone={paymentExposureTone(check.status, check.exposed)}>{paymentExposureLabel(check.status, check.exposed)}</Badge><Badge tone="blue">{check.status}</Badge></div>
      <div className="payment-exposure-methods">
        <span>结构化支付能力</span>
        {check.paymentMethods.length ? <div className="payment-method-list">{check.paymentMethods.map((method, index) => <span className="payment-method-item" key={`${method.id || method.type || method.name}-${index}`}>
          <Badge tone={paymentMethodSnapshotTone(method)}>{paymentMethodSnapshotLabel(method)}</Badge>
          {method.id && <code title="上游原始支付方法 ID">{method.id}</code>}
          {(method.provider || method.code || method.source) && <small>{[method.provider, method.code && `code=${method.code}`, method.source && `source=${method.source}`].filter(Boolean).join(" · ")}</small>}
        </span>)}</div> : <small>未返回结构化明细</small>}
        <small>命中：{check.matchedMethods.length ? check.matchedMethods.map(paymentMethodLabel).join(", ") : "—"} · 可用汇总：{check.availableMethods.length ? check.availableMethods.map(paymentMethodLabel).join(", ") : "—"}</small>
      </div>
      <div className="payment-exposure-meta"><Badge tone={trialStatusTone(check.trialStatus)}>{trialStatusLabel(check.trialStatus)}</Badge><span>{check.promoEligible === null ? "优惠未知" : check.promoEligible ? "优惠可用" : "优惠不可用"}</span><time>{fmt(check.observedAt || check.updatedAt)}</time></div>
    </div>)}</div> : <p className="muted">该账号尚未完成支付方式检查。</p>}
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
  v1SourceRecords: number; readOnly: boolean; latestSync?: { status: string; finished_at: string; binding_count: number; relation_count: number };
  latestSub2Sync?: { status: string; finished_at: string; active_openai_count: number; matched_count: number; created_count: number; skipped_count: number };
}

interface RedGroup { boundaryAccountId: string; boundaryEmail: string; startedAt: string; endedAt: string; count: number; deactivatedCount: number; activeCount: number; }
interface PendingReview { id: string; reviewType: string; accountId: string; candidateEmail: string; reason: string; createdAt: string; }
interface CurrentCustomerExport { currentEmail: string; loginIdentifier: string; publicUrl: string; text: string; }
interface BulkCurrentExport extends CurrentCustomerExport { id: string; available: boolean; reason?: string; }
interface BulkCredential { id: string; primaryEmail: string; accessToken: string; }
interface ReleaseInfo { gitCommit?: string; builtAt?: string; artifactSha256?: string; frontendEntry?: string; }
const PAGE_SIZE = 24;

function AccountExpanded({ id, readOnly, onRefresh }: { id: string; readOnly: boolean; onRefresh: () => void }) {
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [error, setError] = useState("");
  const [credentials, setCredentials] = useState<Record<string, string> | null>(null);
  const [grants, setGrants] = useState<Array<Record<string, any>>>([]);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
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
  if (error) return <div className="expanded error">{error}</div>;
  if (!detail) return <div className="expanded muted">正在读取账号时间线…</div>;
  const currentBinding = detail.bindings.find((binding) => binding.isCurrent);
  const canIssueGrant = detail.lifecycleStatus === "active" && !detail.deactivationLocked && detail.identityStatus !== "conflict"
    && (!detail.everSold || detail.saleStatus === "active");
  return <div className="expanded detail-content">
    <section className="account-context">
      <div className="account-context-heading"><h3>账号概览</h3><span>{detail.sourceStatus === "recovered" ? "来自 V1 备份" : "来自 V1 当前记录"}</span></div>
      <div className="account-context-badges">
        <Badge tone={detail.plan === "plus" ? "green" : "gray"}>{detail.accountStateLabel || (detail.plan === "plus" ? "Plus" : "Free")}</Badge>
        <Badge tone="blue">{detail.provider}</Badge>
        {detail.domainMailbox && <Badge tone="purple">域名邮箱</Badge>}
        {billingChannelStatus(detail) && <Badge tone={billingChannelStatusTone(detail)}>{billingChannelStatus(detail)}</Badge>}
        {detail.markColor && <Badge tone={markColorTone(detail.markColor)}><span className={`mark-dot ${detail.markColor}`} />{markColorLabel(detail.markColor)}标记</Badge>}
        {detail.groupBoundary && <Badge tone="red">红色分组边界</Badge>}
        {detail.suspectedUnused && <Badge tone="yellow">审计后空闲</Badge>}
        {detail.hidePromotion && <Badge tone="gray">隐藏广告</Badge>}
        {detail.saleStatus === "active" && <Badge tone="purple">当前已售</Badge>}
      </div>
    </section>

    <section className="detail-actions detail-quick-actions">
      <div className="detail-section-heading"><h3>常用操作</h3><small>{readOnly ? "当前为只读影子" : "操作会写入 V2"}</small></div>
      <div className="detail-action-grid">
        <button onClick={async () => setCredentials(await api(`/api/v2/admin/accounts/${id}/credentials`))}>读取 OAuth 凭证</button>
        <button disabled={readOnly} onClick={() => { const note = prompt("账号备注", detail.note); if (note !== null) void write(`/api/v2/admin/accounts/${id}`, "PATCH", { note }); }}>编辑备注</button>
        <button disabled={readOnly} onClick={() => { const paymentLink = prompt("Stripe / 支付链接", detail.paymentLink); if (paymentLink !== null) void write(`/api/v2/admin/accounts/${id}`, "PATCH", { paymentLink }); }}>支付链接</button>
        <button disabled={readOnly || !currentBinding || (detail.everSold && !detail.deactivationLocked)} onClick={() => { const email = prompt("改绑后的新邮箱（完整本地部分必须一致）"); if (email) void write(`/api/v2/admin/accounts/${id}/rebind`, "POST", { email }); }}>新增改绑</button>
        <button disabled={readOnly || !currentBinding || !canIssueGrant} onClick={() => { if (currentBinding && confirm(detail.saleStatus === "active" ? "重置当前客户权限？旧链接和现有登录会立即失效。" : "为当前绑定建立首次出售并生成客户权限？")) void write(`/api/v2/admin/accounts/${id}/grants`, "POST", { bindingId: currentBinding.id }); }}>{detail.saleStatus === "active" ? "重置当前客户授权" : "生成首次客户授权"}</button>
        <button disabled={readOnly || !currentBinding} className="danger" onClick={() => { const email = prompt("回收后新 GPT 账号使用的全新邮箱"); if (email && confirm("将创建全新账号；旧账号与旧客户不会继承新邮箱权限。确定？")) void write(`/api/v2/admin/accounts/${id}/recycle`, "POST", { email, plan: "free" }); }}>回收为新账号</button>
        {detail.saleStatus === "active" && !detail.saleFirstUsedAt && <button disabled={readOnly} onClick={() => { if (confirm("该授权尚未使用，确定取消并恢复未售？")) void write(`/api/v2/admin/accounts/${id}`, "PATCH", { sold: false }); }}>取消未使用出售</button>}
      </div>
      {!canIssueGrant && detail.sellBlockers.length > 0 && <span className="muted">禁止出售：{detail.sellBlockers.join("、")}</span>}
    </section>

    <details className="detail-group" open>
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

    <details className="detail-group" open>
      <summary><span>客户授权</span><small>{grants.length} 条记录</small></summary>
      <div className="detail-group-body">{grants.length ? grants.map((grant) => <div className="timeline-row grant-row" key={grant.id}>
        <strong>{grant.loginIdentifier}</strong><Badge tone={grant.active ? "green" : "gray"}>{grant.active ? grant.scope : "已撤销"}</Badge>
        <span>{grant.visibleTo ? `截止 ${fmt(grant.visibleTo)}` : "当前授权"}{grant.firstUsedAt ? ` · 已使用 ${fmt(grant.firstUsedAt)}` : " · 尚未使用"}</span>
        {grant.active && <button disabled={readOnly} onClick={() => { if (confirm("撤销这个客户取件授权？")) void write(`/api/v2/admin/accounts/${id}/grants/${grant.id}`, "DELETE", {}); }}>撤销</button>}
      </div>) : <p className="muted">暂无客户授权；admin_only 不展示</p>}</div>
    </details>

    <details className="detail-group">
      <summary><span>支付与试用检测</span><small>{detail.paymentExposureChecks?.length || 0} 项结果</small></summary>
      <div className="detail-group-body"><PaymentExposureSection accountId={id} checks={detail.paymentExposureChecks || []} autoTrialStatus={detail.autoTrialStatus} autoTrialDueAt={detail.autoTrialDueAt} onRefresh={async () => { await loadDetail(); onRefresh(); }} /></div>
    </details>

    <details className="detail-group">
      <summary><span>生命周期</span><small>{Math.min(detail.timeline.length, 12)} 项最近事件</small></summary>
      <div className="detail-group-body">{detail.timeline.slice(0, 12).map((event) => <div className="timeline-row" key={event.id}>
        <span className="timeline-dot event" /><strong>{lifecycleEventLabel(event.eventType)}</strong><span>{fmt(event.occurredAt)}</span>
      </div>)}</div>
    </details>

    <details className="detail-group">
      <summary><span>备注与支付链接</span><small>{detail.note ? "已有备注" : "暂无备注"}</small></summary>
      <div className="detail-group-body detail-note"><p>{detail.note || "暂无备注"}</p>{detail.paymentLink && <p className="muted">支付链接已填写</p>}</div>
    </details>

    {credentials && <pre className="secret-box">{JSON.stringify(credentials, null, 2)}</pre>}
    {result && <pre className="secret-box action-result">{JSON.stringify(result, null, 2)}</pre>}
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
  const [copyPreviewOpen, setCopyPreviewOpen] = useState(false);
  const [writing, setWriting] = useState(false);
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
  const [importText, setImportText] = useState('[\n  {"email":"name@example.com","accessToken":"","refreshToken":"","idToken":"","openaiPassword":"","plan":"free","note":""}\n]');
  const [importResult, setImportResult] = useState<Record<string, unknown> | null>(null);
  const [theme, setTheme] = useState(localStorage.getItem("opus-v2-admin-theme") || "light");
  const [bulkMarkColor, setBulkMarkColor] = useState("yellow");
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [showOverview, setShowOverview] = useState(() => window.matchMedia("(min-width: 701px)").matches);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [filters, setFilters] = useState({ search: "", range: "all", status: "", provider: "", billingChannel: "", sold: "", plan: "", credential: "", sourceStatus: "", unused: "", redGroup: "", markColor: "", pending: "exclude" });

  useEffect(() => { document.documentElement.dataset.theme = localStorage.getItem("opus-v2-theme") || "dark"; }, []);
  useEffect(() => { localStorage.setItem("opus-v2-admin-theme", theme); }, [theme]);
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
  const openTab = (next: string) => {
    setTab(next); setPage(0); clearSelection(); setExpanded("");
    if (next === "domains") setFilters((value) => ({ ...value, provider: "domain", billingChannel: "", plan: "", credential: "", unused: "", redGroup: "", markColor: "", pending: "exclude" }));
    else if (next === "idle") setFilters((value) => ({ ...value, provider: "", billingChannel: "", plan: "free", credential: "missing", unused: "true", redGroup: "", markColor: "", pending: "exclude" }));
    else if (next === "red-groups") setFilters((value) => ({ ...value, provider: "", billingChannel: "", plan: "", credential: "", unused: "", redGroup: redGroups[0]?.boundaryAccountId || "", markColor: "", pending: "exclude" }));
    else if (next === "accounts") setFilters((value) => ({ ...value, provider: "", billingChannel: "", plan: "", credential: "", unused: "", redGroup: "", markColor: "", pending: "exclude" }));
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
  const patchAccount = async (item: AccountSummary, patch: Record<string, unknown>, label: string) => {
    if (overviewData?.readOnly || writing) return;
    setWriting(true); setError(""); setNotice("");
    try {
      await api(`/api/v2/admin/accounts/${item.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      setNotice(`${item.primaryEmail}：${label}`); await load();
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
    setError(""); setNotice(""); setCopyFeedback(null);
    let completeText = "";
    try {
      const output = await api<CurrentCustomerExport>(`/api/v2/admin/accounts/${item.id}/current-export`);
      completeText = String(output.text || "");
      const receipt = await copyText(completeText);
      copySucceeded(`${output.currentEmail}：复制成功`, completeText, receipt, "当前邮箱说明");
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
  const runImport = async () => {
    setError(""); setImportResult(null);
    try {
      const parsed = JSON.parse(importText);
      const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts;
      if (!Array.isArray(accounts)) throw new Error("请输入 JSON 数组，或包含 accounts 数组的对象");
      setImportResult(await api<Record<string, unknown>>("/api/v2/admin/import/accounts", { method: "POST", body: JSON.stringify({ accounts }) }));
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
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
    domains: "域名邮箱",
    idle: "审计空闲",
    "red-groups": "红色分组",
    import: "导入账号",
    reviews: "待审查",
    migration: "迁移报告",
  };
  const navItems = Object.entries(tabLabels);
  const listTab = !["reviews", "migration", "import"].includes(tab);
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
      <nav className="sidebar-nav sidebar-nav-all" aria-label="V2 功能导航">{navItems.map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => openTab(value)}><span>{label}</span>{value === "accounts" && <small>{overviewData?.visibleAccounts || 0}</small>}{value === "domains" && <small>{overviewData?.visibleDomains || 0}</small>}{value === "idle" && <small>{overviewData?.visibleUnused || 0}</small>}</button>)}</nav>
      <div className="sidebar-status"><Badge tone={overviewData?.readOnly ? "yellow" : "green"}>{overviewData?.readOnly ? "只读影子" : "V2 单写"}</Badge><small>账号状态、换绑与客户权限分离</small></div>
    </aside>

    <main className="admin-main">
      <header className="topbar"><div><p className="eyebrow">账号管理</p><h1>{tabLabels[tab] || "Opus Mail"}</h1><p>当前邮箱只是绑定阶段，永久停用与出售状态归属于同一个 GPT 身份</p><small className="release-id">版本 {String(release?.gitCommit || "未标记").slice(0, 8)} · 构建 {release?.builtAt ? fmt(release.builtAt) : "未知"}</small></div><div className="top-actions"><button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "浅色" : "深色"}</button><button disabled={loading} onClick={() => void refreshPage()}>{loading ? (loadState.listReadyAt ? "同步中" : "刷新中") : "刷新"}</button><button onClick={async () => { loadRequest.current.controller?.abort(); await api("/api/v2/admin/logout", { method: "POST" }); hasUsableAccountList.current = false; setLoadState(idleAdminLoadState); setAuthenticated(false); }}>退出</button></div></header>

      {loadStatus && <section className={`load-status load-status-${loadStatus.tone}`} role={loadStatus.tone === "error" ? "alert" : "status"} aria-live="polite" data-load-phase={loadStatus.tone}><span className="load-status-indicator" /><div><strong>{loadStatus.title}</strong><small>{loadStatus.detail}</small></div></section>}

      {overviewData && listTab && <section className={`overview-shell ${showOverview ? "open" : ""}`}>
        <button className="overview-toggle" aria-expanded={showOverview} onClick={() => setShowOverview((value) => !value)}><span><strong>账号概览</strong><small>普通 {overviewData.visibleAccounts} · 活跃 {overviewData.visibleActive} · 已售 {overviewData.sold} · 无 AT {overviewData.actionableMissingAt}</small></span><b>{showOverview ? "收起" : "展开"}</b></button>
        {showOverview && <div className="metric-grid">
          <div><span>普通账号</span><strong>{overviewData.visibleAccounts}</strong><small>任务临时邮箱不建立账号映射</small></div>
          <div><span>活跃账号</span><strong className="green-text">{overviewData.visibleActive}</strong><small>当前可继续处理</small></div>
          <div><span>永久停用</span><strong className="red-text">{overviewData.deactivated}</strong><small>改绑后仍保持停用</small></div>
          <div><span>已售账号</span><strong className="purple-text">{overviewData.sold}</strong><small>当前客户授权中</small></div>
          <div><span>域名邮箱</span><strong className="blue-text">{overviewData.visibleDomains}</strong><small>已排除内部占位</small></div>
          <div><span>需处理无 AT</span><strong className="yellow-text">{overviewData.actionableMissingAt}</strong><small>已排除注册池与换绑占位</small></div>
        </div>}
      </section>}

      {listTab && <section className={`filters ${showAdvancedFilters ? "show-advanced" : ""}`}>
        <div className="filter-main-row"><input className="search" value={filters.search} onChange={(e) => changeFilter("search", e.target.value)} placeholder="搜索邮箱、渠道或备注" /><div className="quick-filters"><select value={filters.range} onChange={(e) => changeFilter("range", e.target.value)}><option value="all">全部时间</option><option value="day">一天内</option><option value="week">一周内</option><option value="two_weeks">两周内</option></select><select value={filters.status} onChange={(e) => changeFilter("status", e.target.value)}><option value="">全部状态</option><option value="active">活跃</option><option value="deactivated">永久停用</option><option value="retired">历史回收</option><option value="quarantined">归属待核对</option></select><select value={filters.provider} onChange={(e) => changeFilter("provider", e.target.value)}><option value="">全部邮箱</option><option value="icloud">iCloud</option><option value="outlook">Outlook</option><option value="domain">域名邮箱</option></select><select value={filters.plan} onChange={(e) => changeFilter("plan", e.target.value)}><option value="">全部套餐</option><option value="plus">Plus</option><option value="free">Free</option></select></div><button className={`filter-toggle ${showAdvancedFilters || activeFilterCount ? "filter-active" : ""}`} onClick={() => setShowAdvancedFilters((value) => !value)}>筛选{activeFilterCount ? ` ${activeFilterCount}` : ""} {showAdvancedFilters ? "收起" : "展开"}</button></div>
        {showAdvancedFilters && <div className="filter-advanced-row"><select aria-label="支付渠道筛选" value={filters.billingChannel} onChange={(e) => changeFilter("billingChannel", e.target.value)}><option value="">全部支付渠道</option>{billingChannelFilterOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={filters.credential} onChange={(e) => changeFilter("credential", e.target.value)}><option value="">全部凭证</option><option value="at">有 AT</option><option value="rt">有 RT</option><option value="missing">无 AT/RT</option></select><select value={filters.sold} onChange={(e) => changeFilter("sold", e.target.value)}><option value="">全部客户状态</option><option value="true">已售</option><option value="false">未售</option></select><select value={filters.markColor} onChange={(e) => changeFilter("markColor", e.target.value)}><option value="">全部颜色标记</option><option value="none">无标记</option>{Object.entries(markColorLabels).map(([value, label]) => <option key={value} value={value}>{label}标记</option>)}</select><button className={filters.unused ? "filter-active" : ""} onClick={() => changeFilter("unused", filters.unused ? "" : "true")}>审计后空闲</button><button className={filters.sourceStatus ? "filter-active" : ""} onClick={() => changeFilter("sourceStatus", filters.sourceStatus ? "" : "recovered")}>备份恢复</button>{tab === "red-groups" && <select value={filters.redGroup} onChange={(e) => changeFilter("redGroup", e.target.value)}><option value="">选择红色分组</option>{redGroups.map((group, index) => <option key={group.boundaryAccountId} value={group.boundaryAccountId}>第 {index + 1} 组 · {group.count} 个 · {group.boundaryEmail}</option>)}</select>}</div>}
      </section>}

      {tab === "red-groups" && <section className="group-grid">{redGroups.map((group, index) => <button className={filters.redGroup === group.boundaryAccountId ? "active" : ""} key={group.boundaryAccountId} onClick={() => changeFilter("redGroup", group.boundaryAccountId)}><strong>第 {index + 1} 组 · {group.count} 个</strong><span>{group.boundaryEmail}</span><small>活跃 {group.activeCount} · 停用 {group.deactivatedCount}</small><time>{fmt(group.startedAt)} → {fmt(group.endedAt)}</time></button>)}</section>}

      {selected.size > 0 && listTab && <div className="selection-toolbar has-selection"><strong>已选 {selected.size} 个</strong><button className="batch-primary" onClick={() => void copySelectedExports()}>复制选中说明</button><button onClick={() => void copySelectedAccessTokens()}>复制选中 AT</button><button onClick={() => void exportSelected("txt")}>导出 TXT</button><span className="selection-divider" /><button onClick={selectAll}>{allSelected ? "取消本页" : "全选本页"}</button><button onClick={invertPageSelection}>反选本页</button><button className="toolbar-refresh" disabled={loading} onClick={() => void refreshPage()}>{loading ? "刷新中" : "刷新"}</button><button onClick={clearSelection}>清除选择</button><span className="selection-divider" /><button onClick={() => void exportSelected("csv")}>导出 CSV</button><button onClick={() => void exportSelected("json")}>导出 JSON</button><button disabled={overviewData?.readOnly || writing} title="V2 的已售状态必须由客户授权原子创建，不能直接伪造出售记录" onClick={() => setNotice("V2 中“标记已售”必须通过生成客户授权完成，未提供直接批量伪造出售记录的操作。")}>标记已售</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("sold", false)}>恢复未售</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("hidePromotion", true)}>隐藏广告</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("hidePromotion", false)}>显示广告</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("groupBoundary", true)}>设为边界</button><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("groupBoundary", false)}>取消边界</button><select aria-label="批量颜色标记" value={bulkMarkColor} onChange={(event) => setBulkMarkColor(event.target.value)}><option value="yellow">黄标</option><option value="orange">橙标</option><option value="green">绿标</option><option value="blue">蓝标</option><option value="purple">紫标</option><option value="gray">灰标</option><option value="red">红标</option><option value="none">清除标记</option></select><button disabled={overviewData?.readOnly || writing} onClick={() => void runBulk("markColor", bulkMarkColor === "none" ? "" : bulkMarkColor)}>应用</button><button disabled={overviewData?.readOnly || writing} className="danger" onClick={() => void runBulk("deactivate", true)}>永久停用</button><button disabled={overviewData?.readOnly || writing} className="danger" onClick={() => void runBulk("delete", true)}>删除选中</button><span className="selection-hint">拖过左侧选择点可连续多选 · 左右滑动查看更多操作</span></div>}

      {error && <div className="page-error">{error}</div>}{notice && <div className="page-notice">{notice}</div>}
      {tab === "import" ? <section className="report-panel import-panel"><h2>导入账号与 OAuth 凭证</h2><p className="muted">备注只写 note；AT、RT、ID Token 和 GPT 密码分别进入加密凭证字段。新账号和新绑定默认不分配客户权限。</p><textarea value={importText} onChange={(event) => setImportText(event.target.value)} spellCheck={false} /><div><button className="primary" disabled={overviewData?.readOnly} onClick={() => void runImport()}>开始导入</button>{overviewData?.readOnly && <span className="muted"> 当前只读，切换单写后才可执行</span>}</div>{importResult && <pre>{JSON.stringify(importResult, null, 2)}</pre>}</section>
      : tab === "reviews" ? <section className="report-panel"><h2>待人工审查</h2>{reviews.length ? reviews.map((review) => <article key={review.id}><strong>{review.candidateEmail || "未识别邮箱"}</strong><Badge tone="yellow">{review.reviewType}</Badge><p>{review.reason}</p><small>{fmt(review.createdAt)} · 账号 {review.accountId || "未关联"}</small><div className="row-actions"><button disabled={overviewData?.readOnly || writing} onClick={() => void resolveReview(review, "keep_separate")}>确认保持分离</button>{review.accountId && review.candidateEmail && <button disabled={overviewData?.readOnly || writing} onClick={() => { if (confirm("确认这是同一GPT身份的改绑？冻结和出售状态不会被清除。")) void resolveReview(review, "confirm_rebind"); }}>确认改绑</button>}<button disabled={overviewData?.readOnly || writing} onClick={() => void resolveReview(review, "dismiss")}>忽略记录</button></div></article>) : <p className="muted">当前没有待审查冲突</p>}</section>
      : tab === "migration" ? <section className="report-panel"><h2>影子迁移与同步报告</h2><pre>{JSON.stringify(report, null, 2)}</pre></section>
      : <section className="table-wrap">
        <div className="table-title"><div className="table-title-meta"><strong>{tabLabels[tab]}列表</strong><span className="count-chip">{loadState.phase === "initial" ? "加载中" : total}</span><small>第 {page + 1} / {totalPages} 页 · 每页 {PAGE_SIZE} 条</small></div><div className="table-title-actions"><details className="selection-help"><summary>操作提示</summary><p>新账号在上、旧账号在下；停用、归档和回收不会改变原始到达顺序。点击行可选择，Shift 点击或按住左侧选择点上下滑动可连续多选。</p></details><button onClick={selectAll}>{allSelected ? "取消本页" : "选择本页"}</button><button onClick={invertPageSelection}>反选</button>{selected.size > 0 && <button onClick={clearSelection}>清空 {selected.size}</button>}</div></div>
        <table><thead><tr><th className="select-col"><input type="checkbox" checked={allSelected} onChange={selectAll} /></th><th>当前邮箱</th><th>GPT 状态</th><th>OAuth</th><th>客户状态</th><th>操作</th></tr></thead>
        <tbody>{accounts.map((item) => <React.Fragment key={item.id}>
          <tr data-account-id={item.id} className={`account-table-row selection-mode ${item.deactivationLocked ? "deactivated" : ""} ${item.groupBoundary ? "group-boundary" : ""} ${selected.has(item.id) ? "selected-row" : ""}`} onClick={(event) => { if (!(event.target as HTMLElement).closest("button,input,select,summary,details,a")) selectAccount(item.id, event.shiftKey); }}>
            <td className="select-col"><button type="button" className={`selection-handle ${selected.has(item.id) ? "selected" : ""}`} aria-label={`选择 ${item.primaryEmail}`} aria-pressed={selected.has(item.id)} title="按住并上下滑动可连续选择" onPointerDown={(event) => startDragSelection(event, item.id)} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>{selected.has(item.id) ? "✓" : ""}</button></td>
            <td><div className="email-cell"><div className="account-title"><span className={`mark-dot ${item.markColor || "mark-none"}`} title={item.markColor ? `${markColorLabel(item.markColor)}标记` : "无颜色标记"} /><strong title={item.primaryEmail}>{item.primaryEmail}</strong></div><div className="email-meta"><Badge tone={item.domainMailbox ? "purple" : "blue"}>{providerLabel(item.provider)}</Badge><small>{item.bindingCount > 1 ? `${item.bindingCount} 次绑定` : "首次绑定"}{item.sourceStatus === "recovered" ? " · 备份恢复" : ""}</small>{item.groupBoundary && <small className="danger-text">红色边界</small>}</div></div></td>
            <td className="state-cell"><div><Badge tone={lifecycleTone(item)}>{lifecycleLabel(item)}</Badge><span className={`plan-badge ${item.plan === "plus" ? "plus" : "free"}`}>{item.plan === "plus" ? "PLUS" : "FREE"}</span></div>{item.quarantineReason && <small className="warning-text">原因：{item.quarantineReason}</small>}{item.deactivationLocked && item.bindingCount > 1 && <small className="danger-text">停用锁已继承到当前邮箱</small>}{item.suspectedUnused && !item.deactivationLocked && <small className="warning-text">审计后空闲</small>}{billingChannelStatus(item) && <small className={item.billingChannel ? "billing-channel-known" : "billing-channel-unconfirmed"}>{billingChannelStatus(item)}</small>}{item.trialStatus !== "unknown" && <small className="trial-status-line">试用：{trialStatusLabel(item.trialStatus)}{item.promoEligible === true ? " · 1个月优惠可用" : item.promoEligible === false ? " · 优惠不可用" : ""}</small>}{item.autoTrialStatus !== "not_scheduled" && <small className="trial-status-line">自动试用：{exposureJobStatusLabel(item.autoTrialStatus)}</small>}</td>
            <td className="credential-cell"><Badge tone={item.hasAccessToken ? "green" : "gray"}>AT {item.hasAccessToken ? "有" : "无"}</Badge><Badge tone={item.hasRefreshToken ? "green" : "gray"}>RT {item.hasRefreshToken ? "有" : "无"}</Badge>{!item.hasAccessToken && <small className={item.internalPending ? "billing-channel-unconfirmed" : "warning-text"}>{item.credentialStateLabel}</small>}</td>
            <td><Badge tone={item.saleStatus === "active" ? "purple" : item.everSold ? "gray" : "neutral"}>{item.saleStatus === "active" ? "已确认出售" : item.everSold ? "历史已售" : "销售未标记"}</Badge><small>{item.customerGrantCount} 个有效授权{item.hidePromotion ? " · 已隐藏广告" : ""}</small></td>
            <td><div className="row-actions"><button className="copy-current" onClick={(event) => { event.stopPropagation(); void copyCurrentExport(item); }}>复制</button><button className="detail-toggle" onClick={(event) => { event.stopPropagation(); toggleExpanded(item.id); }}>{expanded === item.id ? "收起" : "详情"}</button><details className="action-menu" onClick={(event) => event.stopPropagation()}><summary>更多</summary><div className="action-menu-panel">{item.saleStatus === "active" && !item.saleFirstUsedAt && <button disabled={overviewData?.readOnly || writing} onClick={() => void patchAccount(item, { sold: false }, "已取消未使用出售")}>恢复未售</button>}<button onClick={() => toggleExpanded(item.id)}>{item.everSold ? "出售与授权记录" : "出售设置"}</button><button disabled={overviewData?.readOnly || writing} onClick={() => void patchAccount(item, { hidePromotion: !item.hidePromotion }, item.hidePromotion ? "已显示广告" : "已隐藏广告")}>{item.hidePromotion ? "显示广告" : "隐藏广告"}</button><button disabled={overviewData?.readOnly || writing} onClick={() => void patchAccount(item, { groupBoundary: !item.groupBoundary }, item.groupBoundary ? "已取消边界" : "已设置边界")}>{item.groupBoundary ? "取消红色边界" : "设为红色边界"}</button><label><span>颜色标记</span><select className="mark-select" aria-label={`${item.primaryEmail} 颜色标记`} value={item.markColor || "none"} onChange={(event) => { const value = event.target.value === "none" ? "" : event.target.value; void patchAccount(item, { markColor: value }, value ? `已设为${markColorLabel(value)}标记` : "已清除颜色标记"); }}><option value="none">无标记</option>{Object.entries(markColorLabels).map(([value, label]) => <option key={value} value={value}>{label}标记</option>)}</select></label><button disabled={overviewData?.readOnly || writing || item.deactivationLocked} className="quick-danger" onClick={() => void deactivateOne(item)}>永久停用</button></div></details></div></td>
          </tr>
        </React.Fragment>)}</tbody></table>
        <div className="pagination"><button disabled={page === 0} onClick={() => goToPage(0)}>首页</button><button disabled={page === 0} onClick={() => goToPage(Math.max(0, page - 1))}>上一页</button><span>第 {page + 1} / {totalPages} 页 · {total ? page * PAGE_SIZE + 1 : 0}–{Math.min(total, (page + 1) * PAGE_SIZE)} / {total}</span><button disabled={page + 1 >= totalPages} onClick={() => goToPage(page + 1)}>下一页</button><button disabled={page + 1 >= totalPages} onClick={() => goToPage(totalPages - 1)}>末页</button></div>
      </section>}
    </main>
    {expanded && <div className="detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(""); }}>
      <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label={`${expandedItem?.primaryEmail || "账号"}详情`}>
        <header className="detail-drawer-header"><div><span>账号详情</span><strong>{expandedItem?.primaryEmail || "正在读取账号"}</strong><small>绑定、授权、生命周期和支付检查</small></div><button aria-label="关闭账号详情" onClick={() => setExpanded("")}>×</button></header>
        <div className="detail-drawer-scroll"><AccountExpanded id={expanded} readOnly={Boolean(overviewData?.readOnly)} onRefresh={load} /></div>
      </aside>
    </div>}
    <CopyFeedbackToast feedback={copyFeedback} onClose={() => setCopyFeedback(null)} onPreview={() => setCopyPreviewOpen(true)} />
    {copyPreviewOpen && copyFeedback?.text && <CopyPreviewDialog text={copyFeedback.text} onClose={() => setCopyPreviewOpen(false)} onCopyAgain={() => void copyPreviewAgain()} />}
  </div>;
}

interface MailItem { id: string; from: string; subject: string; created_at: string; category: string; }
function CustomerApp() {
  const [session, setSession] = useState(false);
  const [login, setLogin] = useState({ email: "", password: "" });
  const [mails, setMails] = useState<MailItem[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [error, setError] = useState("");
  const queryToken = useMemo(() => new URLSearchParams(location.hash.replace(/^#/, "")).get("m") || "", []);
  const loadMails = () => api<{ results: MailItem[] }>("/api/mails").then((data) => { setMails(data.results); setSession(true); }).catch(() => setSession(false));
  useEffect(() => {
    const start = async () => { try { if (queryToken) { await api("/api/preset", { method: "POST", body: JSON.stringify({ m: queryToken }) }); history.replaceState(null, "", location.pathname); } await loadMails(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
    start();
  }, []);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(""); try { await api("/api/login", { method: "POST", body: JSON.stringify(login) }); await loadMails(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  if (!session) return <main className="mailbox-shell"><form className="mailbox-login" onSubmit={submit}><div className="mail-logo">O</div><h1>邮箱验证码</h1><p>查看与你账号关联的 OpenAI 邮件</p>
    <input value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} placeholder="邮箱" /><input type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} placeholder="接码密码" />
    <button className="primary">打开邮箱</button>{error && <div className="error">{error}</div>}</form></main>;
  return <main className="mailbox-app"><header><div><h1>最近邮件</h1><p>邮箱地址和转发信息已隐藏</p></div><button onClick={loadMails}>刷新</button></header>
    <div className="mail-layout"><section className="mail-list">{mails.map((mail) => <button className={selected?.id === mail.id ? "active" : ""} key={mail.id} onClick={async () => { setError(""); try { const data = await api<any>(`/api/mail-detail?id=${encodeURIComponent(mail.id)}`); setSelected({ ...mail, ...data.mail }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }}>
      <span><strong>{mail.from}</strong><Badge tone={mailCategoryTone(mail.category)}>{mailCategoryLabel(mail.category)}</Badge></span><b>{mail.subject}</b><time>{fmt(mail.created_at)}</time></button>)}</section>
      <article className="mail-detail">{selected ? <><h2>{selected.subject}</h2><p className="muted">{selected.from} · {fmt(selected.created_at)}</p><pre>{selected.text || "正在读取正文…"}</pre></> : <div className="empty">选择一封邮件查看内容</div>}{error && <div className="error">{error}</div>}</article>
    </div></main>;
}

const root = createRoot(document.getElementById("root")!);
root.render(location.pathname.startsWith("/admin") ? <AdminApp /> : <CustomerApp />);
