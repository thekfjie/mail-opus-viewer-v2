import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("API 与 Worker 的 SQLite 写入保留有界 busy timeout", () => {
  const configSource = fs.readFileSync(path.join(process.cwd(), "src/server/config.ts"), "utf8");
  const dbSource = fs.readFileSync(path.join(process.cwd(), "src/server/storage/legacy-sqlite-bootstrap.ts"), "utf8");
  assert.match(configSource, /V2_SQLITE_BUSY_TIMEOUT_MS\s*\|\|\s*30_000/);
  assert.match(dbSource, /busy_timeout = \$\{config\.sqliteBusyTimeoutMs\}/);
});

test("单账号凭证保存直接调用本地领域服务，不异步投影旧状态", () => {
  const server = fs.readFileSync(path.join(process.cwd(), "src/server/server.ts"), "utf8");
  assert.match(server, /return \(await saveAccountCredentials\(accountId, body\)\)/);
  assert.doesNotMatch(server, /proxyV1AndScheduleSync|syncPending/);
});

test("导入、永久停用、改绑、授权截止和回收保持账号隔离", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-writes-"));
  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "writes-test-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "writes-test-encryption";
  process.env.PUBLIC_ORIGIN = "https://mail.example.test";
  process.env.V2_READ_ONLY = "false";
  process.env.V2_ACCOUNT_AUTHORITY = "v2";

  const [{ db }, association, repository] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/association.js"),
    import("../src/server/repository.js"),
  ]);
  t.after(async () => (await db.close()));

  const imported = (await repository.importAccounts([{
    email: "locked+oai@icloud.com",
    accessToken: "at-secret",
    refreshToken: "rt-secret",
    openaiSubject: "openai-user-1",
    plan: "plus",
    note: "只保存正常备注",
  }]));
  assert.deepEqual(imported, { imported: 1, created: 1, rebound: 0, errors: [] });
  const account = (await db.prepare("SELECT a.* FROM gpt_accounts a JOIN email_bindings b ON b.account_id=a.id WHERE b.email_hash=?").get(
    association.emailHash("locked+oai@icloud.com"),
  )) as any;
  assert.ok(account);
  assert.equal(account.note, "只保存正常备注");
  assert.equal(account.note.includes("at-secret"), false);
  assert.deepEqual((await repository.revealCredentials(account.id)), {
    accessToken: "at-secret",
    refreshToken: "rt-secret",
    idToken: "",
    sessionToken: "",
    openaiPassword: "",
    totpSecret: "",
  });
  const automaticExport = (await repository.provisionCurrentCustomerExport(account.id));
  assert.equal(automaticExport?.available, true);
  assert.ok(automaticExport?.publicUrl.startsWith("https://mail.example.test/#m="));
  const automaticToken = new URL(String(automaticExport?.publicUrl)).hash.replace(/^#m=/, "");
  assert.ok((await repository.grantByPublicToken(automaticToken)));
  assert.deepEqual(
    (await db.prepare("SELECT sold FROM gpt_accounts WHERE id=?").get(account.id)),
    { sold: 0 },
  );
  assert.deepEqual(
    (await db.prepare("SELECT sale_id,active,scope FROM access_grants WHERE account_id=? AND active=1 AND scope='current' AND sale_id IS NULL LIMIT 1").get(account.id)),
    { sale_id: null, active: 1, scope: "current" },
  );
  const manuallySaved = (await repository.saveAccountCredentials(account.id, {
    accessToken: "manual-at", refreshToken: "manual-rt", idToken: "", sessionToken: "", openaiPassword: "manual-password",
  }));
  assert.equal(manuallySaved.hasAccessToken, true);
  assert.equal((await repository.revealCredentials(account.id))?.accessToken, "manual-at");
  assert.equal((await repository.revealCredentials(account.id))?.refreshToken, "manual-rt");
  assert.equal((await repository.revealCredentials(account.id))?.openaiPassword, "manual-password");

  const oldBinding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(account.id)) as any;
  const grant = (await repository.createCustomerGrant(account.id, oldBinding.id, { password: "customer-password" }));
  assert.ok(grant.publicUrl.startsWith("https://mail.example.test/#m="));
  assert.equal(grant.password, "customer-password");
  assert.ok((await repository.grantByPublicToken(grant.publicToken)));
  const parallelGrant = (await repository.createCustomerGrant(account.id, oldBinding.id, { password: "parallel-customer-password" }));
  assert.ok((await repository.grantByPublicToken(grant.publicToken)));
  assert.ok((await repository.grantByPublicToken(parallelGrant.publicToken)));
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM access_grants WHERE account_id=? AND active=1 AND scope='current'").get(account.id)) as any).n, 3);

  (await repository.deactivateAccount(account.id, "detected_bad"));
  assert.deepEqual((await db.prepare("SELECT scope,visible_to,active FROM access_grants WHERE id=?").get(grant.grantId)),
    { scope: "current", visible_to: "", active: 1 });
  assert.ok((await repository.grantByPublicToken(grant.publicToken)));
  const rebound = (await repository.importAccounts([{
    email: "locked+oai@ai-mail.tech",
    accessToken: "new-at",
    refreshToken: "new-rt",
    openaiSubject: "openai-user-1",
    plan: "plus",
  }]));
  assert.deepEqual(rebound, { imported: 1, created: 0, rebound: 1, errors: [] });
  const afterRebind = (await db.prepare("SELECT lifecycle_status, deactivation_locked, deactivated_at FROM gpt_accounts WHERE id=?").get(account.id)) as any;
  assert.equal(afterRebind.lifecycle_status, "deactivated");
  assert.equal(afterRebind.deactivation_locked, 1);
  assert.ok(afterRebind.deactivated_at);
  const oldGrant = (await db.prepare("SELECT scope, visible_to, active FROM access_grants WHERE id=?").get(grant.grantId)) as any;
  assert.equal(oldGrant.scope, "historical");
  assert.ok(oldGrant.visible_to);
  assert.equal(oldGrant.active, 1);
  const newBinding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(account.id)) as any;
  const inherited = (await db.prepare("SELECT scope, active FROM access_grants WHERE binding_id=?").all(newBinding.id)) as any[];
  assert.ok(inherited.length >= 1);
  assert.ok(inherited.every((item) => item.scope === "admin_only" && item.active === 0));
  assert.equal(((await db.prepare("SELECT count(*) count FROM credential_versions WHERE account_id=?").get(account.id)) as any).count, 3);
  assert.deepEqual((await repository.revealCredentials(account.id)), {
    accessToken: "new-at",
    refreshToken: "new-rt",
    idToken: "",
    sessionToken: "",
    openaiPassword: "",
    totpSecret: "",
  });
  assert.equal(((await db.prepare(`SELECT count(*) count FROM credential_versions
    WHERE account_id=? AND retired_reason='superseded'`).get(account.id)) as any).count, 2);
  assert.equal((await repository.getCurrentCustomerExport(account.id))?.available, false);
  const reboundGrant = (await repository.createCustomerGrant(account.id, newBinding.id, { password: "new-customer-password" }));
  assert.ok((await repository.grantByPublicToken(reboundGrant.publicToken)));

  const recycled = (await repository.recycleAccount(account.id, "fresh-child@kfjie.me", "free"));
  assert.equal(recycled.previous.lifecycleStatus, "deactivated");
  assert.equal(recycled.previous.deactivationLocked, true);
  assert.equal(recycled.replacement.lifecycleStatus, "active");
  assert.equal(recycled.replacement.deactivationLocked, false);
  const oldRow = (await db.prepare("SELECT retired_at, deleted_at FROM gpt_accounts WHERE id=?").get(account.id)) as any;
  assert.ok(oldRow.retired_at);
  assert.equal(oldRow.deleted_at, "");
  assert.equal((await repository.grantByPublicToken(grant.publicToken)), null);
  assert.equal((await repository.grantById(grant.grantId)), null);
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM access_grants WHERE account_id=? AND scope!='admin_only' AND active=1").get(account.id)) as any).n, 0);
  assert.equal((await db.prepare("SELECT 1 FROM credentials WHERE account_id=?").get(recycled.replacement.id)), undefined);
  const replacementGrants = (await db.prepare("SELECT scope, active FROM access_grants WHERE account_id=?").all(recycled.replacement.id)) as any[];
  assert.ok(replacementGrants.length >= 1);
  assert.ok(replacementGrants.every((item) => item.scope === "admin_only" && item.active === 0));
  assert.equal(Number(((await db.prepare("SELECT COUNT(*) count FROM account_relations WHERE from_account_id=? AND to_account_id=? AND relation_type='mailbox_recycle'").get(
    account.id, recycled.replacement.id,
  )) as any).count), 1);

  const reboundReplacement = (await repository.createRebind(recycled.replacement.id, "fresh-child@ai-mail.tech"));
  assert.equal(reboundReplacement.id, recycled.replacement.id);
  assert.equal(reboundReplacement.bindingCount, 2);
  assert.equal(reboundReplacement.deactivationLocked, false);
  assert.equal((await repository.revealCredentials(recycled.replacement.id)), null);
  const credentialImport = (await repository.importAccounts([{
    email: "fresh-child@ai-mail.tech",
    accessToken: "fresh-at",
    refreshToken: "fresh-rt",
    openaiSubject: "openai-user-2",
    plan: "plus",
  }]));
  assert.deepEqual(credentialImport, { imported: 1, created: 0, rebound: 0, errors: [] });
  assert.equal(((await db.prepare("SELECT count(*) count FROM credential_versions WHERE account_id=?").get(recycled.replacement.id)) as any).count, 1);
  const currentVersion = (await db.prepare(`SELECT cv.token_fingerprint, cv.validity_status FROM account_current_credentials cc
    JOIN credential_versions cv ON cv.id=cc.credential_version_id WHERE cc.account_id=?`).get(recycled.replacement.id)) as any;
  assert.ok(currentVersion.token_fingerprint);
  assert.equal(currentVersion.validity_status, "alive");
  const replacementBinding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(recycled.replacement.id)) as any;
  const replacementGrant = (await repository.createCustomerGrant(recycled.replacement.id, replacementBinding.id, { password: "replacement-customer-password" }));
  assert.ok((await repository.grantByPublicToken(replacementGrant.publicToken)));
  const currentExport = (await repository.getCurrentCustomerExport(recycled.replacement.id));
  assert.equal(currentExport?.available, true);
  assert.equal(currentExport?.currentEmail, "fresh-child@ai-mail.tech");
  assert.ok(currentExport?.publicUrl.startsWith("https://mail.example.test/#m="));
  assert.equal(currentExport?.text, `ai账号：fresh-child@ai-mail.tech | 邮箱验证码：${currentExport?.publicUrl}`);
  assert.ok(currentExport?.text.endsWith(String(currentExport?.publicUrl)));
  await assert.rejects(async () => (await repository.updateAccount(recycled.replacement.id, { sold: false })), /不能恢复未售/);
  await assert.rejects(async () => (await repository.createRebind(recycled.replacement.id, "fresh-child@icloud.com")), /已售且未停用/);
  assert.equal(((await db.prepare("SELECT sold, plan FROM gpt_accounts WHERE id=?").get(recycled.replacement.id)) as any).sold, 1);
  assert.deepEqual((await repository.applyBulkAction([recycled.replacement.id], "hidePromotion", true)), { updated: 1 });
  assert.equal(((await db.prepare("SELECT hide_promotion FROM gpt_accounts WHERE id=?").get(recycled.replacement.id)) as any).hide_promotion, 1);
  assert.equal((await repository.listAccounts({ limit: 100 })).results.find((item) => item.id === recycled.replacement.id)?.hidePromotion, true);
  assert.deepEqual((await repository.applyBulkAction([recycled.replacement.id], "groupBoundary", true)), { updated: 1 });
  assert.equal(((await db.prepare("SELECT group_boundary FROM gpt_accounts WHERE id=?").get(recycled.replacement.id)) as any).group_boundary, 1);
  (await repository.deactivateAccount(account.id, "second_attempt"));
  assert.equal(Number(((await db.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE account_id=? AND event_type='account_deactivated'").get(account.id)) as any).count), 1);

  const conflicting = (await repository.importAccounts([{
    email: "fresh-child@ai-mail.tech",
    accessToken: "wrong-at",
    openaiSubject: "openai-user-1",
  }]));
  assert.equal(conflicting.imported, 0);
  assert.equal(conflicting.errors.length, 1);
  assert.equal((await repository.revealCredentials(recycled.replacement.id))?.accessToken, "fresh-at");
  const quarantined = (await db.prepare("SELECT lifecycle_status, identity_status FROM gpt_accounts WHERE id=?").get(recycled.replacement.id)) as any;
  assert.deepEqual(quarantined, { lifecycle_status: "quarantined", identity_status: "conflict" });
  assert.equal(((await db.prepare("SELECT active FROM access_grants WHERE id=?").get(replacementGrant.grantId)) as any).active, 0);

  assert.deepEqual((await repository.applyBulkAction([account.id], "delete", true)), { updated: 1 });
  const deleted = (await db.prepare("SELECT lifecycle_status, deleted_at FROM gpt_accounts WHERE id=?").get(account.id)) as any;
  assert.equal(deleted.lifecycle_status, "deleted");
  assert.ok(deleted.deleted_at);
  assert.equal((await repository.listAccounts({ limit: 100 })).results.some((item) => item.id === account.id), false);
});
