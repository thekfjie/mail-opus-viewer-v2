import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("API 与 Worker 的 SQLite 写入等待完整 V1 投影完成", () => {
  const configSource = fs.readFileSync(path.join(process.cwd(), "src/server/config.ts"), "utf8");
  const dbSource = fs.readFileSync(path.join(process.cwd(), "src/server/db.ts"), "utf8");
  assert.match(configSource, /V2_SQLITE_BUSY_TIMEOUT_MS\s*\|\|\s*30_000/);
  assert.match(dbSource, /busy_timeout = \$\{config\.sqliteBusyTimeoutMs\}/);
});

test("单账号凭证保存允许 V1 写入成功后后台投影，避免阻塞弹窗", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/server/v1-compat.ts"), "utf8");
  const server = fs.readFileSync(path.join(process.cwd(), "src/server/server.ts"), "utf8");
  assert.match(source, /proxyV1AndScheduleSync/);
  assert.match(source, /setTimeout\(\(\) =>/);
  assert.match(source, /syncPending: true/);
  assert.match(server, /proxyV1AndScheduleSync/);
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
  t.after(() => db.close());

  const imported = repository.importAccounts([{
    email: "locked+oai@icloud.com",
    accessToken: "at-secret",
    refreshToken: "rt-secret",
    openaiSubject: "openai-user-1",
    plan: "plus",
    note: "只保存正常备注",
  }]);
  assert.deepEqual(imported, { imported: 1, created: 1, rebound: 0, errors: [] });
  const account = db.prepare("SELECT a.* FROM gpt_accounts a JOIN email_bindings b ON b.account_id=a.id WHERE b.email_hash=?").get(
    association.emailHash("locked+oai@icloud.com"),
  ) as any;
  assert.ok(account);
  assert.equal(account.note, "只保存正常备注");
  assert.equal(account.note.includes("at-secret"), false);
  assert.deepEqual(repository.revealCredentials(account.id), {
    accessToken: "at-secret",
    refreshToken: "rt-secret",
    idToken: "",
    sessionToken: "",
    openaiPassword: "",
  });
  const manuallySaved = repository.saveAccountCredentials(account.id, {
    accessToken: "manual-at", refreshToken: "manual-rt", idToken: "", sessionToken: "", openaiPassword: "manual-password",
  });
  assert.equal(manuallySaved.hasAccessToken, true);
  assert.equal(repository.revealCredentials(account.id)?.accessToken, "manual-at");
  assert.equal(repository.revealCredentials(account.id)?.refreshToken, "manual-rt");
  assert.equal(repository.revealCredentials(account.id)?.openaiPassword, "manual-password");

  const oldBinding = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(account.id) as any;
  const grant = repository.createCustomerGrant(account.id, oldBinding.id, { password: "customer-password" });
  assert.ok(grant.publicUrl.startsWith("https://mail.example.test/#m="));
  assert.equal(grant.password, "customer-password");
  assert.ok(repository.grantByPublicToken(grant.publicToken));

  repository.deactivateAccount(account.id, "detected_bad");
  const rebound = repository.importAccounts([{
    email: "locked+oai@example.com",
    accessToken: "new-at",
    refreshToken: "new-rt",
    openaiSubject: "openai-user-1",
    plan: "plus",
  }]);
  assert.deepEqual(rebound, { imported: 1, created: 0, rebound: 1, errors: [] });
  const afterRebind = db.prepare("SELECT lifecycle_status, deactivation_locked, deactivated_at FROM gpt_accounts WHERE id=?").get(account.id) as any;
  assert.equal(afterRebind.lifecycle_status, "deactivated");
  assert.equal(afterRebind.deactivation_locked, 1);
  assert.ok(afterRebind.deactivated_at);
  const oldGrant = db.prepare("SELECT scope, visible_to, active FROM access_grants WHERE id=?").get(grant.grantId) as any;
  assert.equal(oldGrant.scope, "historical");
  assert.ok(oldGrant.visible_to);
  assert.equal(oldGrant.active, 1);
  const newBinding = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(account.id) as any;
  const inherited = db.prepare("SELECT scope, active FROM access_grants WHERE binding_id=?").all(newBinding.id) as any[];
  assert.ok(inherited.length >= 1);
  assert.ok(inherited.every((item) => item.scope === "admin_only" && item.active === 0));
  assert.equal((db.prepare("SELECT count(*) count FROM credential_versions WHERE account_id=?").get(account.id) as any).count, 3);
  assert.deepEqual(repository.revealCredentials(account.id), {
    accessToken: "new-at",
    refreshToken: "new-rt",
    idToken: "",
    sessionToken: "",
    openaiPassword: "",
  });
  assert.equal((db.prepare(`SELECT count(*) count FROM credential_versions
    WHERE account_id=? AND retired_reason='superseded'`).get(account.id) as any).count, 2);
  assert.equal(repository.getCurrentCustomerExport(account.id)?.available, false);
  assert.throws(() => repository.createCustomerGrant(account.id, newBinding.id, { password: "new-customer-password" }), /不能出售/);

  const recycled = repository.recycleAccount(account.id, "fresh-child@example.net", "free");
  assert.equal(recycled.previous.lifecycleStatus, "deactivated");
  assert.equal(recycled.previous.deactivationLocked, true);
  assert.equal(recycled.replacement.lifecycleStatus, "active");
  assert.equal(recycled.replacement.deactivationLocked, false);
  const oldRow = db.prepare("SELECT retired_at, deleted_at FROM gpt_accounts WHERE id=?").get(account.id) as any;
  assert.ok(oldRow.retired_at);
  assert.equal(oldRow.deleted_at, "");
  assert.equal(db.prepare("SELECT 1 FROM credentials WHERE account_id=?").get(recycled.replacement.id), undefined);
  const replacementGrants = db.prepare("SELECT scope, active FROM access_grants WHERE account_id=?").all(recycled.replacement.id) as any[];
  assert.ok(replacementGrants.length >= 1);
  assert.ok(replacementGrants.every((item) => item.scope === "admin_only" && item.active === 0));
  assert.equal(Number((db.prepare("SELECT COUNT(*) count FROM account_relations WHERE from_account_id=? AND to_account_id=? AND relation_type='mailbox_recycle'").get(
    account.id, recycled.replacement.id,
  ) as any).count), 1);

  const reboundReplacement = repository.createRebind(recycled.replacement.id, "fresh-child@example.com");
  assert.equal(reboundReplacement.id, recycled.replacement.id);
  assert.equal(reboundReplacement.bindingCount, 2);
  assert.equal(reboundReplacement.deactivationLocked, false);
  assert.equal(repository.revealCredentials(recycled.replacement.id), null);
  const credentialImport = repository.importAccounts([{
    email: "fresh-child@example.com",
    accessToken: "fresh-at",
    refreshToken: "fresh-rt",
    openaiSubject: "openai-user-2",
    plan: "plus",
  }]);
  assert.deepEqual(credentialImport, { imported: 1, created: 0, rebound: 0, errors: [] });
  assert.equal((db.prepare("SELECT count(*) count FROM credential_versions WHERE account_id=?").get(recycled.replacement.id) as any).count, 1);
  const currentVersion = db.prepare(`SELECT cv.token_fingerprint, cv.validity_status FROM account_current_credentials cc
    JOIN credential_versions cv ON cv.id=cc.credential_version_id WHERE cc.account_id=?`).get(recycled.replacement.id) as any;
  assert.ok(currentVersion.token_fingerprint);
  assert.equal(currentVersion.validity_status, "alive");
  const replacementBinding = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(recycled.replacement.id) as any;
  const replacementGrant = repository.createCustomerGrant(recycled.replacement.id, replacementBinding.id, { password: "replacement-customer-password" });
  assert.ok(repository.grantByPublicToken(replacementGrant.publicToken));
  const currentExport = repository.getCurrentCustomerExport(recycled.replacement.id);
  assert.equal(currentExport?.available, true);
  assert.equal(currentExport?.currentEmail, "fresh-child@example.com");
  assert.ok(currentExport?.publicUrl.startsWith("https://mail.example.test/#m="));
  assert.equal(currentExport?.text, `ai账号：fresh-child@example.com\n邮箱验证码：${currentExport?.publicUrl}`);
  assert.ok(currentExport?.text.endsWith(String(currentExport?.publicUrl)));
  assert.throws(() => repository.updateAccount(recycled.replacement.id, { sold: false }), /不能恢复未售/);
  assert.throws(() => repository.createRebind(recycled.replacement.id, "fresh-child@icloud.com"), /已售且未停用/);
  assert.equal((db.prepare("SELECT sold, plan FROM gpt_accounts WHERE id=?").get(recycled.replacement.id) as any).sold, 1);
  assert.deepEqual(repository.applyBulkAction([recycled.replacement.id], "hidePromotion", true), { updated: 1 });
  assert.equal((db.prepare("SELECT hide_promotion FROM gpt_accounts WHERE id=?").get(recycled.replacement.id) as any).hide_promotion, 1);
  assert.equal(repository.listAccounts({ limit: 100 }).results.find((item) => item.id === recycled.replacement.id)?.hidePromotion, true);
  assert.deepEqual(repository.applyBulkAction([recycled.replacement.id], "groupBoundary", true), { updated: 1 });
  assert.equal((db.prepare("SELECT group_boundary FROM gpt_accounts WHERE id=?").get(recycled.replacement.id) as any).group_boundary, 1);
  repository.deactivateAccount(account.id, "second_attempt");
  assert.equal(Number((db.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE account_id=? AND event_type='account_deactivated'").get(account.id) as any).count), 1);

  const conflicting = repository.importAccounts([{
    email: "fresh-child@example.com",
    accessToken: "wrong-at",
    openaiSubject: "openai-user-1",
  }]);
  assert.equal(conflicting.imported, 0);
  assert.equal(conflicting.errors.length, 1);
  assert.equal(repository.revealCredentials(recycled.replacement.id)?.accessToken, "fresh-at");
  const quarantined = db.prepare("SELECT lifecycle_status, identity_status FROM gpt_accounts WHERE id=?").get(recycled.replacement.id) as any;
  assert.deepEqual(quarantined, { lifecycle_status: "quarantined", identity_status: "conflict" });
  assert.equal((db.prepare("SELECT active FROM access_grants WHERE id=?").get(replacementGrant.grantId) as any).active, 0);

  assert.deepEqual(repository.applyBulkAction([account.id], "delete", true), { updated: 1 });
  const deleted = db.prepare("SELECT lifecycle_status, deleted_at FROM gpt_accounts WHERE id=?").get(account.id) as any;
  assert.equal(deleted.lifecycle_status, "deleted");
  assert.ok(deleted.deleted_at);
  assert.equal(repository.listAccounts({ limit: 100 }).results.some((item) => item.id === account.id), false);
});
