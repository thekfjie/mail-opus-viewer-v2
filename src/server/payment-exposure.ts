import crypto from "node:crypto";
import { config } from "./config.js";
import { effectivePaymentEligibilityApi, paymentEligibilityApiSummary } from "./check-routes.js";
import {
  createPaymentExposureJob,
  getPaymentExposureCredentials,
  getPaymentExposureJob,
  listPaymentExposureChecks,
  savePaymentEligibilityObservation,
  updatePaymentExposureJob,
  type PaymentExposureJobRecord,
} from "./repository.js";
import type { PaymentExposureCheck, PaymentExposureJobStatus, PaymentExposureRoute } from "../shared/types.js";

type RouteConfig = (typeof config.paymentExposureRoutes)[keyof typeof config.paymentExposureRoutes];

function routeList(): RouteConfig[] {
  return Object.values(config.paymentExposureRoutes);
}

function routeForKey(routeKey: string): RouteConfig | null {
  return routeList().find((route) => route.key === String(routeKey || "").trim().toLowerCase()) || null;
}

function publicRoute(route: RouteConfig): PaymentExposureRoute {
  const api = paymentEligibilityApiSummary();
  return {
    key: route.key,
    label: route.label,
    target: route.target,
    ipCountry: route.ipCountry,
    billingCountry: route.billingCountry,
    billingCurrency: route.billingCurrency,
    expectedMethod: route.expectedMethod,
    configured: api.configured,
    promotionConfigured: false,
    promotionIpCountry: "JP",
    source: api.source === "saved" ? "saved" : api.configured ? "environment" : "none",
    addressDisplay: api.endpoint,
  };
}

export function listPaymentExposureRoutes(): PaymentExposureRoute[] {
  return routeList().map(publicRoute);
}

function text(value: unknown, limit = 500): string {
  return String(value ?? "").trim().slice(0, limit);
}

function timestamp(value: unknown): string {
  const candidate = text(value, 64);
  return Number.isFinite(Date.parse(candidate)) ? new Date(candidate).toISOString() : "";
}

function selectedEligibility(payload: Record<string, unknown>, target: string): { eligible: boolean | null; reason: string } {
  const field = `${target}_eligible`;
  const reasonField = `${target}_eligible_reason`;
  const raw = payload[field];
  const eligible = raw === true ? true : raw === false ? false : null;
  const reason = text(payload[reasonField] ?? payload.reason ?? payload.error ?? payload.message
    ?? (eligible === null ? `${field} 未返回` : eligible ? "eligible" : "ineligible"));
  return { eligible, reason };
}

async function requestPaymentEligibility(accessToken: string): Promise<{ status: number; payload: Record<string, unknown> }> {
  const integration = effectivePaymentEligibilityApi();
  if (!integration.endpoint) throw new Error("支付资格检查接口尚未配置");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.paymentExposureTimeoutMs);
  const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
  if (integration.apiToken) headers.set("authorization", `Bearer ${integration.apiToken}`);
  try {
    const response = await fetch(integration.endpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        token: accessToken,
        promoId: config.paymentExposurePromoCampaign,
        check_gcash_pm: false,
      }),
    });
    const parsed = await response.json().catch(() => ({}));
    const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    if (!response.ok && !Object.keys(payload).length) throw new Error(`支付资格接口请求失败（HTTP ${response.status}）`);
    return { status: response.status, payload };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("支付资格接口请求超时");
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

function publicStatus(record: PaymentExposureJobRecord, check?: PaymentExposureCheck): PaymentExposureJobStatus {
  const status = record.status;
  const completed = status === "completed";
  const failed = status === "failed";
  const durationMs = record.startedAt && record.finishedAt
    ? Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt)) : 0;
  return {
    jobId: record.jobId,
    routeKey: record.routeKey,
    jobKind: record.jobKind,
    scheduledAt: record.scheduledAt,
    route: publicRoute(routeForKey(record.routeKey)!),
    status,
    total: 1,
    queued: status === "queued" ? 1 : 0,
    running: status === "running" ? 1 : 0,
    succeeded: completed ? 1 : 0,
    failed: failed ? 1 : 0,
    cancelled: 0,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs,
    items: [{
      index: 1,
      status,
      stage: "eligibility_api",
      extractionStatus: completed ? "complete" : failed ? "failed" : status,
      decision: check?.exposed ? "eligible" : check?.status === "complete" ? "ineligible" : "unknown",
      finishedAt: record.finishedAt,
      durationMs,
      paymentExposure: check ? [check] : [],
    }],
  };
}

export interface StartPaymentExposureOptions {
  jobKind?: "manual" | string;
  expectedAccessTokenFingerprint?: string;
  scheduledAt?: string;
}

export async function startPaymentExposureCheck(
  accountId: string,
  routeKey: string,
  options: StartPaymentExposureOptions = {},
): Promise<PaymentExposureJobStatus> {
  const route = routeForKey(routeKey);
  if (!route) throw new Error("支付资格检查项目不存在");
  if (!paymentEligibilityApiSummary().configured) throw new Error("支付资格检查接口尚未配置");
  const credentials = getPaymentExposureCredentials(accountId);
  if (!credentials?.accessToken) throw new Error("账号没有可用的 Access Token");
  if (options.expectedAccessTokenFingerprint && credentials.accessTokenFingerprint
    && options.expectedAccessTokenFingerprint !== credentials.accessTokenFingerprint) {
    throw new Error("Access Token 已更换，跳过旧检测任务");
  }

  const startedAt = new Date().toISOString();
  const jobId = `eligibility:${crypto.randomUUID()}`;
  let record = createPaymentExposureJob({
    jobId,
    accountId,
    routeKey: route.key,
    target: route.target,
    ipCountry: route.ipCountry,
    billingCountry: route.billingCountry,
    billingCurrency: route.billingCurrency,
    status: "running",
    lastError: "",
    startedAt,
    finishedAt: "",
    createdAt: startedAt,
    jobKind: text(options.jobKind || "manual", 32) || "manual",
    accessTokenFingerprint: credentials.accessTokenFingerprint,
    scheduledAt: timestamp(options.scheduledAt) || startedAt,
  });

  try {
    const response = await requestPaymentEligibility(credentials.accessToken);
    const selected = selectedEligibility(response.payload, route.target);
    const reason = selected.reason || `资格接口 HTTP ${response.status}`;
    const check = savePaymentEligibilityObservation(accountId, {
      target: route.target,
      ipCountry: route.ipCountry,
      billingCountry: route.billingCountry,
      billingCurrency: route.billingCurrency,
      eligible: selected.eligible,
      reason,
    });
    record = updatePaymentExposureJob(jobId, {
      status: selected.eligible === null ? "failed" : "completed",
      lastError: selected.eligible === null ? reason : "",
      finishedAt: new Date().toISOString(),
    }) || record;
    return publicStatus(record, check);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updatePaymentExposureJob(jobId, { status: "failed", lastError: message, finishedAt: new Date().toISOString() });
    throw new Error(message);
  }
}

/** Compatibility export; automatic promotion checks now live in promotion.ts. */
export async function startTrialCheck(accountId: string): Promise<PaymentExposureJobStatus> {
  return startPaymentExposureCheck(accountId, config.autoTrialRouteKey, { jobKind: "manual_legacy" });
}

export async function getPaymentExposureCheckStatus(accountId: string, jobId: string): Promise<PaymentExposureJobStatus> {
  const record = getPaymentExposureJob(accountId, jobId);
  if (!record) throw new Error("支付资格检查任务不存在");
  const check = listPaymentExposureChecks(accountId)
    .find((item) => item.target === record.target && item.checkoutType === "eligibility_api");
  return publicStatus(record, check);
}

export interface AutomaticTrialRunResult {
  enabled: boolean;
  candidates: number;
  started: number;
  failed: number;
  skipped: number;
  errors: Array<{ accountId: string; error: string }>;
}

/** Deprecated: promotion.ts owns the 12-hour JP promotion schedule. */
export async function runAutomaticTrialChecks(): Promise<AutomaticTrialRunResult> {
  return { enabled: false, candidates: 0, started: 0, failed: 0, skipped: 0, errors: [] };
}

export async function refreshAutomaticTrialJobs(): Promise<{ checked: number; completed: number; failed: number }> {
  return { checked: 0, completed: 0, failed: 0 };
}
