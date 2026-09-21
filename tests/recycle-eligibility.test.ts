import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function jwt(email: string, subject: string, plan = "free"): string {
  return `x.${Buffer.from(JSON.stringify({ sub: subject, email,
    "https://api.openai.com/auth": { chatgpt_plan_type: plan } })).toString("base64url")}.offline-signature`;
}

test("recycle eligibility ports V1 evidence rules and remains read-only until explicit administration", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opus-recycle-eligibility-"));
  const snapshot = path.join(directory, "access-config.json");
  fs.writeFileSync(snapshot, "[]");
  Object.assign(process.env, { ENV_FILE: "/dev/null", PROJECT_ROOT: directory,
    DATABASE_PATH: path.join(directory, "test.sqlite"), V1_CONFIG_FILE: snapshot,
    V1_BACKUPS_DIR: "", V1_MAIL_INDEX_FILE: "", V1_MAIL_FLAG_FILE: "", V1_USAGE_AUDIT_FILE: "", V1_CHANGE_OUTBOX_FILE: "",
    V2_READ_ONLY: "false", V2_ACCOUNT_AUTHORITY: "v2", V2_SESSION_SECRET: "recycle-test-session",
    CREDENTIAL_ENCRYPTION_KEY: "recycle-test-encryption" });
  const originalFetch = globalThis.fetch;
  let networkRequests = 0;
  globalThis.fetch = async () => { networkRequests++; throw new Error("offline recycle test prohibits network"); };
  const [{ db }, repository, transitions, eligibility, { syncFromV1 }, { emailHash }, secrets] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/repository.js"), import("../src/server/account-transitions.js"),
    import("../src/server/recycle-eligibility.js"), import("../src/server/legacy-import.js"),
    import("../src/server/association.js"), import("../src/server/crypto.js"),
  ]);
  t.after(() => { db.close(); globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true }); });
  const now = Date.now();
  const sevenDays = 604800000;
  const create = (name: string, plan = "free", withToken = true, domain = "icloud.com") => {
    const email = `${name}@${domain}`;
    assert.equal(repository.importAccounts([{ email, plan,
      ...(withToken ? { accessToken: jwt(email, name, plan) } : {}) }]).imported, 1);
    const row = db.prepare(`SELECT a.id,b.id binding_id FROM gpt_accounts a JOIN email_bindings b ON b.account_id=a.id
      WHERE b.email_hash=? AND b.is_current=1`).get(emailHash(email)) as any;
    db.prepare("UPDATE email_bindings SET valid_from=? WHERE id=?").run(new Date(now - 30 * sevenDays).toISOString(), row.binding_id);
    return { ...row, email };
  };
  const info = (account: any, at = now) => eligibility.getRecycleEligibility(account.id, at)!;
  const evidence = (account: any, fields: { auto?: boolean; generation?: number; verified?: boolean; verifiedAt?: string; bindingId?: string } = {}) => {
    const at = new Date(now - 1_000).toISOString();
    if (fields.auto) db.prepare("INSERT OR IGNORE INTO account_origins(account_id,source_type,source_id,is_auto,first_seen_at) VALUES(?,'test','test',1,?)").run(account.id, at);
    db.prepare(`INSERT INTO account_business_evidence(account_id,recycle_generation,mail_verified_no_plus,mail_verified_at,audit_binding_id,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET recycle_generation=excluded.recycle_generation,
      mail_verified_no_plus=excluded.mail_verified_no_plus,mail_verified_at=excluded.mail_verified_at,audit_binding_id=excluded.audit_binding_id`)
      .run(account.id, fields.generation ?? 0, fields.verified ? 1 : 0, fields.verified ? fields.verifiedAt || at : "", fields.bindingId || account.binding_id, at);
  };

  await t.test("confirmed ban boundary is in milliseconds; old creation dates and unknown ban times grant no eligibility", () => {
    const account = create("ban-boundary", "plus");
    const banAt = now - sevenDays;
    transitions.freezeAccountTransition(account.id, "notice", "test", new Date(banAt).toISOString());
    assert.equal(info(account, now - 1).modes.deactivated.eligible, false);
    assert.equal(info(account).modes.deactivated.eligible, true);
    assert.equal(info(account, now + 1).modes.deactivated.eligible, true);
    assert.equal(info(account).modes.deactivated.eligibleAt, new Date(now).toISOString());
    assert.equal(info(account).waitMs, sevenDays);
    assert.throws(() => repository.recycleAccountByMode(account.id, "unknown-mode"), /回收模式无效/);
    assert.equal(info(account).account.retired, false);
    const unknown = create("unknown-ban");
    db.prepare("UPDATE gpt_accounts SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(unknown.id);
    transitions.freezeAccountTransition(unknown.id, "unknown-time", "test", "");
    assert.equal(info(unknown).modes.deactivated.eligible, false);
    assert.equal(info(unknown).modes.deactivated.eligibleAt, "");
    assert.match(info(unknown).modes.deactivated.reason, /确认.*时间/);
    const unbanned = create("old-unopened", "unknown", false);
    assert.equal(info(unbanned).account.customerOpened, false);
    assert.equal(info(unbanned).modes.deactivated.eligible, false);
    assert.equal(info(unbanned).modes.untagged_free.eligible, false);
  });

  await t.test("Free eligibility needs affirmative evidence; Plus, ambiguous tokens and customer use remain protected", () => {
    const free = create("token-free");
    assert.equal(info(free).modes.untagged_free.eligible, true);
    assert.equal(info(free).evidence.tokenPlan, "free");
    const unknown = create("token-unknown", "unknown");
    assert.equal(info(unknown).modes.untagged_free.eligible, false);
    const plus = create("token-plus", "plus");
    assert.equal(info(plus).modes.untagged_free.eligible, false);
    const contradictory = create("mixed-token-plans");
    db.prepare("UPDATE credential_versions SET id_token_enc=? WHERE account_id=?").run(
      secrets.encryptSecret(jwt(contradictory.email, "mixed-token-plans", "plus")), contradictory.id);
    assert.equal(info(contradictory).evidence.tokenPlan, "paid");
    assert.equal(info(contradictory).modes.untagged_free.eligible, false);
    const issued = repository.createCustomerGrant(free.id, free.binding_id, { password: "fake-customer-password" });
    assert.equal(info(free).account.customerOpened, false);
    assert.equal(info(free).modes.untagged_free.eligible, false);
    repository.grantByPublicToken(issued.publicToken);
    assert.equal(info(free).account.customerOpened, true);
    assert.equal(info(free).modes.untagged_free.eligible, false);
    transitions.freezeAccountTransition(free.id, "notice", "test", new Date(now - sevenDays).toISOString());
    const before = JSON.stringify(db.prepare("SELECT * FROM access_grants WHERE account_id=?").all(free.id));
    const totalChanges = (db.prepare("SELECT total_changes() n").get() as any).n;
    for (let i = 0; i < 5; i++) assert.equal(info(free).modes.deactivated.eligible, true);
    assert.equal((db.prepare("SELECT total_changes() n").get() as any).n, totalChanges);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM access_grants WHERE account_id=?").all(free.id)), before);
    assert.ok(repository.grantByPublicToken(issued.publicToken));
    assert.ok(Object.values(info(free).modes).every((mode) => mode.trigger === "admin_only"));
  });

  await t.test("V1 generation, no-AT Auto exception, invalid AT and signup rotation remain distinct modes", () => {
    const limit = create("generation-limit");
    evidence(limit, { generation: 2 });
    assert.equal(info(limit).modes.untagged_free.eligible, false);
    const noAT = create("no-at-auto", "free", false);
    evidence(noAT, { auto: true, generation: 5, verified: true });
    assert.equal(info(noAT).evidence.reusableNoATAutoICloud, true);
    assert.equal(info(noAT).modes.untagged_free.eligible, true);
    assert.equal(info(noAT).modes.invalid_at.eligible, false);
    const manualNoAT = create("no-at-manual", "free", false);
    evidence(manualNoAT, { generation: 2, verified: true });
    assert.equal(info(manualNoAT).modes.untagged_free.eligible, false);
    const invalid = create("invalid-at");
    assert.equal(info(invalid).modes.invalid_at.eligible, false);
    db.prepare("UPDATE credential_versions SET validity_status='invalid' WHERE account_id=?").run(invalid.id);
    assert.equal(info(invalid).modes.invalid_at.eligible, true);
    const pending = create("signup-pending", "free", false);
    evidence(pending, { auto: true, generation: 9 });
    db.prepare("UPDATE gpt_accounts SET note='automyai OpenAI signup pool pending' WHERE id=?").run(pending.id);
    assert.equal(info(pending).modes.alias_rotate.eligible, true);
    assert.equal(info(pending).modes.untagged_free.eligible, false);
    const rotated = repository.recycleAccountByMode(pending.id, "alias_rotate");
    assert.equal(eligibility.getRecycleEligibility(rotated.replacement.id)!.generation, 9);
    const staleActiveBan = create("banned-pending", "free", false);
    evidence(staleActiveBan, { auto: true });
    db.prepare("UPDATE gpt_accounts SET note='automyai OpenAI signup pool pending',deactivation_locked=1 WHERE id=?").run(staleActiveBan.id);
    assert.equal(info(staleActiveBan).modes.alias_rotate.eligible, false);
    const reused = repository.recycleAccountByMode(noAT.id, "untagged_free");
    assert.equal(eligibility.getRecycleEligibility(reused.replacement.id)!.generation, 6);
  });

  await t.test("stale mailbox evidence, tags, transports and changed admin state cannot pass a stale preview", () => {
    const stale = create("stale-mail-evidence", "free", false);
    evidence(stale, { verified: true, verifiedAt: new Date(now - 31 * sevenDays).toISOString() });
    assert.equal(info(stale).evidence.mailVerifiedNoPlus, false);
    assert.equal(info(stale).modes.untagged_free.eligible, false);
    evidence(stale, { verified: true, bindingId: "previous-mailbox-binding" });
    assert.equal(info(stale).modes.untagged_free.eligible, false);
    const tagged = create("tagged-after-preview");
    assert.equal(info(tagged).modes.untagged_free.eligible, true);
    db.prepare("UPDATE gpt_accounts SET mark_color='purple' WHERE id=?").run(tagged.id);
    assert.throws(() => repository.recycleAccountByMode(tagged.id, "untagged_free"), /标记/);
    const connection = create("direct-mailbox");
    db.prepare(`INSERT INTO mailbox_connections(id,binding_id,provider,secret_ref,status,created_at,updated_at)
      VALUES('offline-direct',?,'external','test','active',?,?)`).run(connection.binding_id, new Date(now).toISOString(), new Date(now).toISOString());
    assert.ok(Object.values(info(connection).modes).every((mode) => !mode.eligible));
    const domain = create("domain-fixed", "free", true, "ai-mail.tech");
    assert.ok(Object.values(info(domain).modes).every((mode) => !mode.eligible));
    const restored = create("restored-history-link");
    db.prepare(`INSERT INTO account_relations(id,relation_type,from_account_id,to_account_id,changed_at,association_method,created_at)
      VALUES('offline-restored-recycle','mailbox_recycle',?,?,'2026-08-14T00:00:00.000Z','legacy_recycle','2026-08-14T00:00:00.000Z')`)
      .run(restored.id, domain.id);
    assert.equal(info(restored).account.retired, false);
    assert.equal(info(restored).modes.untagged_free.eligible, true);
  });

  await t.test("explicit recycle is audited and stale restored V1 metadata cannot revive its old links or eligibility", () => {
    const legacy = { id: "restored-then-reclaimed", email: "restored-then-reclaimed@icloud.com", sold: false,
      passwordHash: secrets.hashPassword("fake-legacy-password"), passwordPlain: "fake-legacy-password",
      lifecycleStatus: "active", mailRestoredAt: "2026-08-31T00:00:00.000Z", mailNotBefore: "2026-08-31T00:00:00.000Z",
      restoredFromLifecycleStatus: "retired", restoredFromRetiredAt: "2026-08-14T00:00:00.000Z",
      recycledToId: "removed-legacy-target", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z" };
    fs.writeFileSync(snapshot, JSON.stringify([legacy]));
    syncFromV1();
    const row = db.prepare("SELECT account_id id FROM email_bindings WHERE legacy_mapping_id=?").get(legacy.id) as any;
    assert.ok(repository.grantByPublicToken(legacy.id));
    transitions.freezeAccountTransition(row.id, "notice", "test", new Date(now - sevenDays - 1_000).toISOString());
    assert.equal(info(row).modes.deactivated.eligible, true);
    const result = repository.recycleAccountByMode(row.id, "deactivated");
    const audit = JSON.parse((db.prepare("SELECT evidence_json FROM account_relations WHERE from_account_id=? AND to_account_id=?").get(row.id, result.replacement.id) as any).evidence_json);
    assert.equal(audit.eligibility.trigger, "admin_only");
    assert.equal(audit.eligibility.waitMs, sevenDays);
    assert.equal(audit.eligibility.account.deactivationLocked, true);
    assert.equal(JSON.stringify(audit).includes("fake-legacy-password"), false);
    syncFromV1();
    assert.equal(repository.grantByPublicToken(legacy.id), null);
    assert.equal(info(row).account.retired, true);
    assert.ok(Object.values(info(row).modes).every((mode) => !mode.eligible));
    assert.throws(() => repository.recycleAccountByMode(row.id, "deactivated"), /完成回收/);
    assert.equal(info(row).account.deactivationLocked, true);
  });
  assert.equal(networkRequests, 0);
});
