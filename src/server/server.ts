import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { config } from "./config.js";
import { mailHealth } from "./mail-health.js";
import { recycleEligibilityAudit } from "./recycle-eligibility.js";
import { constantTimeEqual, signSession, verifySession } from "./crypto.js";
import {
  applyBulkAction,
  createRebind,
  createCustomerGrant,
  deactivateAccount,
  getAccountDetail,
  getCurrentCustomerExport,
  getRecycleEligibility,
  ingestPaymentExposureChecks,
  listAccounts,
  listAccountGrants,
  listPendingReviews,
  listRedGroups,
  importAccounts,
  migrationReport,
  overview,
  primaryEmailForAccount,
  provisionCurrentCustomerExport,
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
  getPaymentExposureBatchStatus,
  getPaymentExposureCheckStatus,
  listPaymentExposureRoutes,
  startPaymentExposureBatch,
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
  importThirdPartySessionFile,
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
import { registerCustomerRoutes } from "./customer-routes.js";
import { customerHtml } from "./customer-assets.js";
import { customerLoginPage } from "./customer-login-theme.js";
import { registerCompatibilityRoutes } from "./compatibility-routes.js";
import { ingestSharedMailEvent, manualSharedMailBackfill, recheckBillingEvidenceForMail, reprocessReviewedMail } from "./mail-sync.js";

export async function buildApp(options: { logger?: boolean } = {}) {
const app = Fastify({ logger: options.logger ?? false, disableRequestLogging: true, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
await app.register(cookie);
app.addHook("onRequest", async (request, reply) => {
  if (request.headers.origin && !sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
});

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
  reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-src 'self' about:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
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
  return [request.cookies.mail_opus_v2_admin, request.cookies.mail_opus_admin].some((token) => {
    const session = verifySession(String(token || ""));
    return Boolean(session && session.type === "admin" && session.id === "administrator");
  });
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

function commandWriterLabel(): string {
  return "v2";
}

function requireCommandWrite(reply: FastifyReply): boolean {
  if (commandWritesAvailable()) return true;
  reply.code(409).send({ error: "业务命令写入当前未启用" });
  return false;
}

function setSessionCookie(reply: FastifyReply, name: string, value: string, request: FastifyRequest): void {
  const loopbackAddress = (address: string) => address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
  const loopbackHost = (host: string) => {
    try {
      const parsed = new URL(`http://${host}`);
      return !parsed.username && !parsed.password && parsed.pathname === "/"
        && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
    } catch { return false; }
  };
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const forwardedHost = String(request.headers["x-forwarded-host"] || "");
  // The socket and original Host must both be local; forwarded headers alone cannot relax Secure.
  const localHttp = loopbackAddress(String(request.raw.socket.remoteAddress || ""))
    && loopbackHost(String(request.headers.host || "")) && (!forwardedHost || loopbackHost(forwardedHost))
    && !(request.raw.socket as { encrypted?: boolean }).encrypted && request.protocol !== "https"
    && forwardedProto.every((protocol) => protocol === "http") && !request.headers.forwarded;
  reply.setCookie(name, value, { httpOnly: true, secure: !localHttp, sameSite: "lax", path: "/", maxAge: 12 * 60 * 60 });
}

app.get("/health", async () => ({
  ok: true, service: "mail-opus-viewer-v2", readOnly: !commandWritesAvailable(), nativeReadOnly: config.readOnly,
  commandWriter: commandWriterLabel(), accountAuthority: config.accountAuthority,
  independent: true, release: releaseManifest(),
}));
app.get("/api/v2/health/coexistence", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const worker = db.prepare("SELECT status,heartbeat_at,artifact_sha256 FROM worker_heartbeats WHERE worker_name='native-sync-worker'").get() || null;
  const v1 = { mode: "retired", probed: false };
  return { v1, v2: { ok: true, nativeReadOnly: config.readOnly, worker }, commandWriter: commandWriterLabel(), hardDependency: false };
});
app.get("/api/v2/version", async () => ({ ok: true, release: releaseManifest() }));
app.get("/api/v2/status", async (request, reply) => requireAdmin(request, reply) ? overview() : undefined);

app.post("/api/v2/admin/login", async (request, reply) => {
  if (!consumeRate(request, "admin-login", 8)) return reply.code(429).send({ error: "登录尝试过多" });
  if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
  const body = request.body as any;
  if (!config.adminPassword || !constantTimeEqual(String(body?.password || ""), config.adminPassword)) return reply.code(401).send({ error: "后台口令不正确" });
  setSessionCookie(reply, "mail_opus_v2_admin", signSession("admin", "administrator"), request);
  return { ok: true };
});

app.post("/api/v2/admin/logout", async (_request, reply) => {
  reply.clearCookie("mail_opus_v2_admin", { path: "/" });
  reply.clearCookie("mail_opus_admin", { path: "/" });
  return { ok: true };
});
app.get("/api/v2/admin/session", async (request, reply) => adminSession(request)
  ? { ok: true, readOnly: !commandWritesAvailable(), nativeReadOnly: config.readOnly, commandWriter: commandWriterLabel(), accountAuthority: config.accountAuthority, independent: true }
  : reply.code(401).send({ error: "未登录" }));

app.get("/api/v2/admin/overview", async (request, reply) => requireAdmin(request, reply) ? overview() : undefined);
app.get("/api/v2/admin/mail-health", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
  reply.header("Cache-Control", "no-store");
  return mailHealth();
});
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
  try {
    const reviewId = String((request.params as any).id);
    const action = String((request.body as any)?.action || "");
    if (action === "reprocess_mail") return await reprocessReviewedMail(reviewId);
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
    return outlookFreePool(String((request.query as any)?.refresh || "") === "1");
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/outlook-free/refresh", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    return outlookFreePool(true);
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/outlook-free/mails", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const query = request.query as any;
    return outlookFreeMails(String(query?.email || ""), query?.offset, query?.limit);
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/outlook-free/mail-detail", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const query = request.query as any;
    return outlookFreeMailDetail(String(query?.email || ""), String(query?.id || ""), String(query?.folder || "inbox"));
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/accounts/:id/recent-mails", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const query = request.query as any;
    return listAdminAccountMails(accountId, query?.offset, query?.limit);
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/accounts/:id/recent-mail-detail", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const query = request.query as any;
    const accountId = String((request.params as any).id);
    const item = await adminAccountMailDetail(accountId, String(query?.id || ""));
    return item || reply.code(404).send({ error: "邮件不存在或不属于该账号" });
  } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/accounts/:id/verification-code", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    const accountId = String((request.params as any).id);
    return accountVerificationCode(accountId);
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/oauth/batch-preview", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    return previewOauthBatch((request.body as any)?.text || request.body);
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/oauth/batch-apply", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const body = request.body as any;
    return applyOauthBatch(body?.text, body?.previewHash, body?.confirm);
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/oauth-health/start", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    return startOauthHealth();
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/oauth-health/status", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    return oauthHealthStatus();
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
for (const [route, action] of [
  ["/api/v2/admin/import/outlook", importOutlook],
  ["/api/v2/admin/import/session", (input: unknown) => importSession(input)],
  ["/api/v2/admin/import/outlook-transfer-preview", previewOutlookTransfer],
  ["/api/v2/admin/import/outlook-transfer", applyOutlookTransfer],
] as const) {
  app.post(route, async (request, reply) => {
    if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
    try {
      const body = request.body as any;
      const input = body?.accounts || body?.accountString || body?.emails || "";
      return action(input);
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
app.post("/api/v2/admin/import/third-party-file", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const body = request.body as any;
    return importThirdPartySessionFile(body?.paths || body?.path || body?.filePath || body?.file || "");
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/usage-audit", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    return runUsageAudit();
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/share/links", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  try {
    return listShareLinks();
  }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/share/links", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    return createShareLink(request.body as any);
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.delete("/api/v2/admin/share/links/:id", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  try {
    const id = String((request.params as any).id);
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
    const promoMode = String(body?.promoMode || "none").trim().toLowerCase();
    if (!["none", "one_month"].includes(promoMode)) return reply.code(400).send({ error: "支付方式探查优惠模式无效" });
    return await startPaymentExposureCheck(String((request.params as any).id), routeKey, { promoMode: promoMode as any });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "支付检查启动失败" });
  }
});
app.post("/api/v2/admin/accounts/payment-exposure-check", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  if (!consumeRate(request, "payment-exposure-bulk-start", 10)) return reply.code(429).send({ error: "批量支付检查请求过多" });
  try {
    const body = request.body as any;
    if (!Array.isArray(body?.accountIds) || body.accountIds.length > 24) return reply.code(413).send({ error: "批量支付方式探查单次最多选择 24 个账号" });
    const accountIds = body.accountIds.map(String);
    if (!Array.isArray(body?.routeKeys) || body.routeKeys.length !== 1) return reply.code(400).send({ error: "批量支付方式探查必须先选择一个具体 method" });
    const routeKeys = body.routeKeys.map(String);
    const promoMode = String(body?.promoMode || "none").trim().toLowerCase();
    if (!["none", "one_month"].includes(promoMode)) return reply.code(400).send({ error: "支付方式探查优惠模式无效" });
    return await startPaymentExposureBatch(accountIds, routeKeys, promoMode as any);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "批量支付检查启动失败" });
  }
});
app.post("/api/v2/admin/accounts/payment-exposure-check/status", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  const jobs = Array.isArray((request.body as any)?.jobs) ? (request.body as any).jobs : [];
  if (jobs.length > 24) return reply.code(413).send({ error: "批量支付方式探查单次最多查询 24 个账号" });
  return { jobs: await getPaymentExposureBatchStatus(jobs) };
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
    return revealCredentials(accountId) || {
      accessToken: "", refreshToken: "", idToken: "", sessionToken: "", openaiPassword: "", totpSecret: "",
    };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/accounts/:id/credentials", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
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
  try {
    const item = provisionCurrentCustomerExport(String((request.params as any).id));
    if (!item) return reply.code(404).send({ error: "账号没有当前邮箱绑定" });
    if (!item.available) return reply.code(409).send({ error: item.reason, currentEmail: item.currentEmail });
    return item;
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/v2/admin/accounts/bulk-current-export", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request)) return;
  const body = request.body as any;
  const ids = [...new Set<string>((Array.isArray(body?.accountIds) ? body.accountIds : []).map((value: unknown) => String(value)).filter(Boolean))].slice(0, 500);
  if (!ids.length) return reply.code(400).send({ error: "没有选择账号" });
  const results = ids.map((id) => {
    try {
      const item = provisionCurrentCustomerExport(id);
      return item ? { id, ...item } : { id, available: false, currentEmail: "", loginIdentifier: "", publicUrl: "", text: "", reason: "账号没有当前邮箱绑定" };
    } catch (error) {
      return { id, available: false, currentEmail: primaryEmailForAccount(id), loginIdentifier: "", publicUrl: "", text: "",
        reason: error instanceof Error ? error.message : String(error) };
    }
  });
  return { results };
});
app.patch("/api/v2/admin/accounts/:id", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const patch = request.body as any;
    const item = updateAccount(accountId, patch);
    return item || reply.code(404).send({ error: "账号不存在" });
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/accounts/:id/rebind", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const email = String((request.body as any)?.email || "");
    return createRebind(accountId, email);
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/accounts/:id/deactivate", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const reason = String((request.body as any)?.reason || "admin_manual");
    return deactivateAccount(accountId, reason);
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/v2/admin/accounts/:id/recycle-eligibility", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const eligibility = getRecycleEligibility(String((request.params as any).id));
  return eligibility || reply.code(404).send({ error: "账号不存在" });
});
app.post("/api/v2/admin/accounts/:id/recycle", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const accountId = String((request.params as any).id);
    const body = request.body as any;
    if (body?.confirmRevokeCustomerAccess !== true) throw new Error("请管理员明确确认回收将撤销原客户链接和会话");
    if (body?.mode !== undefined) return recycleAccountByMode(accountId, String(body.mode));
    // The older custom-address entry must honor the same eligibility rule as
    // the mode buttons. Omitting mode cannot bypass the seven-day boundary.
    return db.transaction(() => {
      const eligibility = getRecycleEligibility(accountId);
      if (!eligibility) throw new Error("账号不存在");
      if (!eligibility.modes.deactivated.eligible) throw new Error(eligibility.modes.deactivated.reason);
      const result = recycleAccount(accountId, String(body?.email || ""), String(body?.plan || "free"));
      db.prepare(`INSERT INTO account_business_evidence(account_id,recycle_generation,updated_at) VALUES(?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET recycle_generation=excluded.recycle_generation,updated_at=excluded.updated_at`)
        .run(result.replacement.id, eligibility.generation + 1, new Date().toISOString());
      db.prepare(`UPDATE account_relations SET evidence_json=json_set(evidence_json,'$.mode','deactivated','$.eligibility',json(?))
        WHERE relation_type='mailbox_recycle' AND from_account_id=? AND to_account_id=?`)
        .run(JSON.stringify(recycleEligibilityAudit(eligibility, "deactivated")), accountId, result.replacement.id);
      return { previous: result.previous, replacement: getAccountDetail(result.replacement.id)! };
    }).immediate();
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
    return createCustomerGrant(accountId, String(body?.bindingId || ""), body || {});
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.delete("/api/v2/admin/accounts/:id/grants/:grantId", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  const params = request.params as any;
  return revokeCustomerGrant(String(params.id), String(params.grantId)) ? { ok: true } : reply.code(404).send({ error: "授权不存在" });
});
app.post("/api/v2/admin/accounts/bulk", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  try {
    const body = request.body as any;
    const accountIds = Array.isArray(body?.accountIds) ? body.accountIds.map(String) : [];
    const action = String(body?.action || "");
    return applyBulkAction(accountIds, action, body?.value);
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/v2/admin/import/accounts", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireCommandWrite(reply)) return;
  const body = request.body as any;
  if (!Array.isArray(body?.accounts)) return reply.code(400).send({ error: "accounts 必须是数组" });
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
  return importAccounts(body.accounts);
});

app.setErrorHandler((error, _request, reply) => {
  const status = Number((error as any).statusCode || (error as any).status || 500);
  app.log.error({ code: String((error as any).code || "REQUEST_ERROR"), statusCode: status }, "request failed");
  reply.code(status).send({ error: status >= 500 ? "服务异常" : (error instanceof Error ? error.message : String(error)) });
});

await registerCustomerRoutes(app, { consumeRate, sameOrigin, requireWrite, setSessionCookie });
await registerCompatibilityRoutes(app, { consumeRate, sameOrigin, requireWrite, requireAdmin, adminSession, setSessionCookie });

app.post("/api/v2/internal/mail-events", { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
  if (!config.mailWebhookSecret) return reply.code(503).send({ error: "邮件推送未配置" });
  const provided = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!constantTimeEqual(provided, config.mailWebhookSecret)) return reply.code(401).send({ error: "推送密钥无效" });
  if (!requireWrite(reply)) return;
  return { ok: true, ...await ingestSharedMailEvent(request.body) };
});
app.post("/api/v2/admin/mail-backfill", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
  if (!requireWrite(reply)) return;
  return manualSharedMailBackfill(request.body as any);
});
app.post("/api/v2/admin/accounts/:id/billing-recheck", async (request, reply) => {
  if (!requireAdmin(request, reply) || !sameOrigin(request) || !requireWrite(reply)) return;
  const accountId = String((request.params as any)?.id || "");
  const messageId = String((request.body as any)?.messageId || "").trim();
  if (!/^[1-9][0-9]{0,15}$/.test(messageId)) return reply.code(400).send({ error: "必须提供一个邮件ID" });
  const owner = db.prepare(`SELECT 1 FROM mail_messages m JOIN mail_ownership_claims c ON c.message_id=m.id
    WHERE m.provider='shared-mail-api' AND m.provider_message_id=? AND c.account_id=? LIMIT 1`).get(messageId, accountId);
  if (!owner) return reply.code(404).send({ error: "邮件不存在或不属于该账号" });
  try {
    const result = await recheckBillingEvidenceForMail(messageId);
    if (!result.accountIds.includes(accountId)) return reply.code(409).send({ error: "邮件归属不唯一，未改写套餐或渠道" });
    const account = db.prepare("SELECT plan,billing_channel FROM gpt_accounts WHERE id=?").get(accountId) as any;
    return { ok: true, ...result, accountId, plan: String(account?.plan || "unknown"),
      billingChannel: String(account?.billing_channel || result.billingChannel || "") };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "账单邮件复核失败" });
  }
});

app.get("/api/*", async (_request, reply) => reply.code(404).send({ error: "接口不存在" }));
app.get("/*", async (request, reply) => {
  if (request.url.split("?")[0] === "/") return reply.type("text/html; charset=utf-8").send(customerLoginPage(customerHtml));
  if (!fs.existsSync(path.join(webRoot, "index.html"))) return reply.code(503).type("text/plain").send("V2 web assets are not built");
  return reply.type("text/html; charset=utf-8").send(fs.createReadStream(path.join(webRoot, "index.html")));
});

return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const app = await buildApp({ logger: true });
  await app.listen({ host: "127.0.0.1", port: config.port });
}
