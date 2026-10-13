import { asyncMap } from './async-collections.js';
import crypto from "node:crypto";
import { config } from "./config.js";
import {
  createPaymentExposureJob,
  finalizePaymentExposureJobReservation,
  getAccountDetail,
  getPaymentExposureCredentials,
  getPaymentExposureJob,
  listPaymentExposureChecks,
  listPaymentExposureJobs,
  savePaymentEligibilityObservation,
  updatePaymentExposureJob,
  type PaymentExposureJobRecord,
} from "./repository.js";
import type { PaymentExposureCheck, PaymentExposureJobStatus, PaymentExposurePromoMode, PaymentExposureRoute } from "../shared/types.js";

const ONE_MONTH_PROMO_CAMPAIGN = "plus-1-month-free";

function paymentExposurePromoMode(value: unknown): Exclude<PaymentExposurePromoMode, "unknown"> {
  return String(value || "").trim().toLowerCase() === "one_month" ? "one_month" : "none";
}

function extractorPromoOptions(mode: Exclude<PaymentExposurePromoMode, "unknown">): Record<string, unknown> {
  return mode === "one_month"
    ? { usePromo: true, promoCampaignId: ONE_MONTH_PROMO_CAMPAIGN, promotionStrategy: "native" }
    : { usePromo: false, promoCampaignId: "", promotionStrategy: "none" };
}

type RouteConfig = (typeof config.paymentExposureRoutes)[keyof typeof config.paymentExposureRoutes];

function routeList(): RouteConfig[] {
  return Object.values(config.paymentExposureRoutes);
}

function routeForKey(routeKey: string): RouteConfig | null {
  return routeList().find((route) => route.key === String(routeKey || "").trim().toLowerCase()) || null;
}

function publicRoute(route: RouteConfig): PaymentExposureRoute {
  return {
    key: route.key,
    label: route.label,
    target: route.target,
    ipCountry: route.ipCountry,
    billingCountry: route.billingCountry,
    billingCurrency: route.billingCurrency,
    expectedMethod: route.expectedMethod,
    configured: Boolean(config.paymentMethodExtractApiBase),
    promotionConfigured: false,
    promotionIpCountry: "",
    source: config.paymentMethodExtractApiBase ? "environment" : "none",
    addressDisplay: config.paymentMethodExtractApiBase ? "本机提炼服务" : "",
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

interface ExtractorJobEnvelope {
  ok?: boolean;
  error?: string;
  job?: Record<string, unknown>;
}

function extractorEndpoint(pathname: string): string {
  const base = String(config.paymentMethodExtractApiBase || "").trim();
  if (!base) throw new Error("本机支付方式提炼服务尚未配置");
  let parsed: URL;
  try { parsed = new URL(base); } catch { throw new Error("本机支付方式提炼服务地址无效"); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error("支付方式观察只允许调用本机提炼服务");
  }
  return `${base}${pathname}`;
}

async function extractorJSON(method: "GET" | "POST", pathname: string, body?: Record<string, unknown>): Promise<ExtractorJobEnvelope> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.paymentExposureTimeoutMs);
  const headers = new Headers({ accept: "application/json" });
  if (body) headers.set("content-type", "application/json");
  if (config.paymentMethodExtractApiKey) headers.set("x-extract-api-key", config.paymentMethodExtractApiKey);
  try {
    const response = await fetch(extractorEndpoint(pathname), {
      method,
      headers,
      signal: controller.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = await response.json().catch(() => ({}));
    const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ExtractorJobEnvelope : {};
    if (!response.ok) throw new Error(text(payload.error, 500) || `本机支付方式提炼服务请求失败（HTTP ${response.status}）`);
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("本机支付方式提炼服务请求超时");
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

function extractorJobStatus(job: Record<string, unknown>): string {
  const value = text(job.status, 40).toLowerCase();
  return ["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(value) ? value : "running";
}

function extractorJobItem(job: Record<string, unknown>): Record<string, unknown> {
  const items = Array.isArray(job.items) ? job.items : [];
  const item = items[0];
  return item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
}

function extractorTokenHash(accessToken: string): string {
  return crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

function extractorJobItems(job: Record<string, unknown>): Record<string, unknown>[] {
  return (Array.isArray(job.items) ? job.items : [])
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function extractorItemStatus(item: Record<string, unknown>, fallback: string): string {
  switch (text(item.status, 40).toLowerCase()) {
    case "succeeded":
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "interrupted": return "interrupted";
    case "queued": return "queued";
    case "running": return "running";
    default: return fallback;
  }
}

async function extractorItemForRecord(job: Record<string, unknown>, record: PaymentExposureJobRecord): Promise<{
  item: Record<string, unknown> | null;
  error: string;
}> {
  const items = extractorJobItems(job);
  const credentials = (await getPaymentExposureCredentials(record.accountId));
  if (credentials?.accessToken
    && (!record.accessTokenFingerprint || credentials.accessTokenFingerprint === record.accessTokenFingerprint)) {
    const tokenHash = extractorTokenHash(credentials.accessToken);
    const item = items.find((candidate) => text(candidate.tokenHash, 64).toLowerCase() === tokenHash);
    if (item) return { item, error: "" };
  }
  if (items.length === 1 && (!record.remoteJobId || record.remoteJobId === record.jobId || record.jobKind !== "bulk")) {
    return { item: items[0], error: "" };
  }
  if (credentials && record.accessTokenFingerprint
    && credentials.accessTokenFingerprint !== record.accessTokenFingerprint) {
    return { item: null, error: "账号 Access Token 已更换，无法映射原批次结果" };
  }
  return { item: null, error: "远程批次未返回该账号对应的 tokenHash item" };
}

function extractorResult(item: Record<string, unknown>): Record<string, unknown> {
  const value = item.result;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 64) : [];
}

function paymentMethodArray(value: unknown): PaymentExposureCheck["paymentMethods"] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item)).map((item: any) => ({
    id: text(item.id, 128), type: text(item.type, 64).toLowerCase(), provider: text(item.provider, 64).toLowerCase(),
    name: text(item.name, 128), code: text(item.code, 128), displayName: text(item.displayName ?? item.display_name, 128),
    source: text(item.source, 64).toLowerCase(),
    sources: stringArray(item.sources),
  })).filter((item) => item.id || item.type || item.name || item.code).slice(0, 128);
}

function paymentExtractorObservation(job: Record<string, unknown>, route: RouteConfig, itemOverride?: Record<string, unknown>): {
  eligible: boolean | null; reason: string; observedAt: string; availableMethods: string[]; matchedMethods: string[];
  paymentMethods: PaymentExposureCheck["paymentMethods"]; promoEligible: boolean | null; trialStatus: string;
  checkoutType: string; promoCampaign: string;
} {
  const item = itemOverride || extractorJobItem(job);
  const result = extractorResult(item);
  const metadata = result.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)
    ? result.metadata as Record<string, unknown> : {};
  const observations = Array.isArray(result.paymentExposure) ? result.paymentExposure : [];
  const observation = observations.find((value) => value && typeof value === "object" && !Array.isArray(value)
    && text((value as Record<string, unknown>).target, 64).toLowerCase() === route.target) as Record<string, unknown> | undefined;
  const status = text(observation?.status, 40).toLowerCase();
  const exposed = observation?.exposed;
  const eligible = status === "complete" && typeof exposed === "boolean" ? exposed : null;
  const availableMethods = stringArray(observation?.availableMethods ?? result.availableMethods);
  const matchedMethods = stringArray(observation?.matchedMethods);
  const paymentMethods = paymentMethodArray(observation?.paymentMethods);
  const promoEligible = typeof observation?.promoEligible === "boolean" ? observation.promoEligible
    : typeof metadata.promoEligible === "boolean" ? metadata.promoEligible : null;
  const trialStatus = text(observation?.trialStatus, 32).toLowerCase() || "unknown";
  const checkoutType = text(observation?.checkoutType, 32).toLowerCase();
  const promoCampaign = text(observation?.promoCampaign ?? metadata.promoCampaign, 128);
  const reason = text(observation?.detail ?? item.error ?? item.detail ?? result.decision
    ?? (eligible === true ? `${route.expectedMethod} 已暴露` : eligible === false ? `${route.expectedMethod} 未暴露` : "本机提炼未返回明确支付方式观察结果"));
  return {
    eligible,
    reason: reason || (eligible === true ? `${route.expectedMethod} 已暴露` : eligible === false ? `${route.expectedMethod} 未暴露` : "本机提炼未返回明确支付方式观察结果"),
    observedAt: timestamp(observation?.observedAt ?? item.finishedAt ?? job.finishedAt) || new Date().toISOString(),
    availableMethods, matchedMethods, paymentMethods, promoEligible, trialStatus, checkoutType, promoCampaign,
  };
}

function publicStatus(record: PaymentExposureJobRecord, check?: PaymentExposureCheck, pollError = ""): PaymentExposureJobStatus {
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
    promoMode: record.promoMode,
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
      stage: "payment_method_exposure",
      extractionStatus: completed ? "complete" : failed ? "failed" : status,
      decision: check?.exposed ? "eligible" : check?.status === "complete" ? "ineligible" : "unknown",
      finishedAt: record.finishedAt,
      durationMs,
      paymentExposure: check ? [check] : [],
    }],
    ...(pollError ? { pollError } : {}),
  };
}

async function refreshPaymentExtractorJob(record: PaymentExposureJobRecord, supplied?: Record<string, unknown>): Promise<PaymentExposureJobStatus> {
  const route = routeForKey(record.routeKey);
  if (!route) throw new Error("支付资格检查项目不存在");
  let job = supplied;
  try {
    if (!job) {
      const response = await extractorJSON("GET", `/api/extract/jobs/${encodeURIComponent(record.remoteJobId || record.jobId)}`);
      job = response.job;
    }
  } catch (error) {
    const check = (await listPaymentExposureChecks(record.accountId)).find((item) => item.target === route.target && item.checkoutType === "local_extractor");
    return publicStatus(record, check, error instanceof Error ? error.message : String(error));
  }
  if (!job) return publicStatus(record, undefined, "本机支付方式提炼服务未返回任务");
  const remoteStatus = extractorJobStatus(job);
  const mapped = (await extractorItemForRecord(job, record));
  const itemStatus = mapped.item ? extractorItemStatus(mapped.item, remoteStatus) : remoteStatus;
  let updated = (await updatePaymentExposureJob(record.jobId, {
    status: itemStatus,
    startedAt: timestamp(mapped.item?.startedAt ?? job.startedAt) || record.startedAt,
    finishedAt: timestamp(mapped.item?.finishedAt ?? (itemStatus === remoteStatus ? job.finishedAt : "")) || record.finishedAt,
  })) || record;
  let check = (await listPaymentExposureChecks(record.accountId)).find((item) => item.target === route.target && item.checkoutType === "local_extractor");
  if (["completed", "failed", "cancelled", "interrupted"].includes(itemStatus)) {
    if (!mapped.item) {
      updated = (await updatePaymentExposureJob(record.jobId, {
        status: "failed", lastError: mapped.error, finishedAt: timestamp(job.finishedAt) || new Date().toISOString(),
      })) || updated;
      return publicStatus(updated, check);
    }
    const observation = paymentExtractorObservation(job, route, mapped.item);
    if (typeof observation.eligible === "boolean") {
      const effectivePromoMode = record.promoMode === "one_month"
        ? observation.promoEligible === true ? "one_month" : observation.promoEligible === false ? "none" : "unknown"
        : record.promoMode;
      check = (await savePaymentEligibilityObservation(record.accountId, {
        target: route.target, ipCountry: route.ipCountry, billingCountry: route.billingCountry, billingCurrency: route.billingCurrency,
        eligible: observation.eligible, reason: observation.reason, observedAt: observation.observedAt, source: "local_extractor",
        promoMode: effectivePromoMode,
        promoEligible: observation.promoEligible,
        promoCampaign: observation.promoCampaign,
        trialStatus: observation.trialStatus,
        // checkoutType identifies the storage/ingestion path, not the
        // upstream checkout chain (oaics vs Stripe). The latter is retained
        // in paymentMethods.source and must not hide this local observation.
        checkoutType: "local_extractor",
        replaceMethods: true,
        availableMethods: observation.availableMethods, matchedMethods: observation.matchedMethods, paymentMethods: observation.paymentMethods,
      }));
      updated = (await updatePaymentExposureJob(record.jobId, {
        status: "completed", lastError: "", finishedAt: observation.observedAt,
      })) || updated;
    } else {
      updated = (await updatePaymentExposureJob(record.jobId, {
        status: itemStatus === "cancelled" || itemStatus === "interrupted" ? itemStatus : "failed",
        lastError: observation.reason, finishedAt: observation.observedAt,
      })) || updated;
    }
  }
  return publicStatus(updated, check);
}

async function startPaymentExtractorCheck(
  accountId: string,
  route: RouteConfig,
  credentials: { accessToken: string; accessTokenFingerprint: string },
  options: StartPaymentExposureOptions,
): Promise<PaymentExposureJobStatus> {
  const startedAt = new Date().toISOString();
  const reservationId = `payment-exposure-dispatch:${crypto.randomUUID()}`;
  let record = (await createPaymentExposureJob({
    jobId: reservationId, accountId, routeKey: route.key, target: route.target,
    ipCountry: route.ipCountry, billingCountry: route.billingCountry, billingCurrency: route.billingCurrency,
    status: "dispatching", lastError: "", startedAt, finishedAt: "", createdAt: startedAt,
    jobKind: text(options.jobKind || "manual", 32) || "manual",
    promoMode: paymentExposurePromoMode(options.promoMode),
    accessTokenFingerprint: credentials.accessTokenFingerprint,
    scheduledAt: timestamp(options.scheduledAt) || startedAt,
  }));
  try {
    const response = await extractorJSON("POST", "/api/extract/jobs", {
      method: "payment_exposure",
      input: credentials.accessToken,
      concurrency: 1,
      options: {
        ...extractorPromoOptions(paymentExposurePromoMode(options.promoMode)),
        paymentStatusAutoRefresh: false,
        paymentExposureCheck: true,
        paymentExposureTargets: [{
          target: route.target,
          ipCountry: route.ipCountry,
          billingCountry: route.billingCountry,
          billingCurrency: route.billingCurrency,
          expectedMethod: route.expectedMethod,
        }],
      },
    });
    const job = response.job;
    const remoteJobId = text(job?.id, 120);
    if (!job || !remoteJobId) throw new Error("本机支付方式提炼服务未返回任务编号");
    record = (await finalizePaymentExposureJobReservation(reservationId, remoteJobId, {
      status: extractorJobStatus(job), startedAt: timestamp(job.startedAt) || startedAt, finishedAt: timestamp(job.finishedAt), lastError: "",
    })) || record;
    return refreshPaymentExtractorJob(record, job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (await updatePaymentExposureJob(reservationId, { status: "failed", lastError: message, finishedAt: new Date().toISOString() }));
    throw new Error(message);
  }
}

export interface StartPaymentExposureOptions {
  jobKind?: "manual" | string;
  expectedAccessTokenFingerprint?: string;
  scheduledAt?: string;
  promoMode?: PaymentExposurePromoMode;
}

export async function startPaymentExposureCheck(
  accountId: string,
  routeKey: string,
  options: StartPaymentExposureOptions = {},
): Promise<PaymentExposureJobStatus> {
  const route = routeForKey(routeKey);
  if (!route) throw new Error("支付资格检查项目不存在");
  if (!config.paymentMethodExtractApiBase) throw new Error("本机支付方式提炼服务尚未配置");
  const credentials = (await getPaymentExposureCredentials(accountId));
  if (!credentials?.accessToken) throw new Error("账号没有可用的 Access Token");
  if (options.expectedAccessTokenFingerprint && credentials.accessTokenFingerprint
    && options.expectedAccessTokenFingerprint !== credentials.accessTokenFingerprint) {
    throw new Error("Access Token 已更换，跳过旧检测任务");
  }
  return startPaymentExtractorCheck(accountId, route, credentials, options);
}

export interface PaymentExposureBatchResult {
  requested: number;
  requestedJobs: number;
  started: number;
  skipped: number;
  failed: number;
  jobs: PaymentExposureJobStatus[];
  jobAccounts: Array<{ accountId: string; jobId: string }>;
  errors: Array<{ accountId: string; routeKey?: string; error: string; skipped?: boolean }>;
}

/** Start the configured local method probes for selected, not-yet-billed accounts. */
export async function startPaymentExposureBatch(accountIds: string[], routeKeys: string[] = [], promoModeInput: PaymentExposurePromoMode = "none"): Promise<PaymentExposureBatchResult> {
  if (accountIds.length > 24) throw new Error("批量支付方式探查单次最多选择 24 个账号");
  if (routeKeys.length !== 1) throw new Error("批量支付方式探查必须先选择一个具体 method");
  const ids = [...new Set(accountIds.map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 24);
  if (!ids.length) throw new Error("请选择至少一个账号");
  const route = routeForKey(routeKeys[0]);
  if (!route) throw new Error("支付方式探查项目不存在");
  const promoMode = paymentExposurePromoMode(promoModeInput);
  const result: PaymentExposureBatchResult = { requested: ids.length, requestedJobs: 0, started: 0, skipped: 0, failed: 0, jobs: [], jobAccounts: [], errors: [] };
  const selected: Array<{ accountId: string; credentials: { accessToken: string; accessTokenFingerprint: string } }> = [];
  for (const accountId of ids) {
    const detail = (await getAccountDetail(accountId));
    if (!detail) {
      result.failed += 1;
      result.errors.push({ accountId, error: "账号不存在" });
      continue;
    }
    const billed = String(detail.plan || "").toLowerCase() === "plus" || Boolean(detail.billingStartedAt) || Boolean(detail.billingChannel);
    if (billed) {
      result.skipped += 1;
      result.errors.push({ accountId, error: "账号已开通或已有账单，跳过支付方式探查", skipped: true });
      continue;
    }
    const credentials = (await getPaymentExposureCredentials(accountId));
    if (!credentials?.accessToken) {
      result.failed += 1;
      result.errors.push({ accountId, routeKey: route.key, error: "账号没有可用的 Access Token" });
      continue;
    }
    selected.push({ accountId, credentials });
  }
  if (!selected.length) return result;

  const startedAt = new Date().toISOString();
  const reservations = (await asyncMap(selected, async ({ accountId, credentials }) => (await createPaymentExposureJob({
    jobId: `payment-exposure-dispatch:${crypto.randomUUID()}`, accountId, routeKey: route.key, target: route.target,
    ipCountry: route.ipCountry, billingCountry: route.billingCountry, billingCurrency: route.billingCurrency,
    status: "dispatching", lastError: "", startedAt, finishedAt: "", createdAt: startedAt,
    jobKind: "bulk", accessTokenFingerprint: credentials.accessTokenFingerprint, scheduledAt: startedAt, promoMode,
  }))));
  result.requestedJobs = 1;
  try {
    const response = await extractorJSON("POST", "/api/extract/jobs", {
      method: "payment_exposure",
      input: selected.map(({ credentials }) => credentials.accessToken).join("\n"),
      concurrency: selected.length,
      options: {
        ...extractorPromoOptions(promoMode), paymentStatusAutoRefresh: false, paymentExposureCheck: true,
        paymentExposureTargets: [{ target: route.target, ipCountry: route.ipCountry, billingCountry: route.billingCountry,
          billingCurrency: route.billingCurrency, expectedMethod: route.expectedMethod }],
      },
    });
    const remoteJob = response.job;
    const remoteJobId = text(remoteJob?.id, 120);
    if (!remoteJob || !remoteJobId) throw new Error("本机支付方式提炼服务未返回任务编号");
    const remoteStatus = extractorJobStatus(remoteJob);
    for (const record of reservations) {
      const current = (await finalizePaymentExposureJobReservation(record.jobId, remoteJobId, {
        status: remoteStatus, startedAt: timestamp(remoteJob.startedAt) || startedAt, finishedAt: timestamp(remoteJob.finishedAt), lastError: "",
      })) || record;
      result.jobs.push(await refreshPaymentExtractorJob(current, remoteJob));
      result.jobAccounts.push({ accountId: current.accountId, jobId: current.jobId });
      result.started += 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const record of reservations) (await updatePaymentExposureJob(record.jobId, { status: "failed", lastError: message, finishedAt: new Date().toISOString() }));
    result.failed += selected.length;
    result.errors.push(...selected.map(({ accountId }) => ({ accountId, routeKey: route.key, error: message })));
  }
  return result;
}

/** Compatibility export; automatic promotion checks now live in promotion.ts. */
export async function startTrialCheck(accountId: string): Promise<PaymentExposureJobStatus> {
  return startPaymentExposureCheck(accountId, config.autoTrialRouteKey, { jobKind: "manual_legacy" });
}

export async function getPaymentExposureCheckStatus(accountId: string, jobId: string): Promise<PaymentExposureJobStatus> {
  const record = (await getPaymentExposureJob(accountId, jobId));
  if (!record) throw new Error("支付资格检查任务不存在");
  if (!["completed", "failed", "cancelled", "interrupted"].includes(record.status)) {
    return refreshPaymentExtractorJob(record);
  }
  const check = (await listPaymentExposureChecks(accountId))
    .find((item) => item.target === record.target && item.checkoutType === "local_extractor");
  return publicStatus(record, check);
}

export async function getPaymentExposureBatchStatus(
  entries: Array<{ accountId: string; jobId: string }>,
): Promise<PaymentExposureJobStatus[]> {
  const requested = entries.slice(0, 24).map((entry) => ({
    accountId: String(entry.accountId || "").trim(),
    jobId: String(entry.jobId || "").trim(),
  })).filter((entry) => entry.accountId && entry.jobId);
  const records = (await asyncMap(requested, async (entry) => (await getPaymentExposureJob(entry.accountId, entry.jobId)))).filter(
    (record): record is PaymentExposureJobRecord => Boolean(record),
  );
  const statuses = new Map<string, PaymentExposureJobStatus>();
  const groups = new Map<string, PaymentExposureJobRecord[]>();
  for (const record of records) {
    if (["completed", "failed", "cancelled", "interrupted"].includes(record.status)) {
      const check = (await listPaymentExposureChecks(record.accountId))
        .find((item) => item.target === record.target && item.checkoutType === "local_extractor");
      statuses.set(`${record.accountId}:${record.jobId}`, publicStatus(record, check));
      continue;
    }
    const remoteJobId = record.remoteJobId || record.jobId;
    groups.set(remoteJobId, [...(groups.get(remoteJobId) || []), record]);
  }
  for (const [remoteJobId, group] of groups) {
    let remoteJob: Record<string, unknown> | undefined;
    let pollError = "";
    try {
      remoteJob = (await extractorJSON("GET", `/api/extract/jobs/${encodeURIComponent(remoteJobId)}`)).job;
      if (!remoteJob) pollError = "本机支付方式提炼服务未返回任务";
    } catch (error) {
      pollError = error instanceof Error ? error.message : String(error);
    }
    for (const record of group) {
      const key = `${record.accountId}:${record.jobId}`;
      if (remoteJob) statuses.set(key, await refreshPaymentExtractorJob(record, remoteJob));
      else {
        const check = (await listPaymentExposureChecks(record.accountId))
          .find((item) => item.target === record.target && item.checkoutType === "local_extractor");
        statuses.set(key, publicStatus(record, check, pollError));
      }
    }
  }
  return requested.map((entry) => statuses.get(`${entry.accountId}:${entry.jobId}`)).filter(
    (status): status is PaymentExposureJobStatus => Boolean(status),
  );
}

/** Keep remote method probes moving even when the initiating admin page is refreshed or closed. */
export async function refreshPendingPaymentExposureJobs(): Promise<{ checked: number; completed: number; failed: number; active: number }> {
  const pending = (await listPaymentExposureJobs(["dispatching", "queued", "running"]));
  const records: PaymentExposureJobRecord[] = [];
  let failedReservations = 0;
  let pendingReservations = 0;
  const staleBefore = Date.now() - Math.max(60_000, config.paymentExposureTimeoutMs * 2);
  for (const record of pending) {
    const reservationOnly = !record.remoteJobId || /^(?:payment-exposure-)?dispatch:/.test(record.remoteJobId);
    if (!reservationOnly) {
      records.push(record);
      continue;
    }
    if (Date.parse(record.updatedAt || record.createdAt) <= staleBefore) {
      (await updatePaymentExposureJob(record.jobId, { status: "failed", lastError: "支付方式探查未取得远程任务编号", finishedAt: new Date().toISOString() }));
      failedReservations += 1;
    } else pendingReservations += 1;
  }
  const statuses: PaymentExposureJobStatus[] = [];
  for (let offset = 0; offset < records.length; offset += 24) {
    statuses.push(...await getPaymentExposureBatchStatus(records.slice(offset, offset + 24)
      .map((record) => ({ accountId: record.accountId, jobId: record.jobId }))));
  }
  return {
    checked: statuses.length + failedReservations,
    completed: statuses.filter((item) => item.status === "completed").length,
    failed: failedReservations + statuses.filter((item) => ["failed", "cancelled", "interrupted"].includes(item.status)).length,
    active: pendingReservations + statuses.filter((item) => ["dispatching", "queued", "running"].includes(item.status)).length,
  };
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
