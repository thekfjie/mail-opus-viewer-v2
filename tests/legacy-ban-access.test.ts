import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("V1 customer links survive bans without reviving reclaimed access or expanding mailbox windows", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opus-legacy-ban-access-"));
  const snapshot = path.join(directory, "access-config.json");
  const backups = path.join(directory, "backups");
  fs.mkdirSync(backups);
  fs.writeFileSync(snapshot, "[]");
  Object.assign(process.env, { ENV_FILE: "/dev/null", PROJECT_ROOT: directory,
    DATABASE_PATH: path.join(directory, "test.sqlite"), V1_CONFIG_FILE: snapshot,
    V1_ENV_FILE: "", V1_BACKUPS_DIR: backups, V1_MAIL_INDEX_FILE: "", V1_CHANGE_OUTBOX_FILE: "",
    V1_MAIL_FLAG_FILE: "", V1_USAGE_AUDIT_FILE: "", V2_READ_ONLY: "false", V2_ACCOUNT_AUTHORITY: "v2",
    V2_SESSION_SECRET: "legacy-ban-test-session", CREDENTIAL_ENCRYPTION_KEY: "legacy-ban-test-encryption" });
  const originalFetch = globalThis.fetch;
  let networkRequests = 0;
  globalThis.fetch = async () => { networkRequests++; throw new Error("offline test prohibits network"); };
  const [{ db }, repository, transitions, { syncFromV1 }, { hashPassword }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/repository.js"), import("../src/server/account-transitions.js"),
    import("../src/server/legacy-import.js"), import("../src/server/crypto.js"),
  ]);
  t.after(() => { db.close(); globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true }); });
  const password = "fake-legacy-customer-password";
  const passwordHash = hashPassword(password);
  const record = (id: string, extra: Record<string, unknown> = {}) => ({ id, email: `${id}@icloud.com`, sold: false,
    passwordHash, passwordPlain: password, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", ...extra });
  const binding = (id: string) => db.prepare("SELECT * FROM email_bindings WHERE legacy_mapping_id=?").get(id) as any;
  const grant = (id: string) => db.prepare("SELECT * FROM access_grants WHERE binding_id=? AND legacy_public_token=1").get(binding(id).id) as any;
  const owner = (id: string) => db.prepare("SELECT * FROM gpt_accounts WHERE id=?").get(binding(id).account_id) as any;
  const sync = (records: unknown[]) => { fs.writeFileSync(snapshot, JSON.stringify(records)); syncFromV1(); };
  const index = (id: string, recordId: string, at: string) => {
    const target = binding(recordId);
    db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,subject,received_at,indexed_at)
      VALUES(?,'test',?,'Offline ownership fixture',?,?)`).run(id, id, at, at);
    db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,created_at)
      VALUES(?,?,?,'exact','offline fixture',?)`).run(id, target.account_id, target.id, at);
  };

  await t.test("unsold V1 password links remain valid with unknown or earlier confirmed ban dates", () => {
    const unknown = record("unsold-unknown-ban", { lifecycleStatus: "deactivated" });
    // V1 uses both passwordHash and password for the existing password hash.
    const dated = record("unsold-dated-ban", { passwordHash: "", password: passwordHash,
      lifecycleStatus: "deactivated", deactivatedAt: "2026-07-30T00:00:00.123Z" });
    sync([unknown, dated]);
    for (const item of [unknown, dated]) {
      assert.equal(owner(item.id).sold, 0);
      assert.equal(owner(item.id).deactivation_locked, 1);
      assert.deepEqual({ scope: grant(item.id).scope, active: grant(item.id).active,
        visibleTo: grant(item.id).visible_to, firstUsedAt: grant(item.id).first_used_at },
      { scope: "current", active: 1, visibleTo: "", firstUsedAt: "" });
      assert.ok(repository.grantByPublicToken(item.id));
      assert.ok(repository.authenticateCustomer(item.email, password));
    }
    assert.equal(owner(unknown.id).deactivated_at, "");
    assert.equal(owner(dated.id).deactivated_at, dated.deactivatedAt);
    index("unknown-after-ban", unknown.id, "2026-09-08T12:00:00.000Z");
    index("dated-after-ban", dated.id, "2026-09-08T12:00:00.000Z");
    const access = repository.grantByPublicToken(unknown.id)!;
    assert.deepEqual(repository.listCustomerMails(access, 0, 20).results.map((mail) => mail.id), ["unknown-after-ban"]);
    assert.equal(repository.customerMailDetail(access, "dated-after-ban"), null);
    const previous = [unknown, dated].map((item) => grant(item.id));
    sync([unknown, dated].map((item) => ({ ...item, lifecycleStatus: "active", deactivatedAt: "", statusMessage: "" })));
    for (const [i, item] of [unknown, dated].entries()) {
      assert.equal(owner(item.id).deactivation_locked, 1);
      assert.equal(grant(item.id).active, previous[i].active);
      assert.equal(grant(item.id).scope, previous[i].scope);
      assert.equal(grant(item.id).visible_to, previous[i].visible_to);
      assert.ok(repository.authenticateCustomer(item.email, password));
    }
    assert.equal(owner(dated.id).deactivated_at, dated.deactivatedAt);
  });

  await t.test("legacy retirement, recycle and recovered backups never regain customer access through a stale sync", () => {
    const retired = record("legacy-manual-retired", { lifecycleStatus: "deactivated", retiredAt: "2026-09-01T00:00:00.000Z" });
    const recycled = record("legacy-manual-recycled", { recycledToId: "replacement-not-in-snapshot" });
    const recovered = record("legacy-backup-recovered", { lifecycleStatus: "deactivated" });
    fs.writeFileSync(path.join(backups, "access-config-old.json"), JSON.stringify([recovered]));
    sync([retired, recycled]);
    for (const item of [retired, recycled, recovered]) {
      assert.equal(grant(item.id).active, 0);
      assert.equal(grant(item.id).scope, "admin_only");
      assert.equal(repository.grantByPublicToken(item.id), null);
      assert.equal(repository.authenticateCustomer(item.email, password), null);
    }
    for (const item of [retired, recycled]) assert.equal(grant(item.id).revoke_reason, "legacy_admin_reclaimed");
    sync([retired, recycled].map((item) => ({ ...item, lifecycleStatus: "active", retiredAt: "", recycledToId: "" })));
    for (const item of [retired, recycled, recovered]) {
      assert.equal(grant(item.id).active, 0);
      assert.equal(repository.grantByPublicToken(item.id), null);
      assert.equal(repository.authenticateCustomer(item.email, password), null);
    }
    fs.unlinkSync(path.join(backups, "access-config-old.json"));
  });

  await t.test("V2 administrator recycle and grant revocation remain terminal on legacy resync", () => {
    const reclaimed = record("v2-manual-reclaimed", { lifecycleStatus: "deactivated" });
    const revoked = record("v2-manual-revoked", { lifecycleStatus: "deactivated" });
    sync([reclaimed, revoked]);
    const replacement = transitions.recycleAccountTransition(owner(reclaimed.id).id, "v2-manual-reclaimed+fresh@icloud.com");
    transitions.revokeGrantTransition(owner(revoked.id).id, grant(revoked.id).id);
    sync([reclaimed, revoked]);
    for (const item of [reclaimed, revoked]) {
      assert.equal(grant(item.id).active, 0);
      assert.ok(grant(item.id).revoked_at);
      assert.equal(repository.grantByPublicToken(item.id), null);
      assert.equal(repository.authenticateCustomer(item.email, password), null);
    }
    assert.equal((db.prepare("SELECT COUNT(*) n FROM access_grants WHERE account_id=? AND active=1 AND scope!='admin_only'").get(replacement.replacementId) as any).n, 0);
  });

  await t.test("explicit V1 restoration overrides a stale recycle pointer only with prior retirement proof and no current replacement", () => {
    const restoration = { lifecycleStatus: "active", recycledToId: "removed-old-recycle-target",
      mailRestoredAt: "2026-08-31T00:00:00.000Z", mailNotBefore: "2026-08-31T00:00:00.000Z",
      restoredFromLifecycleStatus: "retired", restoredFromRetiredAt: "2026-08-14T00:00:00.000Z" };
    const restored = record("legacy-explicitly-restored", restoration);
    const missingProof = record("legacy-restore-missing-proof", { ...restoration, restoredFromRetiredAt: "" });
    const targetPresent = record("legacy-restore-target-present", { ...restoration, recycledToId: "current-recycle-target" });
    const currentTarget = record("current-recycle-target");
    const records = [restored, missingProof, targetPresent, currentTarget];
    sync(records);
    assert.deepEqual({ active: grant(restored.id).active, scope: grant(restored.id).scope,
      revokedAt: grant(restored.id).revoked_at, revokeReason: grant(restored.id).revoke_reason,
      visibleFrom: grant(restored.id).visible_from, visibleTo: grant(restored.id).visible_to },
    { active: 1, scope: "current", revokedAt: "", revokeReason: "", visibleFrom: restoration.mailRestoredAt, visibleTo: "" });
    assert.ok(repository.grantByPublicToken(restored.id));
    assert.ok(repository.authenticateCustomer(restored.email, password));
    for (const item of [missingProof, targetPresent]) {
      assert.equal(grant(item.id).active, 0);
      assert.equal(grant(item.id).revoke_reason, "legacy_admin_reclaimed");
      assert.equal(repository.grantByPublicToken(item.id), null);
      assert.equal(repository.authenticateCustomer(item.email, password), null);
    }
    transitions.freezeAccountTransition(owner(restored.id).id, "upstream_notice", "test", "2026-09-01T00:00:00.000Z");
    sync(records);
    assert.equal(owner(restored.id).deactivation_locked, 1);
    assert.equal(grant(restored.id).visible_from, restoration.mailRestoredAt);
    assert.equal(grant(restored.id).visible_to, "");
    assert.ok(repository.grantByPublicToken(restored.id));
  });

  await t.test("explicit historical rebind preserves its original boundary after earlier ban evidence and stale imports", () => {
    const cutoff = "2026-08-20T00:00:00.000Z";
    const old = record("legacy-window-old", { email: "legacy-window@icloud.com", rebindNextId: "legacy-window-new",
      rebindNextEmail: "legacy-window@ai-mail.tech", rebindChangedAt: cutoff, mailNotAfter: cutoff });
    const current = record("legacy-window-new", { email: "legacy-window@ai-mail.tech", domainMailbox: true, bindingVerified: true,
      rebindPreviousId: old.id, rebindPreviousEmail: old.email, rebindChangedAt: cutoff, mailNotBefore: cutoff,
      createdAt: cutoff, lifecycleStatus: "deactivated", deactivatedAt: "2026-08-10T00:00:00.000Z" });
    sync([old, current]);
    assert.equal(owner(old.id).id, owner(current.id).id);
    assert.equal(grant(old.id).scope, "historical");
    assert.equal(grant(old.id).visible_to, cutoff);
    assert.equal(grant(current.id).scope, "current");
    assert.equal(grant(current.id).visible_to, "");
    index("legacy-before-rebind", old.id, "2026-08-19T23:59:59.999Z");
    index("legacy-at-rebind", old.id, cutoff);
    index("legacy-new-binding", current.id, "2026-08-21T00:00:00.000Z");
    const access = repository.grantByPublicToken(old.id)!;
    assert.deepEqual(repository.listCustomerMails(access, 0, 20).results.map((mail) => mail.id), ["legacy-before-rebind"]);
    assert.equal(repository.customerMailDetail(access, "legacy-at-rebind"), null);
    assert.equal(repository.customerMailDetail(access, "legacy-new-binding"), null);
    const newAccess = repository.grantByPublicToken(current.id)!;
    assert.deepEqual(repository.listCustomerMails(newAccess, 0, 20).results.map((mail) => mail.id), ["legacy-new-binding"]);
    sync([old, { ...current, lifecycleStatus: "active", deactivatedAt: "" }]);
    assert.equal(grant(old.id).visible_to, cutoff);
    assert.equal(grant(old.id).active, 1);
    assert.equal(owner(current.id).deactivation_locked, 1);
    assert.equal(grant(current.id).visible_to, "");
    assert.equal(repository.customerMailDetail(repository.grantByPublicToken(old.id)!, "legacy-new-binding"), null);
  });
  assert.equal(networkRequests, 0);
});
