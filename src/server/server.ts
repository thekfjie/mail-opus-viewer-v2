import fs from "node:fs";
import path from "node:path";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { config } from "./config.js";
import { constantTimeEqual, signSession, verifySession } from "./crypto.js";
import {
  applyBulkAction,
  createRebind,
  createCustomerGrant,
  deactivateAccount,
  getAccountDetail,
  getCurrentCustomerExport,
  ingestPaymentExposureChecks,
  listAccounts,
  listAccountGrants,
  listPendingReviews,
  listRedGroups,
  importAccounts,
  migrationReport,
  overview,
  primaryEmailForAccount,
  recycleAccount,
  recycleAccountByMode,
  resolvePendingReview,
  revealCredentials,
  saveAccountCredentials,
  revokeCustomerGrant,
  setPromotionSuspicion,
  updateAccount,
} from "./repository.js";
import {
  getPaymentExposureCheckStatus,
  listPaymentExposureRoutes,
  startPaymentExposureCheck,
} from "./payment-exposure.js";
import { promotionJob, promotionJobs, queuePromotionCheck, queuePromotionChecks, runPromotionQueue } from "./promotion.js";
import {
  clearCheckRouteProxy,
  clearPaymentEligibilityApi,
  effectivePaymentEligibilityApi,
  isCheckRouteKey,
  listCheckRouteSummaries,
  paymentEligibilityApiSummary,
  saveCheckRouteProxy,
  savePaymentEligibilityApi,
} from "./check-routes.js";
import {
  accountVerificationCode,
  adminAccountMailDetail,
  listAdminAccountMails,
  outlookFreeMailDetail,
  outlookFreeMails,
  outlookFreePool,
} from "./native-mail.js";
import {
  applyOauthBatch,
  applyOutlookTransfer,
  createShareLink,
  importOutlook,
  importSession,
  listShareLinks,
  oauthHealthStatus,
  previewOauthBatch,
  previewOutlookTransfer,
  readShareSnapshot,
  revokeShareLink,
  runUsageAudit,
  startOauthHealth,
} from "./native-operations.js";
import { db } from "./db.js";
import {
  currentLegacyMappingId,
  proxyV1AndSync,
  proxyV1AndScheduleSync,
  requestV1,
  v1CompatCommand,
  v1Health,
} from "./v1-compat.js";

const app = Fastify({ logger: true, disableRequestLogging: true, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
await app.register(cookie);

const webRoot = path.join(config.projectRoot, "dist/web");
const releaseManifestPath = path.join(config.projectRoot, "dist", "release-manifest.json");
function releaseManifest(): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
app.get("/assets/:file", async (request, reply) => {
  const requested = String((request.params as any).file || "");
  if (!requested || path.basename(requested) !== requested) return reply.code(404).send({ error: "资源不存在" });
  const assetPath = path.join(webRoot, "assets", requested);
  if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) return reply.code(404).send({ error: "资源不存在" });
  const extension = path.extname(assetPath).toLowerCase();
  const contentType = extension === ".js" ? "application/javascript; charset=utf-8" : extension === ".css" ? "text/css; charset=utf-8" : "application/octet-stream";
  reply.type(contentType).header("cache-control", "public, max-age=31536000, immutable");
  return reply.send(fs.createReadStream(assetPath));
});

app.addHook("onSend", async (_request, reply, payload) => {
  reply.header("cache-control", "no-store");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  reply.header("x-robots-tag", "noindex, nofollow, noarchive");
  return payload;
});

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function consumeRate(request: FastifyRequest, scope: string, max: number): boolean {
  const key = `${scope}:${request.ip}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

function sameOrigin(request: FastifyRequest): boolean {
  const origin = String(request.headers.origin || "");
  if (!origin) return true;
  const proto = String(request.headers["x-forwarded-proto"] || request.protocol).split(",")[0];
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "").split(",")[0];
  return origin === `${proto}://${host}`;
}

function adminSession(request: FastifyRequest): boolean {
  const session = verifySession(String(request.cookies.mail_opus_v2_admin || ""));
  return Boolean(session && session.type === "admin" && session.id === "administrator");
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (adminSession(request)) return true;
  reply.code(401).send({ error: "未登录" });
  return false;
}

function requireWrite(reply: FastifyReply): boolean {
  if (!config.readOnly) return true;
  reply.code(409).send({ error: "V2当前由配置锁定为只读模式" });
  return false;
}

function commandWritesAvailable(): boolean {
  return !config.readOnly;
}

function v1AccountAuthority(): boolean {
  return config.accountAuthority === "v1";
}

function commandWriterLabel(): string {
  return v1AccountAuthority() ? "v1-via-v2" : "v2";
}

function requireCommandWrite(reply: FastifyReply): boolean {
  if (commandWritesAvailable()) return true;
  reply.code(409).send({ error: "业务命令写入当前未启用" });
  return false;
}

function setSessionCookie(reply: FastifyReply, name: string, value: string): void {
  reply.setCookie(name, value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 12 * 60 * 60 });
}

app.get("/health", async () => ({
  ok: true, service: "mail-opus-viewer-v2", readOnly: !commandWritesAvailable(), nativeReadOnly: config.readOnly,
  commandWriter: commandWriterLabel(), accountAuthority: config.accountAuthority,
  independent: !v1AccountAuthority(), release: releaseManifest(),
}));
app.get("/api/v2/health/coexistence", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const worker = db.prepare("SELECT status,heartbeat_at,artifact_sha256 FROM worker_heartbeats WHERE worker_name='native-sync-worker'").get() || null;
  const v1 = v1AccountAuthority() ? await v1Health() : { mode: "standby", probed: false };
  return { v1, v2: { ok: true, nativeReadOnly: config.readOnly, worker }, commandWriter: commandWriterLabel(), hardDependency: v1AccountAuthority() };
});
app.get("/api/v2/version", async () => ({ ok: true, release: releaseManifest() }));
app.get("/api/v2/status", async (request, reply) => requireAdmin(request, reply) ? overview() : undefined);

app.post("/api/v2/admin/login", async (request, reply) => {
  if (!consumeRate(request, "admin-login", 8)) return reply.code(429).send({ error: "登录尝试过多" });
  if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
  const body = request.body as any;
  if (!config.adminPassword || !constantTimeEqual(String(body?.password || ""), config.adminPassword)) return reply.code(401).send({ error: "后台口令不正确" });
  setSessionCookie(reply, "mail_opus_v2_admin", signSession("admin", "administrator"));
  return { ok: true };
});

app.post("/api/v2/admin/logout", async (_request, reply) => {
  reply.clearCookie("mail_opus_v2_admin", { path: "/" });
  return { ok: true };
});
app.get("/api/v2/admin/session", async (request, reply) => adminSession(request)
  ? { ok: true, readOnly: !commandWritesAvailable(), nativeReadOnly: config.readOnly, commandWriter: commandWriterLabel(), accountAuthority: config.accountAuthority, independent: !v1AccountAuthority() }
  : reply.code(401).send({ error: "未登录" }));

app.get("/api/v2/admin/overview", async (request, reply) => requireAdmin(request, reply) ? overview() : undefined);
app.get("/api/v2/admin/accounts", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const query = request.query as any;
  return listAccounts({
    search: String(query.search || ""), range: query.range || "all", status: String(query.status || ""),
    provider: String(query.provider || ""), billingChannel: String(query.billingChannel || ""), sold: String(query.sold || ""), plan: String(query.plan || ""),
    credential: String(query.credential || ""), sourceStatus: String(query.sourceStatus || ""), unused: String(query.unused || ""),
    workbench: String(query.workbench || ""), deactivationWindow: query.deactivationWindow || "today",
    redGroup: String(query.redGroup || ""), markColor: String(query.markColor || ""), pending: String(query.pending || ""),
    limit: Number(query.limit || 80), offset: Number(query.offset || 0),
  });
});
app.get("/api/v2/admin/red-groups", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return { results: listRedGroups() };
});
app.get("/api/v2/admin/pending-reviews", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return { results: listPendingReviews() };
});
app.post("/api/v2/admin/pending-reviews/:id/resolve", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  if (v1AccountAuthority()) return reply.code(409).send({ error: "V1 权威模式下禁止用 V2 审查结果改写账号关系" });
  try {
    const reviewId = String((request.params as any).id);
    const action = String((request.body as any)?.action || "");
    return resolvePendingReview(reviewId, action);
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/migration-report", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return migrationReport();
});
app.get("/api/v2/admin/outlook-free", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    if (v1AccountAuthority()) {
      const refresh = String((request.query as any)?.refresh || "") === "1" ? "?refresh=1" : "";
      return requestV1(`/api/admin/outlook/free-pool${refresh}`);
    }
    return outlookFreePool(String((request.query as any)?.refresh || "") === "1");
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/outlook-free/refresh", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    if (v1AccountAuthority()) return requestV1("/api/admin/outlook/free-pool/refresh", { method: "POST", body: {} });
    return outlookFreePool(true);
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/outlook-free/mails", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const query = request.query as any;
    if (v1AccountAuthority()) {
      const params = new URLSearchParams({ email: String(query?.email || ""), offset: String(query?.offset || 0), limit: String(query?.limit || 20) });
      return requestV1(`/api/admin/outlook/free-pool/mails?${params}`);
    }
    return outlookFreeMails(String(query?.email || ""), query?.offset, query?.limit);
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/outlook-free/mail-detail", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const query = request.query as any;
    if (v1AccountAuthority()) {
      const params = new URLSearchParams({ email: String(query?.email || ""), id: String(query?.id || ""), folder: String(query?.folder || "inbox") });
      return requestV1(`/api/admin/outlook/free-pool/mail-detail?${params}`);
    }
    return outlookFreeMailDetail(String(query?.email || ""), String(query?.id || ""), String(query?.folder || "inbox"));
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/accounts/:id/recent-mails", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const query = request.query as any;
    if (v1AccountAuthority()) {
      const params = new URLSearchParams({ id: currentLegacyMappingId(accountId), offset: String(query?.offset || 0), limit: String(query?.limit || 10) });
      return requestV1(`/api/admin/mapping-mails?${params}`);
    }
    return listAdminAccountMails(accountId, query?.offset, query?.limit);
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/accounts/:id/recent-mail-detail", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const query = request.query as any;
    const accountId = String((request.params as any).id);
    if (v1AccountAuthority()) {
      const params = new URLSearchParams({ mappingId: currentLegacyMappingId(accountId), id: String(query?.id || ""), folder: String(query?.folder || "inbox") });
      return requestV1(`/api/admin/mapping-mail-detail?${params}`);
    }
    const item = await adminAccountMailDetail(accountId, String(query?.id || ""));
    return item || reply.code(404).send({ error: "邮件不存在或不属于该账号" });
  } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/accounts/:id/verification-code", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const accountId = String((request.params as any).id);
    if (v1AccountAuthority()) {
      const params = new URLSearchParams({ id: currentLegacyMappingId(accountId), ignoreAccessWindow: "1" });
      return requestV1(`/api/admin/mapping-verification-code?${params}`);
    }
    return accountVerificationCode(accountId);
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/oauth/batch-preview", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    if (v1AccountAuthority()) return requestV1("/api/admin/oauth/batch-preview", { method: "POST", body: request.body });
    return previewOauthBatch((request.body as any)?.text || request.body);
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/oauth/batch-apply", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    if (v1AccountAuthority()) return (await proxyV1AndSync("/api/admin/oauth/batch-apply", { method: "POST", body: request.body })).result;
    const body = request.body as any;
    return applyOauthBatch(body?.text, body?.previewHash, body?.confirm);
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/oauth-health/start", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    if (v1AccountAuthority()) return requestV1("/api/admin/oauth-health/all-normal", { method: "POST", body: {} });
    return startOauthHealth();
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/oauth-health/status", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    if (v1AccountAuthority()) return requestV1("/api/admin/oauth-health/status");
    return oauthHealthStatus();
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
for (const [route, v1Path, action, previewOnly] of [
  ["/api/v2/admin/import/outlook", "/api/admin/outlook/import", importOutlook, false],
  ["/api/v2/admin/import/session", "/api/admin/session/import", (input: unknown) => importSession(input), false],
  ["/api/v2/admin/import/outlook-transfer-preview", "/api/admin/outlook/transfer/preview", previewOutlookTransfer, true],
  ["/api/v2/admin/import/outlook-transfer", "/api/admin/outlook/transfer", applyOutlookTransfer, false],
] as const) {
  app.post(route, async (request, reply) => {
    if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
    try {
      const body = request.body as any;
      const input = body?.accounts || body?.accountString || body?.emails || "";
      if (v1AccountAuthority()) {
        const result = previewOnly
          ? await requestV1(v1Path, { method: "POST", body: { accounts: input, emails: input } })
          : (await proxyV1AndSync(v1Path, { method: "POST", body: { accounts: input, emails: input } })).result;
        return result;
      }
      return action(input);
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
app.post("/api/v2/admin/usage-audit", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    if (v1AccountAuthority()) return requestV1("/api/admin/usage-audit", { method: "POST", body: request.body || {} });
    return runUsageAudit();
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/share/links", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    if (v1AccountAuthority()) return requestV1("/api/admin/share/links");
    return listShareLinks();
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/share/links", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    if (v1AccountAuthority()) return requestV1("/api/admin/share/links", { method: "POST", body: request.body });
    return createShareLink(request.body as any);
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.delete("/api/v2/admin/share/links/:id", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    const id = String((request.params as any).id);
    if (v1AccountAuthority()) return requestV1(`/api/admin/share/links/${encodeURIComponent(id)}`, { method: "DELETE" });
    return revokeShareLink(id) ? { ok: true } : reply.code(404).send({ error: "分享链接不存在" });
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/payment-exposure/routes", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const checkRoutes = listCheckRouteSummaries();
  return {
    routes: listPaymentExposureRoutes(),
    promotionRoute: checkRoutes.find((route) => route.key === "promotion_jp"),
    checkRoutes,
    eligibilityApi: paymentEligibilityApiSummary(),
  };
});
app.put("/api/v2/admin/payment-exposure/api", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  if (!consumeRate(request, "payment-eligibility-api-save", 20)) return reply.code(429).send({ error: "检查接口配置操作过多" });
  const body = request.body as any;
  try {
    return { eligibilityApi: savePaymentEligibilityApi(body?.endpoint, body?.apiToken, Object.prototype.hasOwnProperty.call(body || {}, "apiToken")) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "检查接口配置保存失败" });
  }
});
app.get("/api/v2/admin/payment-exposure/api/reveal", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  reply.header("Cache-Control", "no-store");
  return effectivePaymentEligibilityApi();
});
app.delete("/api/v2/admin/payment-exposure/api", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  return { eligibilityApi: clearPaymentEligibilityApi() };
});
app.put("/api/v2/admin/payment-exposure/routes/:key", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  if (!consumeRate(request, "check-route-save", 30)) return reply.code(429).send({ error: "出口配置操作过多" });
  const key = String((request.params as any).key || "").trim().toLowerCase();
  if (!isCheckRouteKey(key)) return reply.code(404).send({ error: "检测出口不存在" });
  try { return { route: saveCheckRouteProxy(key, (request.body as any)?.proxy) }; }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "出口配置保存失败" }); }
});
app.delete("/api/v2/admin/payment-exposure/routes/:key", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  const key = String((request.params as any).key || "").trim().toLowerCase();
  if (!isCheckRouteKey(key)) return reply.code(404).send({ error: "检测出口不存在" });
  return { route: clearCheckRouteProxy(key) };
});
// This is an API-only eligibility lookup. It must never create Checkout or
// call Stripe payment-page endpoints.
app.post("/api/v2/admin/accounts/:id/payment-exposure-check", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  if (!consumeRate(request, "payment-exposure-start", 30)) return reply.code(429).send({ error: "支付检查请求过多" });
  try {
    const body = request.body as any;
    const routeKey = String(body?.routeKey || body?.route || "").trim().toLowerCase();
    return await startPaymentExposureCheck(String((request.params as any).id), routeKey);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "支付检查启动失败" });
  }
});
app.post("/api/v2/admin/accounts/:id/trial-check", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  if (!consumeRate(request, "trial-check-start", 30)) return reply.code(429).send({ error: "试用检测请求过多" });
  try {
    const item = queuePromotionCheck(String((request.params as any).id), "manual");
    void runPromotionQueue(500).catch(() => undefined);
    return promotionJob(String(item.id || ""));
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "试用检测启动失败" });
  }
});
app.post("/api/v2/admin/accounts/promotion-check", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  if (!consumeRate(request, "promotion-check-bulk", 30)) return reply.code(429).send({ error: "批量优惠检测请求过多" });
  const accountIds = Array.isArray((request.body as any)?.accountIds) ? (request.body as any).accountIds : [];
  if (!accountIds.length) return reply.code(400).send({ error: "请选择至少一个账号" });
  const result = queuePromotionChecks(accountIds);
  void runPromotionQueue(500).catch(() => undefined);
  return result;
});
app.post("/api/v2/admin/accounts/promotion-check/status", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  const jobIds = Array.isArray((request.body as any)?.jobIds) ? (request.body as any).jobIds : [];
  return { jobs: promotionJobs(jobIds) };
});
app.get("/api/v2/admin/accounts/:id/promotion-check/:jobId", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const item = promotionJob(String((request.params as any).jobId));
  return item && String(item.accountId) === String((request.params as any).id)
    ? item : reply.code(404).send({ error: "优惠检测任务不存在" });
});
app.post("/api/v2/admin/accounts/:id/promotion-suspicion", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  const accountId = String((request.params as any).id);
  const suspicious = Boolean((request.body as any)?.suspicious);
  const item = setPromotionSuspicion(accountId, suspicious);
  return item || reply.code(404).send({ error: "账号不存在" });
});
app.get("/api/v2/admin/accounts/:id/payment-exposure-check/:jobId", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    return await getPaymentExposureCheckStatus(String((request.params as any).id), String((request.params as any).jobId));
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "支付检查任务不存在" });
  }
});
app.get("/api/v2/admin/accounts/:id", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const item = getAccountDetail(String((request.params as any).id));
  return item || reply.code(404).send({ error: "账号不存在" });
});

// AutoMyAI publishes only sanitized, structured observations here. This is an
// integration write, so it remains available while the admin shadow database
// is read-only and uses its own API key instead of the admin/import key.
app.post("/api/v2/internal/payment-exposure-check", async (request, reply) => {
  if (!config.paymentExposureApiKey) return reply.code(503).send({ error: "支付方式检查接收API未配置" });
  const provided = String(request.headers["x-api-key"] || "").trim();
  if (!constantTimeEqual(provided, config.paymentExposureApiKey)) return reply.code(401).send({ error: "API密钥无效" });
  if (!consumeRate(request, "payment-exposure-ingest", 2000)) return reply.code(429).send({ error: "支付检查接收请求过多" });
  const body = request.body as any;
  const checks = Array.isArray(body) ? body : Array.isArray(body?.checks) ? body.checks : body && typeof body === "object" ? [body] : [];
  if (!checks.length) return reply.code(400).send({ error: "请求必须包含单条检查记录或 checks 数组" });
  if (checks.length > 500) return reply.code(413).send({ error: "单次最多接收500条检查记录" });
  return { ok: true, ...ingestPaymentExposureChecks(checks) };
});

app.get("/api/v2/admin/accounts/:id/credentials", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    const accountId = String((request.params as any).id);
    if (v1AccountAuthority()) {
      const legacyId = currentLegacyMappingId(accountId);
      return requestV1(`/api/admin/mappings/${encodeURIComponent(legacyId)}/oauth`);
    }
    return revealCredentials(accountId) || {
      accessToken: "", refreshToken: "", idToken: "", sessionToken: "", openaiPassword: "",
    };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/accounts/:id/credentials", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    if (v1AccountAuthority()) {
      const legacyId = currentLegacyMappingId(accountId);
      const saved = await proxyV1AndScheduleSync(`/api/admin/mappings/${encodeURIComponent(legacyId)}/oauth`, {
        method: "POST", body,
      });
      return { ...saved.result, syncPending: saved.syncPending };
    }
    return saveAccountCredentials(accountId, body);
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/accounts/bulk-credentials", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  const body = request.body as any;
  const ids = [...new Set<string>((Array.isArray(body?.accountIds) ? body.accountIds : []).map((value: unknown) => String(value)).filter(Boolean))].slice(0, 500);
  if (!ids.length) return reply.code(400).send({ error: "没有选择账号" });
  const results = ids.map((id) => {
    const credentials = revealCredentials(id);
    return {
      id,
      primaryEmail: primaryEmailForAccount(id),
      accessToken: String(credentials?.accessToken || ""),
    };
  });
  return { results };
});
app.get("/api/v2/admin/accounts/:id/current-export", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  const item = getCurrentCustomerExport(String((request.params as any).id));
  if (!item) return reply.code(404).send({ error: "账号没有当前邮箱绑定" });
  if (!item.available) return reply.code(409).send({ error: item.reason, currentEmail: item.currentEmail });
  return item;
});
app.post("/api/v2/admin/accounts/bulk-current-export", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  const body = request.body as any;
  const ids = [...new Set<string>((Array.isArray(body?.accountIds) ? body.accountIds : []).map((value: unknown) => String(value)).filter(Boolean))].slice(0, 500);
  if (!ids.length) return reply.code(400).send({ error: "没有选择账号" });
  const results = ids.map((id) => {
    const item = getCurrentCustomerExport(id);
    return item ? { id, ...item } : { id, available: false, currentEmail: "", loginIdentifier: "", publicUrl: "", text: "", reason: "账号没有当前邮箱绑定" };
  });
  return { results };
});
app.patch("/api/v2/admin/accounts/:id", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const patch = request.body as any;
    if (v1AccountAuthority()) {
      if (Object.prototype.hasOwnProperty.call(patch || {}, "sold")) {
        const id = currentLegacyMappingId(accountId);
        await proxyV1AndSync("/api/admin/mappings/batch-sold", { method: "POST", body: { ids: [id], sold: Boolean(patch.sold) } });
      } else {
        await v1CompatCommand("patch", [accountId], { patch });
      }
      return getAccountDetail(accountId) || reply.code(404).send({ error: "账号不存在" });
    }
    const item = updateAccount(accountId, patch);
    return item || reply.code(404).send({ error: "账号不存在" });
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/accounts/:id/rebind", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const email = String((request.body as any)?.email || "");
    if (v1AccountAuthority()) return v1CompatCommand("rebind", [accountId], { email });
    return createRebind(accountId, email);
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/accounts/:id/deactivate", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const reason = String((request.body as any)?.reason || "admin_manual");
    if (v1AccountAuthority()) return v1CompatCommand("deactivate", [accountId], { reason });
    return deactivateAccount(accountId, reason);
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/accounts/:id/recycle", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const body = request.body as any;
    if (v1AccountAuthority()) {
      const id = currentLegacyMappingId(accountId);
      return (await proxyV1AndSync("/api/admin/mappings/recycle", {
        method: "POST",
        body: { ids: [id], mode: String(body?.mode || "deactivated") },
      })).result;
    }
    return body?.mode
      ? recycleAccountByMode(accountId, String(body.mode))
      : recycleAccount(accountId, String(body?.email || ""), String(body?.plan || "free"));
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/accounts/:id/grants", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  return { results: listAccountGrants(String((request.params as any).id)) };
});
app.post("/api/v2/admin/accounts/:id/grants", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const body = request.body as any;
    if (v1AccountAuthority()) return v1CompatCommand("grant", [accountId], body || {});
    return createCustomerGrant(accountId, String(body?.bindingId || ""), body || {});
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.delete("/api/v2/admin/accounts/:id/grants/:grantId", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  const params = request.params as any;
  if (v1AccountAuthority()) return v1CompatCommand("revoke", [String(params.id)]);
  return revokeCustomerGrant(String(params.id), String(params.grantId)) ? { ok: true } : reply.code(404).send({ error: "授权不存在" });
});
app.post("/api/v2/admin/accounts/bulk", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const body = request.body as any;
    const accountIds = Array.isArray(body?.accountIds) ? body.accountIds.map(String) : [];
    const action = String(body?.action || "");
    if (v1AccountAuthority()) {
      if (action === "deactivate") return v1CompatCommand("deactivate", accountIds, { reason: "V2 管理后台批量停用" });
      if (["markColor", "groupBoundary", "hidePromotion"].includes(action)) {
        const patchKey = action;
        return v1CompatCommand("patch", accountIds, { patch: { [patchKey]: body?.value } });
      }
      const ids = [...new Set(accountIds.map(currentLegacyMappingId))];
      if (action === "sold") {
        return (await proxyV1AndSync("/api/admin/mappings/batch-sold", { method: "POST", body: { ids, sold: Boolean(body?.value) } })).result;
      }
      if (action === "delete") {
        return (await proxyV1AndSync("/api/admin/mappings/batch-delete", { method: "POST", body: { ids } })).result;
      }
      if (action === "receiveDisabled") {
        return (await proxyV1AndSync("/api/admin/mappings/batch-receive", {
          method: "POST", body: { ids, disabled: Boolean(body?.value) },
        })).result;
      }
      return reply.code(400).send({ error: "V1 权威模式不支持这个批量操作" });
    }
    return applyBulkAction(accountIds, action, body?.value);
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/import/accounts", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  const body = request.body as any;
  if (!Array.isArray(body?.accounts)) return reply.code(400).send({ error: "accounts 必须是数组" });
  if (v1AccountAuthority()) {
    return (await proxyV1AndSync("/api/v1/accounts/import", { method: "POST", apiKey: true, body: { accounts: body.accounts } })).result;
  }
  return importAccounts(body.accounts);
});

app.get("/api/share/snapshot", async (request, reply) => {
  if (!consumeRate(request, "share-snapshot", 120)) return reply.code(429).send({ error: "请求过多，请稍后再试" });
  const token = String((request.query as any)?.t || (request.query as any)?.token || "");
  const item = readShareSnapshot(token, request.ip);
  return item || reply.code(410).send({ error: "分享链接无效、已过期或次数用尽" });
});

app.get("/api/v2/import/accounts", async (_request, reply) => reply.code(405).send({ error: "请使用POST" }));
app.post("/api/v2/import/accounts", async (request, reply) => {
  if (!consumeRate(request, "v2-import", 60)) return reply.code(429).send({ error: "导入请求过多" });
  if (!config.importApiKey) return reply.code(503).send({ error: "导入API未配置" });
  const provided = String(request.headers["x-api-key"] || "").trim();
  if (!constantTimeEqual(provided, config.importApiKey)) return reply.code(401).send({ error: "API密钥无效" });
  if (!requireWrite(reply)) return;
  const body = request.body as any;
  if (!Array.isArray(body?.accounts)) return reply.code(400).send({ error: "accounts 必须是数组" });
  if (v1AccountAuthority()) {
    return (await proxyV1AndSync("/api/v1/accounts/import", { method: "POST", apiKey: true, body: { accounts: body.accounts } })).result;
  }
  return importAccounts(body.accounts);
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const status = Number((error as any).statusCode || 500);
  reply.code(status).send({ error: status >= 500 ? "服务异常" : (error instanceof Error ? error.message : String(error)) });
});

app.get("/*", async (_request, reply) => {
  if (!fs.existsSync(path.join(webRoot, "index.html"))) return reply.code(503).type("text/plain").send("V2 web assets are not built");
  return reply.type("text/html; charset=utf-8").send(fs.createReadStream(path.join(webRoot, "index.html")));
});

await app.listen({ host: "127.0.0.1", port: config.port });
