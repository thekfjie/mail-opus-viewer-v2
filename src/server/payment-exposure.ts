import crypto from "node:crypto";
import { config } from "./config.js";
import {
  createPaymentExposureJob,
  finalizePaymentExposureJobReservation,
  getPaymentExposureCredentials,
  getPaymentExposureJob,
  listAutomaticTrialCandidates,
  listPaymentExposureJobs,
  reservePaymentExposureJob,
  updatePaymentExposureJob,
  type PaymentExposureJobRecord,
} from "./repository.js";
import type {
  PaymentExposureCheck,
  PaymentExposureJobItem,
  PaymentExposureJobStatus,
  PaymentExposureMethod,
  PaymentExposureRoute,
} from "../shared/types.js";

type RouteConfig = (typeof config.paymentExposureRoutes)[keyof typeof config.paymentExposureRoutes];

class AutoRequestError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "AutoRequestError";
  }
}

function routeList(): RouteConfig[] {
  return Object.values(config.paymentExposureRoutes);
}

function routeForKey(routeKey: string): RouteConfig | null {
  return routeList().find((route) => route.key === String(routeKey || "").trim().toLowerCase()) || null;
}

function publicRoute(route: RouteConfig): PaymentExposureRoute {
  return {
    key: route.key, label: route.label, target: route.target, ipCountry: route.ipCountry,
    billingCountry: route.billingCountry, billingCurrency: route.billingCurrency, expectedMethod: route.expectedMethod,
    configured: Boolean(route.proxy), promotionConfigured: Boolean(route.promotionProxy), promotionIpCountry: route.promotionProxyRegion,
  };
}

export function listPaymentExposureRoutes(): PaymentExposureRoute[] {
  return routeList().map(publicRoute);
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, limit = 180): string {
  return String(value ?? "").trim().slice(0, limit);
}

function safeEnum(value: unknown, limit = 80): string {
  return text(value, limit).replace(/[^a-zA-Z0-9._:-]/g, "_");
}

function safeJobStatus(value: unknown): string {
  const raw = safeEnum(value, 32).toLowerCase();
  const status = raw === "pending" || raw === "waiting" || raw === "created" ? "queued"
    : raw === "processing" || raw === "in_progress" || raw === "in-progress" ? "running"
      : raw === "succeeded" || raw === "success" || raw === "done" ? "completed"
        : raw === "error" ? "failed" : raw;
  return ["queued", "running", "completed", "failed", "cancelled", "interrupted", "dispatching"].includes(status) ? status : "unknown";
}

function numberValue(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function timestamp(value: unknown): string {
  const candidate = text(value, 64);
  return Number.isFinite(Date.parse(candidate)) ? new Date(candidate).toISOString() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => text(item, 64).toLowerCase()).filter(Boolean))].slice(0, 128)
    : [];
}

function paymentMethods(value: unknown): PaymentExposureMethod[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((item) => ({
    id: text(item.id, 128), type: safeEnum(item.type, 64).toLowerCase(), provider: safeEnum(item.provider, 64).toLowerCase(),
    name: text(item.name, 128), code: text(item.code, 128), displayName: text(item.displayName || item.display_name, 128),
    source: safeEnum(item.source, 64).toLowerCase(),
  })).filter((item) => item.id || item.type || item.name || item.code).slice(0, 128);
}

function exposureObservation(raw: unknown, jobId: string, itemIndex: number, observationIndex: number): PaymentExposureCheck {
  const item = isObject(raw) ? raw : {};
  const promoValue = item.promoEligible ?? item.promo_eligible;
  const promoEligible = promoValue === true ? true : promoValue === false ? false : null;
  const observedAt = timestamp(item.observedAt || item.observed_at) || new Date().toISOString();
  const status = text(item.status, 24).toLowerCase() === "complete" ? "complete" : "unknown";
  const trial = text(item.trialStatus || item.trial_status, 24).toLowerCase();
  return {
    id: text(item.id, 128) || `${jobId}:${itemIndex}:${observationIndex}`,
    target: safeEnum(item.target, 32).toLowerCase(), ipCountry: safeEnum(item.ipCountry || item.ip_country, 8).toUpperCase(),
    billingCountry: safeEnum(item.billingCountry || item.billing_country, 8).toUpperCase(),
    billingCurrency: safeEnum(item.billingCurrency || item.billing_currency, 12).toUpperCase(),
    expectedMethod: safeEnum(item.expectedMethod || item.expected_method, 32).toLowerCase(),
    availableMethods: stringArray(item.availableMethods || item.available_methods),
    matchedMethods: stringArray(item.matchedMethods || item.matched_methods), paymentMethods: paymentMethods(item.paymentMethods || item.payment_methods),
    trialStatus: ["observed", "eligible", "ineligible", "unknown"].includes(trial) ? trial : "unknown",
    exposed: item.exposed === true || Number(item.exposed) === 1, status, checkoutType: safeEnum(item.checkoutType || item.checkout_type, 32),
    detail: "", promoEligible, promoCampaign: text(item.promoCampaign || item.promo_campaign, 128), observedAt, updatedAt: observedAt,
  };
}

function jobItem(raw: unknown, jobId: string, fallbackIndex: number): PaymentExposureJobItem {
  const item = isObject(raw) ? raw : {};
  const result = isObject(item.result) ? item.result : {};
  const observations = (Array.isArray(result.paymentExposure) ? result.paymentExposure : []).map((value, index) => exposureObservation(value, jobId, fallbackIndex, index));
  return {
    index: numberValue(item.index, fallbackIndex), status: safeJobStatus(item.status), stage: safeEnum(item.stage),
    extractionStatus: safeEnum(item.extractionStatus || item.extraction_status), decision: safeEnum(item.decision),
    finishedAt: timestamp(item.finishedAt || item.finished_at), durationMs: numberValue(item.durationMs || item.duration_ms),
    paymentExposure: observations,
  };
}

function publicStatusFromRecord(record: PaymentExposureJobRecord): PaymentExposureJobStatus {
  return {
    jobId: record.jobId, routeKey: record.routeKey, jobKind: record.jobKind, scheduledAt: record.scheduledAt,
    route: publicRoute(routeForKey(record.routeKey)!), status: safeJobStatus(record.status),
    total: 1, queued: record.status === "queued" ? 1 : 0, running: record.status === "running" ? 1 : 0,
    succeeded: record.status === "completed" ? 1 : 0, failed: record.status === "failed" ? 1 : 0,
    cancelled: ["cancelled", "interrupted"].includes(record.status) ? 1 : 0,
    createdAt: record.createdAt, startedAt: record.startedAt, finishedAt: record.finishedAt, durationMs: 0,
    items: [{ index: 1, status: safeJobStatus(record.status), stage: "", extractionStatus: "", decision: "", finishedAt: record.finishedAt, durationMs: 0, paymentExposure: [] }],
  };
}

function publicStatus(record: PaymentExposureJobRecord, rawJob: unknown): PaymentExposureJobStatus {
  const source = isObject(rawJob) && isObject(rawJob.job) ? rawJob.job : rawJob;
  const job = isObject(source) ? source : {};
  const items = Array.isArray(job.items) ? job.items.map((item, index) => jobItem(item, record.jobId, index + 1)) : [];
  const status = safeJobStatus(job.status || record.status);
  return {
    jobId: record.jobId, routeKey: record.routeKey, jobKind: record.jobKind, scheduledAt: record.scheduledAt,
    route: publicRoute(routeForKey(record.routeKey)!), status,
    total: numberValue(job.total, 1), queued: numberValue(job.queued), running: numberValue(job.running),
    succeeded: numberValue(job.succeeded), failed: numberValue(job.failed), cancelled: numberValue(job.cancelled),
    createdAt: timestamp(job.createdAt) || record.createdAt, startedAt: timestamp(job.startedAt) || record.startedAt,
    finishedAt: timestamp(job.finishedAt) || record.finishedAt, durationMs: numberValue(job.durationMs), items,
  };
}

async function autoRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.paymentExposureTimeoutMs);
  const headers = new Headers(init.headers || {});
  headers.set("accept", "application/json");
  if (config.automyaiExtractApiKey) headers.set("X-Extract-API-Key", config.automyaiExtractApiKey);
  try {
    const response = await fetch(`${config.automyaiExtractApiBase}${path}`, { ...init, headers, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new AutoRequestError(response.status, `Auto 提炼服务请求失败（HTTP ${response.status}）`);
    return payload;
  } catch (error) {
    if (error instanceof AutoRequestError) throw error;
    throw new AutoRequestError(0, error instanceof Error && error.name === "AbortError" ? "Auto 提炼服务请求超时" : "无法连接 Auto 提炼服务");
  } finally {
    clearTimeout(timeout);
  }
}

export interface StartPaymentExposureOptions {
  jobKind?: "manual" | "auto_trial" | string;
  expectedAccessTokenFingerprint?: string;
  scheduledAt?: string;
}

export async function startPaymentExposureCheck(
  accountId: string,
  routeKey: string,
  options: StartPaymentExposureOptions = {},
): Promise<PaymentExposureJobStatus> {
  const route = routeForKey(routeKey);
  if (!route) throw new Error("支付检查线路不存在");
  if (!route.proxy) throw new Error(`${route.label} 尚未配置服务端代理`);
  const credentials = getPaymentExposureCredentials(accountId);
  if (!credentials) throw new Error("账号没有可用的加密凭证");
  if (!credentials.accessToken) throw new Error("账号没有可用的 Access Token");
  if (options.expectedAccessTokenFingerprint && credentials.accessTokenFingerprint
    && options.expectedAccessTokenFingerprint !== credentials.accessTokenFingerprint) {
    throw new Error("Access Token 已更换，跳过旧试用检测任务");
  }
  const promotionProxy = route.promotionProxy;
  if (!promotionProxy) throw new Error("JP 优惠检查节点尚未配置");
  const payload = {
    method: "payment_exposure",
    items: [{ accessToken: credentials.accessToken, sessionToken: credentials.sessionToken, email: credentials.email, label: credentials.email }],
    concurrency: 1,
    options: {
      country: route.billingCountry, currency: route.billingCurrency, proxyMode: "custom", proxy: route.proxy,
      promotionProxy, promotionProxyRegion: route.promotionProxyRegion,
      countryProxies: { [route.ipCountry]: route.proxy }, countryPromotionProxies: { [route.promotionProxyRegion]: promotionProxy },
      paymentExposureCheck: true,
      paymentExposureTargets: [{
        target: route.target, ipCountry: route.ipCountry, billingCountry: route.billingCountry,
        billingCurrency: route.billingCurrency, expectedMethod: route.expectedMethod, proxy: route.proxy, promotionProxy,
        promotionProxyRegion: route.promotionProxyRegion,
      }],
      maxAttempts: 1, timeoutSeconds: Math.ceil(config.paymentExposureTimeoutMs / 1000),
      paymentStatusAutoRefresh: false, promoCampaignId: config.paymentExposurePromoCampaign, usePromo: true,
    },
  };
  const now = new Date().toISOString();
  const jobKind = text(options.jobKind || "manual", 32).toLowerCase() || "manual";
  const scheduledAt = timestamp(options.scheduledAt) || now;
  const reservationId = jobKind === "auto_trial" ? `dispatch:${crypto.randomUUID()}` : "";
  if (reservationId) {
    reservePaymentExposureJob({
      jobId: reservationId, accountId, routeKey: route.key, target: route.target, ipCountry: route.ipCountry,
      billingCountry: route.billingCountry, billingCurrency: route.billingCurrency, status: "dispatching",
      lastError: "", startedAt: "", finishedAt: "", createdAt: now, jobKind,
      accessTokenFingerprint: credentials.accessTokenFingerprint, scheduledAt,
    });
  }
  let response: unknown;
  try {
    response = await autoRequest("/api/extract/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch (error) {
    if (reservationId) updatePaymentExposureJob(reservationId, { status: "failed", lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  const rawJob = isObject(response) && isObject(response.job) ? response.job : response;
  const jobId = isObject(rawJob) ? text(rawJob.id || rawJob.jobId, 128) : "";
  if (!jobId) {
    if (reservationId) updatePaymentExposureJob(reservationId, { status: "failed", lastError: "Auto 提炼服务未返回任务编号" });
    throw new Error("Auto 提炼服务未返回任务编号");
  }
  const record = reservationId ? finalizePaymentExposureJobReservation(reservationId, jobId, {
    status: safeJobStatus(isObject(rawJob) ? rawJob.status : "queued"),
  }) : createPaymentExposureJob({
    jobId, accountId, routeKey: route.key, target: route.target, ipCountry: route.ipCountry,
    billingCountry: route.billingCountry, billingCurrency: route.billingCurrency, status: safeJobStatus(isObject(rawJob) ? rawJob.status : "queued"),
    lastError: "", startedAt: "", finishedAt: "", createdAt: now, jobKind, accessTokenFingerprint: credentials.accessTokenFingerprint, scheduledAt,
  });
  if (!record) throw new Error("本地试用检测任务无法保存");
  return publicStatus(record, response);
}

/** Manual one-click trial probe using the same default route as the worker. */
export async function startTrialCheck(accountId: string): Promise<PaymentExposureJobStatus> {
  return startPaymentExposureCheck(accountId, config.autoTrialRouteKey, { jobKind: "manual_trial" });
}

export async function getPaymentExposureCheckStatus(accountId: string, jobId: string): Promise<PaymentExposureJobStatus> {
  const record = getPaymentExposureJob(accountId, jobId);
  if (!record) throw new Error("支付检查任务不存在");
  const route = routeForKey(record.routeKey);
  if (!route) throw new Error("支付检查线路已被移除");
  try {
    const response = await autoRequest(`/api/extract/jobs/${encodeURIComponent(record.jobId)}`);
    const result = publicStatus(record, response);
    const next: Partial<PaymentExposureJobRecord> = { status: result.status };
    if (result.startedAt) next.startedAt = result.startedAt;
    if (result.finishedAt) next.finishedAt = result.finishedAt;
    updatePaymentExposureJob(record.jobId, next);
    return result;
  } catch (error) {
    if (error instanceof AutoRequestError && error.statusCode === 404) {
      const updated = updatePaymentExposureJob(record.jobId, { status: "failed", lastError: "Auto 任务不存在" }) || record;
      return { ...publicStatusFromRecord(updated), pollError: "Auto 任务不存在或已被清理" };
    }
    return { ...publicStatusFromRecord(record), pollError: "暂时无法读取 Auto 任务状态" };
  }
}

export interface AutomaticTrialRunResult {
  enabled: boolean;
  candidates: number;
  started: number;
  failed: number;
  skipped: number;
  errors: Array<{ accountId: string; error: string }>;
}

/** Submit due ATs one at a time so the JP promotion route is not saturated. */
export async function runAutomaticTrialChecks(): Promise<AutomaticTrialRunResult> {
  if (!config.autoTrialEnabled) return { enabled: false, candidates: 0, started: 0, failed: 0, skipped: 0, errors: [] };
  const candidates = listAutomaticTrialCandidates(config.autoTrialBatchSize);
  let started = 0;
  let failed = 0;
  let skipped = 0;
  const errors: Array<{ accountId: string; error: string }> = [];
  for (const candidate of candidates) {
    try {
      await startPaymentExposureCheck(candidate.accountId, candidate.routeKey, {
        jobKind: "auto_trial",
        expectedAccessTokenFingerprint: candidate.accessTokenFingerprint,
        scheduledAt: candidate.dueAt,
      });
      started += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/已更换/.test(message)) skipped += 1;
      else {
        failed += 1;
        errors.push({ accountId: candidate.accountId, error: message.slice(0, 500) });
      }
    }
  }
  return { enabled: true, candidates: candidates.length, started, failed, skipped, errors };
}

export async function refreshAutomaticTrialJobs(): Promise<{ checked: number; completed: number; failed: number }> {
  const jobs = listPaymentExposureJobs(["queued", "running"], "auto_trial");
  let completed = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const result = await getPaymentExposureCheckStatus(job.accountId, job.jobId);
      if (result.status === "completed") completed += 1;
      else if (["failed", "cancelled", "interrupted"].includes(result.status)) failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { checked: jobs.length, completed, failed };
}
