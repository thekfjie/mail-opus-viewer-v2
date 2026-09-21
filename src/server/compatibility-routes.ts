import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { constantTimeEqual, signSession } from "./crypto.js";
import { db } from "./db.js";
import { emailHash, normalizeEmail } from "./association.js";
import { applyBulkAction, createCustomerGrant, createRebind, deactivateAccount, listAccountGrants,
  listAccounts, recycleAccountByMode, revealCredentials, revokeCustomerGrant, saveAccountCredentials, updateAccount } from "./repository.js";
import { accountVerificationCode, adminAccountMailDetail, listAdminAccountMails, outlookFreeMailDetail, outlookFreeMails, outlookFreePool, pendingMailboxVerificationCode } from "./native-mail.js";
import { applyOauthBatch, applyOutlookTransfer, createShareLink, importOutlook, importSession, listShareLinks,
  oauthHealthStatus, previewOauthBatch, previewOutlookTransfer, revokeShareLink, runUsageAudit, startOauthHealth } from "./native-operations.js";
import { accountForEmail, cleanupCompatibilityAccount, compatibilityMapping, pendingMailboxForEmail, pendingMailboxes,
  resolveCompatibilityAccount, saveCompatibilityProbe, upsertCompatibilityAccount } from "./compatibility-state.js";
import type { CustomerRouteContext } from "./customer-routes.js";
import { pickupMailboxVerificationCode } from "./pickup-mail.js";

interface CompatibilityContext extends CustomerRouteContext {
  requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean;
  adminSession(request: FastifyRequest): boolean;
}

export async function registerCompatibilityRoutes(app: FastifyInstance, context: CompatibilityContext) {
  const { consumeRate, requireWrite, requireAdmin, sameOrigin, adminSession, setSessionCookie } = context;
  const ids = (body: any): string[] => [...new Set<string>((Array.isArray(body?.ids) ? body.ids : Array.isArray(body?.accountIds) ? body.accountIds : [])
    .map(String))].slice(0, 500).map(resolveCompatibilityAccount);
  function importAccess(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!config.importApiKey) { reply.code(503).send({ error: "导入 API 未配置" }); return false; }
    const provided = String(request.headers["x-api-key"] || String(request.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!constantTimeEqual(provided, config.importApiKey)) { reply.code(401).send({ error: "API 密钥无效" }); return false; }
    if (!consumeRate(request, "compat-import", 600)) { reply.code(429).send({ error: "请求过多" }); return false; }
    return requireWrite(reply);
  }
  function writeAdmin(request: FastifyRequest, reply: FastifyReply) {
    if (!requireAdmin(request, reply)) return false;
    if (!sameOrigin(request)) { reply.code(403).send({ error: "请求来源不允许" }); return false; }
    return requireWrite(reply);
  }
  app.post("/api/admin/login", async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
    if (!consumeRate(request, "admin-login", 8)) return reply.code(429).send({ error: "登录尝试过多" });
    const body = request.body as any;
    if (body?.username || !config.adminPassword || !constantTimeEqual(String(body?.password || ""), config.adminPassword)) return reply.code(401).send({ error: "后台口令不正确" });
    const session = signSession("admin", "administrator");
    setSessionCookie(reply, "mail_opus_v2_admin", session, request);
    setSessionCookie(reply, "mail_opus_admin", session, request);
    return { ok: true };
  });
  app.post("/api/admin/logout", async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: "请求来源不允许" });
    reply.clearCookie("mail_opus_v2_admin", { path: "/" });
    reply.clearCookie("mail_opus_admin", { path: "/" });
    return { ok: true };
  });
  app.get("/api/admin/session", async (request, reply) => adminSession(request) ? { ok: true } : reply.code(401).send({ error: "未登录" }));

  app.post("/api/v1/accounts", async (request, reply) => {
    if (!importAccess(request, reply)) return;
    const result = upsertCompatibilityAccount(request.body);
    reply.code(result.created ? 201 : 200);
    return result;
  });
  app.post("/api/v1/accounts/import", async (request, reply) => {
    if (!importAccess(request, reply)) return;
    const body = request.body as any;
    const items = Array.isArray(body) ? body : body?.accounts || body?.items;
    if (!Array.isArray(items) || !items.length || items.length > 200) return reply.code(400).send({ error: "单次导入 1 至 200 个账号" });
    let created = 0, updated = 0, failed = 0;
    const results = items.map((input, index) => {
      try {
        const result = upsertCompatibilityAccount(input);
        if (result.created) created += 1; else updated += 1;
        return { index, ...result, email: result.item?.email, id: result.item?.id };
      } catch (error) { failed += 1; return { index, ok: false, error: error instanceof Error ? error.message : "保存失败" }; }
    });
    return { ok: failed === 0, total: items.length, created, updated, failed, results };
  });
  app.post("/api/v1/accounts/cleanup", async (request, reply) => importAccess(request, reply) ? cleanupCompatibilityAccount(request.body) : undefined);
  app.post("/api/v1/accounts/hidden-probe-tag", async (request, reply) => importAccess(request, reply) ? saveCompatibilityProbe(request.body as any) : undefined);
  app.post("/api/v1/compat/command", async (request, reply) => {
    if (!importAccess(request, reply)) return;
    const body = request.body as any;
    const accountIds = ids(body);
    if (!accountIds.length) return reply.code(400).send({ error: "请选择账号" });
    const results = accountIds.map((id) => {
      switch (String(body.action || "")) {
        case "patch": return updateAccount(id, body.patch || {});
        case "rebind": return createRebind(id, String(body.email || ""));
        case "deactivate": return deactivateAccount(id, String(body.reason || "admin_manual"));
        case "grant": return createCustomerGrant(id, String(body.bindingId || ""), body);
        case "revoke": return { revoked: listAccountGrants(id).filter((grant: any) => revokeCustomerGrant(id, String(grant.id))).length };
        default: throw Object.assign(new Error("不支持的命令"), { statusCode: 400 });
      }
    });
    return { ok: true, updated: results.length };
  });

  app.get("/api/admin/mappings", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = request.query as any;
    const view = String(query?.view || "");
    const rebindTargets = query?.includeRebindTargets === "1" ? pendingMailboxes("rebind") : [];
    if (view === "openai-pending" || view === "openai-retry") {
      const registered = view === "openai-retry" ? listAccounts({ limit: 500 }).results.map((row) => compatibilityMapping(row.id))
        .filter((row) => row.note === "automyai UC signup registered" && !row.hasAccessToken && !row.hasRefreshToken && !row.sold) : [];
      return { results: [...pendingMailboxes("signup"), ...registered, ...rebindTargets], flagsRefreshing: false, temporary: true };
    }
    const results: Record<string, any>[] = [];
    let offset = 0;
    while (true) {
      const page = listAccounts({ limit: 500, offset, search: String(query?.search || "") });
      results.push(...page.results.map((row) => compatibilityMapping(row.id)));
      if (results.length >= page.total || !page.results.length) break;
      offset += page.results.length;
    }
    return { results: [...results, ...rebindTargets], flagsRefreshing: false };
  });
  app.get("/api/admin/pending-mailboxes", async (request, reply) => requireAdmin(request, reply) ? { results: pendingMailboxes() } : undefined);
  app.get("/api/admin/mapping-flags", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const requested = String((request.query as any)?.ids || "").split(",").filter(Boolean).slice(0, 500);
    return { results: requested.map(resolveCompatibilityAccount).map(compatibilityMapping), flagsRefreshing: false };
  });
  app.get("/api/admin/mapping-mails", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = request.query as any;
    return listAdminAccountMails(resolveCompatibilityAccount(String(query?.id || "")), query.offset, query.limit);
  });
  app.get("/api/admin/mapping-mail-detail", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = request.query as any;
    return await adminAccountMailDetail(resolveCompatibilityAccount(String(query?.mappingId || "")), String(query?.id || ""))
      || reply.code(404).send({ error: "邮件不存在或不属于该账号" });
  });
  app.get("/api/admin/mapping-verification-code", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = request.query as any;
    const id = String(query?.id || "");
    const pending = pendingMailboxes().find((item) => item.id === id);
    if (pending) return pendingMailboxVerificationCode(String(pending.email));
    const accountId = resolveCompatibilityAccount(id);
    const binding = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND (id=? OR legacy_mapping_id=?)").get(accountId, id, id) as any;
    return accountVerificationCode(accountId, { bindingId: binding?.id, ignoreAccessWindow: query?.ignoreAccessWindow === "1" });
  });
  app.get("/api/admin/email-verification-code", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const email = String((request.query as any)?.email || "");
    const pending = pendingMailboxForEmail(email);
    if (pending) return pendingMailboxVerificationCode(String(pending.email));
    const accountId = accountForEmail(email);
    const binding = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1 AND email_hash=?")
      .get(accountId, emailHash(normalizeEmail(email))) as any;
    return accountVerificationCode(accountId, { bindingId: binding?.id });
  });
  app.get("/api/admin/pickup-verification-code", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.header("Cache-Control", "no-store");
    const query = request.query as any;
    return pickupMailboxVerificationCode(query?.email, {
      sourceEmail: String(query?.sourceEmail || ""), since: String(query?.since || ""),
      until: query?.until ? String(query.until) : undefined,
      allowBaseRecipient: query?.allowBaseRecipient === "1",
    });
  });
  app.get("/api/admin/mappings/:id/oauth", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const id = resolveCompatibilityAccount(String((request.params as any).id));
    return { ...revealCredentials(id), id, email: compatibilityMapping(id).email };
  });
  app.post("/api/admin/mappings/:id/oauth", async (request, reply) => {
    if (!writeAdmin(request, reply)) return;
    return saveAccountCredentials(resolveCompatibilityAccount(String((request.params as any).id)), request.body as any);
  });
  app.post("/api/admin/mappings/batch-access-tokens", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return { results: ids(request.body).map((id) => ({ id, email: compatibilityMapping(id).email, accessToken: revealCredentials(id)?.accessToken || "" })) };
  });
  app.post("/api/admin/mappings", async (request, reply) => {
    if (!writeAdmin(request, reply)) return;
    const result = upsertCompatibilityAccount(request.body);
    return { ...result, item: result.temporary ? result.item : compatibilityMapping(String(result.item.id)) };
  });
  app.delete("/api/admin/mappings/:id", async (request, reply) => {
    if (!writeAdmin(request, reply)) return;
    const id = resolveCompatibilityAccount(String((request.params as any).id));
    return { ok: true, ...applyBulkAction([id], "delete", true) };
  });
  app.post("/api/admin/mappings/:id/color", async (request, reply) => {
    if (!writeAdmin(request, reply)) return;
    const id = resolveCompatibilityAccount(String((request.params as any).id));
    updateAccount(id, { markColor: (request.body as any)?.markColor || (request.body as any)?.color || "" });
    return { ok: true, item: compatibilityMapping(id) };
  });
  for (const [route, action, field] of [
    ["batch-sold", "sold", "sold"], ["batch-receive", "receiveDisabled", "disabled"], ["batch-delete", "delete", ""],
  ] as const) app.post(`/api/admin/mappings/${route}`, async (request, reply) => {
    if (!writeAdmin(request, reply)) return;
    return { ok: true, ...applyBulkAction(ids(request.body), action, field ? Boolean((request.body as any)?.[field]) : true) };
  });
  app.post("/api/admin/mappings/recycle", async (request, reply) => {
    if (!writeAdmin(request, reply)) return;
    // Legacy registration clients called alias_rotate automatically using an
    // admin cookie. Alias rotation is safe without an explicit confirmation
    // only when no active customer grant exists; all other recycle modes keep
    // the explicit confirmation boundary.
    const body = request.body as any;
    const mode = String(body?.mode ?? "deactivated");
    const confirmed = body?.confirmRevokeCustomerAccess === true;
    const targetIds = ids(body);
    const hasActiveCustomerGrant = (accountId: string) => Boolean(db.prepare(
      "SELECT 1 FROM access_grants WHERE account_id=? AND active=1 AND scope!='admin_only' LIMIT 1",
    ).get(accountId));
    if (!confirmed && (mode !== "alias_rotate" || targetIds.some(hasActiveCustomerGrant))) {
      return reply.code(400).send({ error: "请管理员明确确认回收将撤销原客户链接和会话" });
    }
    const results: Record<string, any>[] = [], errors: Record<string, any>[] = [];
    for (const id of targetIds) {
      try {
        const result = recycleAccountByMode(id, mode);
        results.push(compatibilityMapping(result.replacement.id));
      } catch (error) { errors.push({ id, error: error instanceof Error ? error.message : "回收失败" }); }
    }
    if (errors.length && !results.length) reply.code(400);
    return { ok: !errors.length, recycled: results.length, results, errors };
  });
  for (const [route, action, readOnly] of [
    ["/api/admin/oauth/batch-preview", (body: any) => previewOauthBatch(body.text || body), true],
    ["/api/admin/oauth/batch-apply", (body: any) => applyOauthBatch(body.text, body.previewHash, body.confirm), false],
    ["/api/admin/oauth-health/all-normal", () => startOauthHealth(), false],
    ["/api/admin/outlook/import", (body: any) => importOutlook(body.accounts || body.accountString || ""), false],
    ["/api/admin/session/import", (body: any) => importSession(body.accounts || body.accountString || ""), false],
    ["/api/admin/outlook/transfer/preview", (body: any) => previewOutlookTransfer(body.emails || body.accounts || ""), true],
    ["/api/admin/outlook/transfer", (body: any) => applyOutlookTransfer(body.emails || body.accounts || ""), false],
    ["/api/admin/usage-audit", () => runUsageAudit(), false],
    ["/api/admin/outlook/free-pool/refresh", () => outlookFreePool(true), true],
  ] as const) app.post(route, async (request, reply) => {
    if (!(readOnly ? requireAdmin(request, reply) : writeAdmin(request, reply))) return;
    return action(request.body || {});
  });
  app.get("/api/admin/oauth-health/status", async (request, reply) => requireAdmin(request, reply) ? oauthHealthStatus() : undefined);
  app.get("/api/admin/outlook/free-pool", async (request, reply) => requireAdmin(request, reply) ? outlookFreePool((request.query as any)?.refresh === "1") : undefined);
  app.get("/api/admin/outlook/free-pool/mails", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = request.query as any;
    return outlookFreeMails(String(query.email || ""), query.offset, query.limit);
  });
  app.get("/api/admin/outlook/free-pool/mail-detail", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const query = request.query as any;
    return outlookFreeMailDetail(String(query.email || ""), String(query.id || ""), String(query.folder || "inbox"));
  });
  app.get("/api/admin/share/links", async (request, reply) => requireAdmin(request, reply) ? listShareLinks() : undefined);
  app.post("/api/admin/share/links", async (request, reply) => writeAdmin(request, reply) ? createShareLink(request.body as any) : undefined);
  app.delete("/api/admin/share/links/:id", async (request, reply) => writeAdmin(request, reply) ? revokeShareLink(String((request.params as any).id)) : undefined);
}
