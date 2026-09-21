import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { db } from "./db.js";
import { invalidateCredentialVersion } from "./credential-versions.js";
import { getPaymentExposureCredentials } from "./repository.js";
import { effectiveCheckProxy } from "./check-routes.js";

const CAMPAIGN = "plus-1-month-free";

type JsonObject = Record<string, any>;

export interface ParsedPromotionResult {
  resultStatus: "eligible" | "ineligible" | "unknown_retryable" | "credential_invalid";
  eligible: boolean | null;
  upstreamStatus: number;
  errorClass: string;
  detail: string;
  evidence: Record<string, unknown>;
  responseHash: string;
  campaigns: PromotionCampaign[];
}

export interface PromotionCampaign {
  id: string;
  key: string;
  planName: string;
  durationPeriod: string;
  durationPeriods: number;
  discountPercent: number | null;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, limit = 500): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim().slice(0, limit);
  }
  if (value && typeof value === "object") {
    try { return JSON.stringify(value).slice(0, limit); } catch { return ""; }
  }
  return "";
}

function accountIdFromToken(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1] || "", "base64url").toString("utf8"));
    const auth = object(payload["https://api.openai.com/auth"]);
    return text(auth.chatgpt_account_id || auth.account_id || payload.chatgpt_account_id || payload.account_id, 200);
  } catch {
    return "";
  }
}

function collectCampaigns(value: unknown, key = "", out: PromotionCampaign[] = [], depth = 0): PromotionCampaign[] {
  if (depth > 8 || value === null || value === undefined) return out;
  if (typeof value === "string") {
    const id = text(value, 200);
    if (/^[a-z0-9][a-z0-9._-]{2,199}$/i.test(id)) {
      out.push({ id, key, planName: "", durationPeriod: "", durationPeriods: 0, discountPercent: null });
    }
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCampaigns(item, key || String(index), out, depth + 1));
    return out;
  }
  const item = object(value);
  if (!Object.keys(item).length) return out;
  const metadata = object(item.metadata);
  const duration = object(metadata.duration || item.duration);
  const keyLooksLikeCampaignId = /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/i.test(key) ? key : "";
  const id = text(item.id || item.campaign_id || item.campaignId || keyLooksLikeCampaignId, 200);
  const planName = text(metadata.plan_name || metadata.plan || item.plan_name || item.plan, 120);
  const durationPeriod = text(duration.period, 32).toLowerCase();
  const durationPeriods = Number(duration.num_periods ?? duration.periods ?? 0) || 0;
  const rawDiscount = metadata.discount_percent ?? metadata.percent_off ?? item.discount_percent ?? item.percent_off;
  const discountPercent = Number.isFinite(Number(rawDiscount)) ? Number(rawDiscount) : null;
  if (id || (planName && durationPeriod && durationPeriods > 0)) {
    out.push({ id: id || `${planName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${durationPeriods}-${durationPeriod}`, key, planName, durationPeriod, durationPeriods, discountPercent });
    return out;
  }
  for (const [childKey, child] of Object.entries(item)) {
    if (["id", "campaign_id", "campaignId", "metadata", "duration"].includes(childKey)) continue;
    if (typeof child === "object" || typeof child === "string") collectCampaigns(child, key || childKey, out, depth + 1);
  }
  return out;
}

function uniqueCampaigns(value: unknown): PromotionCampaign[] {
  const seen = new Set<string>();
  return collectCampaigns(value).filter((campaign) => {
    const identity = campaign.id.toLowerCase();
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).slice(0, 50);
}

function campaignFromId(id: string, key = "coupon"): PromotionCampaign {
  return { id, key, planName: "", durationPeriod: "", durationPeriods: 0, discountPercent: null };
}

function mergeCampaigns(...groups: PromotionCampaign[][]): PromotionCampaign[] {
  const seen = new Set<string>();
  const output: PromotionCampaign[] = [];
  for (const campaign of groups.flat()) {
    const identity = campaign.id.trim().toLowerCase();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    output.push(campaign);
  }
  return output.slice(0, 50);
}

function couponChecks(response: JsonObject): Array<{ campaign: string; status: number; state: string; eligible: boolean | null; errorClass: string; detail: string }> {
  return (Array.isArray(response.couponChecks) ? response.couponChecks : []).map((value) => {
    const row = object(value);
    return {
      campaign: text(row.campaign || row.requestedCampaign, 200),
      status: Number(row.status || 0) || 0,
      state: text(row.state, 80).toLowerCase(),
      eligible: row.eligible === true ? true : row.eligible === false ? false : null,
      errorClass: text(row.errorClass, 120),
      detail: text(row.detail, 300),
    };
  }).filter((row) => row.campaign);
}

function targetRecord(data: unknown, targetAccountId: string): { record: JsonObject; matchedKey: string; error: string } {
  const root = object(data);
  const rawAccounts = root.accounts;
  const entries: Array<[string, JsonObject]> = [];
  if (Array.isArray(rawAccounts)) {
    for (const [index, value] of rawAccounts.entries()) {
      const row = object(value);
      if (Object.keys(row).length) entries.push([String(index), row]);
    }
  } else {
    for (const [key, value] of Object.entries(object(rawAccounts))) {
      const row = object(value);
      if (Object.keys(row).length) entries.push([key, row]);
    }
  }
  if (!entries.length) return { record: {}, matchedKey: "", error: "accounts_missing" };
  if (targetAccountId) {
    const exact = entries.find(([key, row]) => {
      const account = object(row.account);
      return key === targetAccountId || [row.id, row.account_id, row.accountId, account.id].some((value) => text(value, 200) === targetAccountId);
    });
    if (!exact) return { record: {}, matchedKey: "", error: "target_account_missing" };
    return { record: exact[1], matchedKey: exact[0], error: "" };
  }
  if (entries.length !== 1) return { record: {}, matchedKey: "", error: "target_account_ambiguous" };
  return { record: entries[0][1], matchedKey: entries[0][0], error: "" };
}

export function parsePromotionResponse(payload: unknown, targetAccountId: string, campaign = CAMPAIGN): ParsedPromotionResult {
  const response = object(payload);
  const upstreamStatus = Number(response.status || response.httpStatus || 0) || 0;
  const rawData = response.data;
  const checks = couponChecks(response);
  const couponCampaigns = checks.filter((check) => check.eligible === true).map((check) => campaignFromId(check.campaign));
  const responseHash = sha256(JSON.stringify({ data: rawData ?? null, couponChecks: checks }));
  const rawError = text(response.error || response.detail, 500);
  if (couponCampaigns.length) {
    let catalogCampaigns: PromotionCampaign[] = [];
    let selectedEvidence: Record<string, unknown> = {};
    if (response.ok === true && upstreamStatus >= 200 && upstreamStatus < 300) {
      const selected = targetRecord(rawData, targetAccountId);
      if (!selected.error && Object.prototype.hasOwnProperty.call(selected.record, "eligible_promo_campaigns")) {
        catalogCampaigns = uniqueCampaigns(selected.record.eligible_promo_campaigns);
        selectedEvidence = { matchedKey: selected.matchedKey };
      }
    }
    const campaigns = mergeCampaigns(catalogCampaigns, couponCampaigns);
    return {
      resultStatus: "eligible", eligible: true, upstreamStatus, errorClass: "",
      detail: `已确认 ${campaigns.length} 项可用优惠（含 coupon 资格验证）`,
      evidence: { targetAccountId, requestedCampaign: campaign, campaigns, couponChecks: checks, ...selectedEvidence },
      responseHash, campaigns,
    };
  }
  if (response.ok !== true || upstreamStatus < 200 || upstreamStatus >= 300) {
    const lower = rawError.toLowerCase();
    const invalid = [401, 403].includes(upstreamStatus) && /unauthor|invalid(?:ated)?[_ -]?(?:oauth[_ -]?)?token|token[_ -]?revok|expired|authentication/.test(lower)
      && !/cloudflare|edge|proxy|html|blocked/.test(lower);
    return {
      resultStatus: invalid ? "credential_invalid" : "unknown_retryable", eligible: null, upstreamStatus,
      errorClass: invalid ? "credential_invalid" : upstreamStatus === 429 ? "rate_limited" : upstreamStatus >= 500 ? "upstream_5xx" : upstreamStatus ? "upstream_http" : "transport_error",
      detail: rawError || (upstreamStatus ? `upstream HTTP ${upstreamStatus}` : "promotion transport failed"),
      evidence: { targetAccountId, responseKeys: Object.keys(response).sort() }, responseHash, campaigns: [],
    };
  }
  const selected = targetRecord(rawData, targetAccountId);
  if (selected.error) {
    return { resultStatus: "unknown_retryable", eligible: null, upstreamStatus, errorClass: selected.error,
      detail: "优惠响应没有唯一匹配目标账号", evidence: { targetAccountId, reason: selected.error }, responseHash, campaigns: [] };
  }
  if (!Object.prototype.hasOwnProperty.call(selected.record, "eligible_promo_campaigns")) {
    return { resultStatus: "unknown_retryable", eligible: null, upstreamStatus, errorClass: "campaign_field_missing",
      detail: "目标账号缺少 eligible_promo_campaigns 字段", evidence: { targetAccountId, matchedKey: selected.matchedKey, recordKeys: Object.keys(selected.record).sort() }, responseHash, campaigns: [] };
  }
  const campaigns = uniqueCampaigns(selected.record.eligible_promo_campaigns);
  const eligible = campaigns.length > 0;
  if (!eligible) {
    const unknownChecks = checks.filter((check) => check.eligible === null);
    const invalidChecks = checks.filter((check) => check.errorClass === "credential_invalid");
    if (invalidChecks.length && invalidChecks.length === checks.length) {
      return { resultStatus: "credential_invalid", eligible: null, upstreamStatus: invalidChecks[0].status,
        errorClass: "credential_invalid", detail: "coupon 检测确认凭证不可用",
        evidence: { targetAccountId, matchedKey: selected.matchedKey, couponChecks: checks }, responseHash, campaigns: [] };
    }
    if (!checks.length || unknownChecks.length) {
      return { resultStatus: "unknown_retryable", eligible: null, upstreamStatus,
        errorClass: !checks.length ? "coupon_not_checked" : "coupon_check_incomplete",
        detail: !checks.length ? "优惠目录为空，尚未执行 coupon 资格验证" : "优惠目录为空，部分 coupon 资格验证未得到权威结果",
        evidence: { targetAccountId, matchedKey: selected.matchedKey, requestedCampaign: campaign, campaigns, couponChecks: checks }, responseHash, campaigns: [] };
    }
  }
  return {
    resultStatus: eligible ? "eligible" : "ineligible", eligible, upstreamStatus,
    errorClass: "", detail: eligible ? `目标账号包含 ${campaigns.length} 项可用优惠` : `优惠目录为空；已核验 ${checks.length} 个已知活动均不可用`,
    evidence: { targetAccountId, matchedKey: selected.matchedKey, requestedCampaign: campaign, campaigns, couponChecks: checks }, responseHash, campaigns,
  };
}

function promotionCampaignCandidates(): string[] {
  const candidates = [...config.promotionCampaignCandidates];
  try {
    const rows = db.prepare(`SELECT evidence_json FROM promotion_observations ORDER BY checked_at DESC LIMIT 1000`).all() as any[];
    for (const row of rows) {
      const evidence = object(JSON.parse(String(row.evidence_json || "{}")));
      for (const campaign of uniqueCampaigns(evidence.campaigns)) candidates.push(campaign.id);
      const legacy = text(evidence.campaignValue || evidence.requestedCampaign, 200);
      if (legacy) candidates.push(legacy);
    }
  } catch {
    // The built-in/configured candidates remain available during early migrations.
  }
  return [...new Set(candidates.map((value) => value.trim()).filter((value) => /^[a-z0-9][a-z0-9._-]{2,199}$/i.test(value)))].slice(0, 50);
}

async function runBridge(input: Record<string, unknown>): Promise<JsonObject> {
  return await new Promise((resolve, reject) => {
    const child = spawn(config.promotionPython, [config.promotionBridge], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), config.promotionTimeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 5_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(object(JSON.parse(stdout))); }
      catch { reject(new Error(text(stderr, 500) || "promotion bridge returned invalid JSON")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function retryDelay(attempt: number): number {
  return [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000][Math.min(3, Math.max(0, attempt - 1))];
}

function activeJob(accountId: string): any {
  return db.prepare(`SELECT * FROM promotion_jobs WHERE account_id=? AND campaign=?
    AND status IN ('queued','running','retry_wait') ORDER BY created_at DESC LIMIT 1`).get(accountId, CAMPAIGN);
}

class PromotionCheckNotNeededError extends Error {
  constructor(public readonly reason: "plus" | "inactive" | "missing", message: string) {
    super(message);
    this.name = "PromotionCheckNotNeededError";
  }
}

export function promotionLifecycleEligible(status: unknown): boolean {
  return ["active", "third_party_registered"].includes(String(status || ""));
}

function assertPromotionCheckNeeded(accountId: string): void {
  const account = db.prepare(`SELECT lifecycle_status, deactivation_locked, plan, deleted_at
    FROM gpt_accounts WHERE id=?`).get(accountId) as any;
  if (!account || String(account.deleted_at || "")) {
    throw new PromotionCheckNotNeededError("missing", "账号不存在或已删除，已跳过优惠检测");
  }
  if (!promotionLifecycleEligible(account.lifecycle_status) || Number(account.deactivation_locked || 0)) {
    throw new PromotionCheckNotNeededError("inactive", "账号已停用或不再活跃，无需检测优惠");
  }
  if (String(account.plan || "").trim().toLowerCase() === "plus") {
    throw new PromotionCheckNotNeededError("plus", "账号已经开通 Plus，无需检测优惠");
  }
}

export function queuePromotionCheck(accountId: string, checkKind: "manual" | "auto" = "manual", dueAt = new Date().toISOString()): Record<string, unknown> {
  assertPromotionCheckNeeded(accountId);
  if (!effectiveCheckProxy("promotion_jp")) throw new Error("JP 优惠检查出口尚未配置");
  const credentials = getPaymentExposureCredentials(accountId);
  if (!credentials?.accessToken) throw new Error("账号没有可用的 Access Token");
  const current = activeJob(accountId);
  if (current && ["queued", "running"].includes(String(current.status))) return promotionJob(String(current.id))!;
  const now = new Date().toISOString();
  if (current && String(current.status) === "retry_wait") {
    db.prepare(`UPDATE promotion_jobs SET check_kind=?, due_at=?, status='queued', next_retry_at='',
      error_class='', error_detail='', updated_at=? WHERE id=?`).run(checkKind, dueAt, now, current.id);
    return promotionJob(String(current.id))!;
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO promotion_jobs(id, account_id, credential_version_id, campaign, region, check_kind, due_at,
    status, created_at, updated_at) VALUES(?, ?, ?, ?, 'JP', ?, ?, 'queued', ?, ?)`).run(
    id, accountId, credentials.credentialVersionId || null, CAMPAIGN, checkKind, dueAt, now, now,
  );
  return promotionJob(id)!;
}

export function queuePromotionChecks(accountIds: unknown[]): { requested: number; queued: number; alreadyRunning: number; skipped: number; failed: number; jobs: Array<Record<string, unknown>>; errors: Array<{ accountId: string; error: string; skipped?: boolean; reason?: string }> } {
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 500);
  const result = { requested: ids.length, queued: 0, alreadyRunning: 0, skipped: 0, failed: 0,
    jobs: [] as Array<Record<string, unknown>>, errors: [] as Array<{ accountId: string; error: string; skipped?: boolean; reason?: string }> };
  for (const accountId of ids) {
    try {
      const before = activeJob(accountId);
      const job = queuePromotionCheck(accountId, "manual");
      result.jobs.push(job);
      if (before && ["queued", "running"].includes(String(before.status))) result.alreadyRunning += 1;
      else result.queued += 1;
    } catch (error) {
      if (error instanceof PromotionCheckNotNeededError) {
        result.skipped += 1;
        result.errors.push({ accountId, error: text(error.message, 300), skipped: true, reason: error.reason });
      } else {
        result.failed += 1;
        result.errors.push({ accountId, error: text(error instanceof Error ? error.message : error, 300) });
      }
    }
  }
  return result;
}

export function promotionJobs(ids: unknown[]): Array<Record<string, unknown>> {
  return [...new Set((Array.isArray(ids) ? ids : []).map((value) => String(value || "").trim()).filter(Boolean))]
    .slice(0, 500)
    .map((id) => promotionJob(id))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

export function scheduleDuePromotionChecks(now = new Date()): { queued: number } {
  const cutoff = new Date(now.getTime() - config.autoTrialDelayMs).toISOString();
  const rows = db.prepare(`SELECT a.id account_id, cv.id credential_version_id, cv.first_seen_at
    FROM gpt_accounts a
    JOIN account_current_credentials cc ON cc.account_id=a.id
    JOIN credential_versions cv ON cv.id=cc.credential_version_id
    WHERE a.deleted_at='' AND a.lifecycle_status IN ('active','third_party_registered') AND a.deactivation_locked=0
      AND lower(trim(a.plan))!='plus' AND cv.access_token_enc!=''
      AND cv.validity_status NOT IN ('invalid','conflict') AND cv.first_seen_at<=?
      AND NOT EXISTS(SELECT 1 FROM promotion_jobs j WHERE j.account_id=a.id AND j.credential_version_id=cv.id
        AND j.campaign=? AND (j.status IN ('queued','running') OR (j.status='retry_wait' AND j.next_retry_at>?)))
      AND NOT EXISTS(SELECT 1 FROM promotion_observations o WHERE o.account_id=a.id AND o.credential_version_id=cv.id)
    ORDER BY cv.first_seen_at ASC LIMIT ?`).all(cutoff, CAMPAIGN, now.toISOString(), config.autoTrialBatchSize) as any[];
  let queued = 0;
  for (const row of rows) {
    queuePromotionCheck(String(row.account_id), "auto", new Date(Date.parse(String(row.first_seen_at)) + config.autoTrialDelayMs).toISOString());
    queued += 1;
  }
  return { queued };
}

export function promotionJob(id: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT * FROM promotion_jobs WHERE id=?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id, accountId: row.account_id, credentialVersionId: row.credential_version_id || "",
    campaign: row.campaign, region: row.region, checkKind: row.check_kind, dueAt: row.due_at,
    attempt: Number(row.attempt), status: row.status, errorClass: row.error_class,
    errorDetail: row.error_detail, nextRetryAt: row.next_retry_at, startedAt: row.started_at,
    finishedAt: row.finished_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function runPromotionQueue(limit = config.autoTrialBatchSize, concurrency = config.promotionConcurrency): Promise<{ checked: number; eligible: number; ineligible: number; retryable: number; invalid: number }> {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - Math.max(10 * 60_000, config.promotionTimeoutMs * 3)).toISOString();
  db.prepare(`UPDATE promotion_jobs SET status='retry_wait', error_class='interrupted_runtime',
    error_detail='运行中的优惠任务超时，已恢复为可重试', next_retry_at=?, updated_at=?
    WHERE status='running' AND updated_at<=?`).run(now, now, staleBefore);
  db.prepare(`UPDATE promotion_jobs SET status='cancelled', error_class='account_not_eligible',
    error_detail=CASE WHEN lower(trim((SELECT plan FROM gpt_accounts WHERE id=promotion_jobs.account_id)))='plus'
      THEN '账号已经开通 Plus，无需检测优惠' ELSE '账号已停用或不再活跃，无需检测优惠' END,
    next_retry_at='', finished_at=?, updated_at=?
    WHERE status IN ('queued','retry_wait') AND EXISTS(SELECT 1 FROM gpt_accounts a
      WHERE a.id=promotion_jobs.account_id AND
      (a.deleted_at!='' OR a.lifecycle_status NOT IN ('active','third_party_registered')
        OR a.deactivation_locked=1 OR lower(trim(a.plan))='plus'))`).run(now, now);
  const rows = db.prepare(`SELECT * FROM promotion_jobs WHERE
      status='queued' OR (status='retry_wait' AND next_retry_at!='' AND next_retry_at<=?)
    ORDER BY CASE WHEN check_kind='manual' THEN 0 ELSE 1 END, due_at ASC LIMIT ?`).all(now, limit) as any[];
  const result = { checked: 0, eligible: 0, ineligible: 0, retryable: 0, invalid: 0 };
  let cursor = 0;
  const processRow = async (row: any): Promise<void> => {
    try { assertPromotionCheckNeeded(String(row.account_id)); }
    catch (error) {
      if (!(error instanceof PromotionCheckNotNeededError)) throw error;
      const cancelledAt = new Date().toISOString();
      db.prepare(`UPDATE promotion_jobs SET status='cancelled', error_class='account_not_eligible', error_detail=?,
        next_retry_at='', finished_at=?, updated_at=? WHERE id=? AND status IN ('queued','retry_wait')`)
        .run(error.message, cancelledAt, cancelledAt, row.id);
      return;
    }
    const credentials = getPaymentExposureCredentials(String(row.account_id));
    if (!credentials?.accessToken || (row.credential_version_id && credentials.credentialVersionId !== row.credential_version_id)) {
      const invalidated = db.prepare(`UPDATE promotion_jobs SET status='credential_invalid', error_class='credential_replaced',
        error_detail='任务凭证已失效或被替换', finished_at=?, updated_at=? WHERE id=? AND status!='running'`).run(now, now, row.id);
      if (invalidated.changes) result.invalid += 1;
      return;
    }
    const startedAt = new Date().toISOString();
    const attempt = Number(row.attempt || 0) + 1;
    const claimed = db.prepare(`UPDATE promotion_jobs SET status='running', attempt=?, started_at=?, error_class='', error_detail='', updated_at=?
      WHERE id=? AND (status='queued' OR (status='retry_wait' AND next_retry_at!='' AND next_retry_at<=?))`)
      .run(attempt, startedAt, startedAt, row.id, now);
    if (!claimed.changes) return;
    let parsed: ParsedPromotionResult;
    try {
      const targetAccountId = accountIdFromToken(credentials.accessToken);
      const promotionProxy = effectiveCheckProxy("promotion_jp");
      if (!promotionProxy) throw new Error("JP 优惠检查出口尚未配置");
      const response = await runBridge({ accessToken: credentials.accessToken, accountId: targetAccountId,
        email: credentials.email, proxy: promotionProxy,
        campaigns: promotionCampaignCandidates(),
        timeout: Math.ceil(config.promotionTimeoutMs / 1000) });
      parsed = parsePromotionResponse(response, targetAccountId, CAMPAIGN);
    } catch (error) {
      parsed = { resultStatus: "unknown_retryable", eligible: null, upstreamStatus: 0,
        errorClass: "transport_error", detail: text(error instanceof Error ? error.message : error),
        evidence: {}, responseHash: "", campaigns: [] };
    }
    const finishedAt = new Date().toISOString();
    result.checked += 1;
    if (parsed.resultStatus === "unknown_retryable") {
      const nextRetryAt = new Date(Date.now() + retryDelay(attempt)).toISOString();
      db.prepare(`UPDATE promotion_jobs SET status='retry_wait', error_class=?, error_detail=?, next_retry_at=?,
        finished_at=?, updated_at=? WHERE id=?`).run(parsed.errorClass, parsed.detail, nextRetryAt, finishedAt, finishedAt, row.id);
      result.retryable += 1;
      return;
    }
    const eligible = parsed.resultStatus === "eligible";
    // A conclusive catalog response is the one automatic observation for this
    // AT. Manual single-account and bulk actions can explicitly create newer
    // observations, while transport failures continue using retry_wait.
    const expiresAt = "";
    db.transaction(() => {
      db.prepare(`INSERT INTO promotion_observations(id, job_id, account_id, credential_version_id, campaign, eligible,
        result_status, upstream_status, evidence_json, response_hash, checked_at, expires_at, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        crypto.randomUUID(), row.id, row.account_id, row.credential_version_id || null, CAMPAIGN,
        parsed.eligible === null ? null : parsed.eligible ? 1 : 0, parsed.resultStatus, parsed.upstreamStatus,
        JSON.stringify({ detail: parsed.detail, campaigns: parsed.campaigns, ...parsed.evidence }), parsed.responseHash, finishedAt, expiresAt, finishedAt,
      );
      db.prepare(`UPDATE promotion_jobs SET status=?, error_class=?, error_detail=?, next_retry_at='', finished_at=?, updated_at=? WHERE id=?`).run(
        parsed.resultStatus === "credential_invalid" ? "credential_invalid" : "completed", parsed.errorClass, parsed.detail, finishedAt, finishedAt, row.id,
      );
      if (parsed.resultStatus === "credential_invalid" && row.credential_version_id) {
        invalidateCredentialVersion(String(row.credential_version_id), finishedAt);
      }
    })();
    if (eligible) result.eligible += 1;
    else if (parsed.resultStatus === "ineligible") result.ineligible += 1;
    else result.invalid += 1;
  };
  const workerCount = Math.min(rows.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      await processRow(rows[index]);
    }
  }));
  return result;
}

export function latestPromotionForAccount(accountId: string): Record<string, unknown> | null {
  const row = db.prepare(`SELECT o.*, j.region, j.check_kind FROM promotion_observations o
    JOIN promotion_jobs j ON j.id=o.job_id WHERE o.account_id=? AND o.result_status IN ('eligible','ineligible')
    ORDER BY o.checked_at DESC LIMIT 1`).get(accountId) as any;
  return row ? { eligible: row.eligible === null ? null : Boolean(row.eligible), status: row.result_status,
    campaign: row.campaign, region: row.region, checkKind: row.check_kind, checkedAt: row.checked_at,
    expiresAt: row.expires_at, evidence: object(JSON.parse(String(row.evidence_json || "{}"))) } : null;
}
