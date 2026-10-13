import { asyncMap } from '../src/server/async-collections.js';
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
  t.after(async () => { (await db.close()); globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true }); });
  const password = "fake-legacy-customer-password";
  const passwordHash = hashPassword(password);
  const record = (id: string, extra: Record<string, unknown> = {}) => ({ id, email: `${id}@icloud.com`, sold: false,
    passwordHash, passwordPlain: password, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", ...extra });
  const binding = async (id: string) => (await db.prepare("SELECT * FROM email_bindings WHERE legacy_mapping_id=?").get(id)) as any;
  const grant = async (id: string) => (await db.prepare("SELECT * FROM access_grants WHERE binding_id=? AND legacy_public_token=1").get((await binding(id)).id)) as any;
  const owner = async (id: string) => (await db.prepare("SELECT * FROM gpt_accounts WHERE id=?").get((await binding(id)).account_id)) as any;
  const sync = async (records: unknown[]) => { fs.writeFileSync(snapshot, JSON.stringify(records)); (await syncFromV1()); };
  const index = async (id: string, recordId: string, at: string) => {
    const target = (await binding(recordId));
    (await db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,subject,received_at,indexed_at)
      VALUES(?,'test',?,'Offline ownership fixture',?,?)`).run(id, id, at, at));
    (await db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,created_at)
      VALUES(?,?,?,'exact','offline fixture',?)`).run(id, target.account_id, target.id, at));
  };

  await t.test("unsold V1 password links remain valid with unknown or earlier confirmed ban dates", async () => {
    const unknown = record("unsold-unknown-ban", { lifecycleStatus: "deactivated" });
    // V1 uses both passwordHash and password for the existing password hash.
    const dated = record("unsold-dated-ban", { passwordHash: "", password: passwordHash,
      lifecycleStatus: "deactivated", deactivatedAt: "2026-07-30T00:00:00.123Z" });
    (await sync([unknown, dated]));
    for (const item of [unknown, dated]) {
      assert.equal((await owner(item.id)).sold, 0);
      assert.equal((await owner(item.id)).deactivation_locked, 1);
      assert.deepEqual({ scope: (await grant(item.id)).scope, active: (await grant(item.id)).active,
        visibleTo: (await grant(item.id)).visible_to, firstUsedAt: (await grant(item.id)).first_used_at },
      { scope: "current", active: 1, visibleTo: "", firstUsedAt: "" });
      assert.ok((await repository.grantByPublicToken(item.id)));
      assert.ok((await repository.authenticateCustomer(item.email, password)));
    }
    assert.equal((await owner(unknown.id)).deactivated_at, "");
    assert.equal((await owner(dated.id)).deactivated_at, dated.deactivatedAt);
    (await index("unknown-after-ban", unknown.id, "2026-09-08T12:00:00.000Z"));
    (await index("dated-after-ban", dated.id, "2026-09-08T12:00:00.000Z"));
    const access = (await repository.grantByPublicToken(unknown.id))!;
    assert.deepEqual((await repository.listCustomerMails(access, 0, 20)).results.map((mail) => mail.id), ["unknown-after-ban"]);
    assert.equal((await repository.customerMailDetail(access, "dated-after-ban")), null);
    const previous = (await asyncMap([unknown, dated], async (item) => (await grant(item.id))));
    (await sync([unknown, dated].map((item) => ({ ...item, lifecycleStatus: "active", deactivatedAt: "", statusMessage: "" }))));
    for (const [i, item] of [unknown, dated].entries()) {
      assert.equal((await owner(item.id)).deactivation_locked, 1);
      assert.equal((await grant(item.id)).active, previous[i].active);
      assert.equal((await grant(item.id)).scope, previous[i].scope);
      assert.equal((await grant(item.id)).visible_to, previous[i].visible_to);
      assert.ok((await repository.authenticateCustomer(item.email, password)));
    }
    assert.equal((await owner(dated.id)).deactivated_at, dated.deactivatedAt);
  });

  await t.test("legacy retirement, recycle and recovered backups never regain customer access through a stale sync", async () => {
    const retired = record("legacy-manual-retired", { lifecycleStatus: "deactivated", retiredAt: "2026-09-01T00:00:00.000Z" });
    const recycled = record("legacy-manual-recycled", { recycledToId: "replacement-not-in-snapshot" });
    const recovered = record("legacy-backup-recovered", { lifecycleStatus: "deactivated" });
    fs.writeFileSync(path.join(backups, "access-config-old.json"), JSON.stringify([recovered]));
    (await sync([retired, recycled]));
    for (const item of [retired, recycled, recovered]) {
      assert.equal((await grant(item.id)).active, 0);
      assert.equal((await grant(item.id)).scope, "admin_only");
      assert.equal((await repository.grantByPublicToken(item.id)), null);
      assert.equal((await repository.authenticateCustomer(item.email, password)), null);
    }
    for (const item of [retired, recycled]) assert.equal((await grant(item.id)).revoke_reason, "legacy_admin_reclaimed");
    (await sync([retired, recycled].map((item) => ({ ...item, lifecycleStatus: "active", retiredAt: "", recycledToId: "" }))));
    for (const item of [retired, recycled, recovered]) {
      assert.equal((await grant(item.id)).active, 0);
      assert.equal((await repository.grantByPublicToken(item.id)), null);
      assert.equal((await repository.authenticateCustomer(item.email, password)), null);
    }
    fs.unlinkSync(path.join(backups, "access-config-old.json"));
  });

  await t.test("V2 administrator recycle and grant revocation remain terminal on legacy resync", async () => {
    const reclaimed = record("v2-manual-reclaimed", { lifecycleStatus: "deactivated" });
    const revoked = record("v2-manual-revoked", { lifecycleStatus: "deactivated" });
    (await sync([reclaimed, revoked]));
    const replacement = (await transitions.recycleAccountTransition((await owner(reclaimed.id)).id, "v2-manual-reclaimed+fresh@icloud.com"));
    (await transitions.revokeGrantTransition((await owner(revoked.id)).id, (await grant(revoked.id)).id));
    (await sync([reclaimed, revoked]));
    for (const item of [reclaimed, revoked]) {
      assert.equal((await grant(item.id)).active, 0);
      assert.ok((await grant(item.id)).revoked_at);
      assert.equal((await repository.grantByPublicToken(item.id)), null);
      assert.equal((await repository.authenticateCustomer(item.email, password)), null);
    }
    assert.equal(((await db.prepare("SELECT COUNT(*) n FROM access_grants WHERE account_id=? AND active=1 AND scope!='admin_only'").get(replacement.replacementId)) as any).n, 0);
  });

  await t.test("explicit V1 restoration overrides a stale recycle pointer only with prior retirement proof and no current replacement", async () => {
    const restoration = { lifecycleStatus: "active", recycledToId: "removed-old-recycle-target",
      mailRestoredAt: "2026-08-31T00:00:00.000Z", mailNotBefore: "2026-08-31T00:00:00.000Z",
      restoredFromLifecycleStatus: "retired", restoredFromRetiredAt: "2026-08-14T00:00:00.000Z" };
    const restored = record("legacy-explicitly-restored", restoration);
    const missingProof = record("legacy-restore-missing-proof", { ...restoration, restoredFromRetiredAt: "" });
    const targetPresent = record("legacy-restore-target-present", { ...restoration, recycledToId: "current-recycle-target" });
    const currentTarget = record("current-recycle-target");
    const records = [restored, missingProof, targetPresent, currentTarget];
    (await sync(records));
    assert.deepEqual({ active: (await grant(restored.id)).active, scope: (await grant(restored.id)).scope,
      revokedAt: (await grant(restored.id)).revoked_at, revokeReason: (await grant(restored.id)).revoke_reason,
      visibleFrom: (await grant(restored.id)).visible_from, visibleTo: (await grant(restored.id)).visible_to },
    { active: 1, scope: "current", revokedAt: "", revokeReason: "", visibleFrom: restoration.mailRestoredAt, visibleTo: "" });
    assert.ok((await repository.grantByPublicToken(restored.id)));
    assert.ok((await repository.authenticateCustomer(restored.email, password)));
    for (const item of [missingProof, targetPresent]) {
      assert.equal((await grant(item.id)).active, 0);
      assert.equal((await grant(item.id)).revoke_reason, "legacy_admin_reclaimed");
      assert.equal((await repository.grantByPublicToken(item.id)), null);
      assert.equal((await repository.authenticateCustomer(item.email, password)), null);
    }
    (await transitions.freezeAccountTransition((await owner(restored.id)).id, "upstream_notice", "test", "2026-09-01T00:00:00.000Z"));
    (await sync(records));
    assert.equal((await owner(restored.id)).deactivation_locked, 1);
    assert.equal((await grant(restored.id)).visible_from, restoration.mailRestoredAt);
    assert.equal((await grant(restored.id)).visible_to, "");
    assert.ok((await repository.grantByPublicToken(restored.id)));
  });

  await t.test("explicit historical rebind preserves its original boundary after earlier ban evidence and stale imports", async () => {
    const cutoff = "2026-08-20T00:00:00.000Z";
    const old = record("legacy-window-old", { email: "legacy-window@icloud.com", rebindNextId: "legacy-window-new",
      rebindNextEmail: "legacy-window@ai-mail.tech", rebindChangedAt: cutoff, mailNotAfter: cutoff });
    const current = record("legacy-window-new", { email: "legacy-window@ai-mail.tech", domainMailbox: true, bindingVerified: true,
      rebindPreviousId: old.id, rebindPreviousEmail: old.email, rebindChangedAt: cutoff, mailNotBefore: cutoff,
      createdAt: cutoff, lifecycleStatus: "deactivated", deactivatedAt: "2026-08-10T00:00:00.000Z" });
    (await sync([old, current]));
    assert.equal((await owner(old.id)).id, (await owner(current.id)).id);
    assert.equal((await grant(old.id)).scope, "historical");
    assert.equal((await grant(old.id)).visible_to, cutoff);
    assert.equal((await grant(current.id)).scope, "current");
    assert.equal((await grant(current.id)).visible_to, "");
    (await index("legacy-before-rebind", old.id, "2026-08-19T23:59:59.999Z"));
    (await index("legacy-at-rebind", old.id, cutoff));
    (await index("legacy-new-binding", current.id, "2026-08-21T00:00:00.000Z"));
    const access = (await repository.grantByPublicToken(old.id))!;
    assert.deepEqual((await repository.listCustomerMails(access, 0, 20)).results.map((mail) => mail.id), ["legacy-before-rebind"]);
    assert.equal((await repository.customerMailDetail(access, "legacy-at-rebind")), null);
    assert.equal((await repository.customerMailDetail(access, "legacy-new-binding")), null);
    const newAccess = (await repository.grantByPublicToken(current.id))!;
    assert.deepEqual((await repository.listCustomerMails(newAccess, 0, 20)).results.map((mail) => mail.id), ["legacy-new-binding"]);
    (await sync([old, { ...current, lifecycleStatus: "active", deactivatedAt: "" }]));
    assert.equal((await grant(old.id)).visible_to, cutoff);
    assert.equal((await grant(old.id)).active, 1);
    assert.equal((await owner(current.id)).deactivation_locked, 1);
    assert.equal((await grant(current.id)).visible_to, "");
    assert.equal((await repository.customerMailDetail((await repository.grantByPublicToken(old.id))!, "legacy-new-binding")), null);
  });
  assert.equal(networkRequests, 0);
});
