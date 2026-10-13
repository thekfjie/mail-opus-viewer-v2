import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("migration and recycle preserve terminal business state", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opus-business-review-"));
  const snapshot = path.join(directory, "snapshot.json");
  fs.writeFileSync(snapshot, "[]");
  Object.assign(process.env, {
    ENV_FILE: "/dev/null", PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "test.sqlite"),
    V1_CONFIG_FILE: snapshot, V1_ENV_FILE: "", V1_BACKUPS_DIR: "", V1_MAIL_INDEX_FILE: "",
    V1_CHANGE_OUTBOX_FILE: "", V1_MAIL_FLAG_FILE: "", V1_USAGE_AUDIT_FILE: "",
    V2_READ_ONLY: "false", V2_ACCOUNT_AUTHORITY: "v2", V2_SESSION_SECRET: "offline-session",
    CREDENTIAL_ENCRYPTION_KEY: "offline-encryption",
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network forbidden"); };
  const [{ db }, repository, transitions, { syncFromV1 }, { emailHash }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/repository.js"),
    import("../src/server/account-transitions.js"), import("../src/server/legacy-import.js"),
    import("../src/server/association.js"),
  ]);
  t.after(async () => {
    (await db.close());
    globalThis.fetch = previousFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const account = async (email: string) => (await db.prepare(`SELECT a.*,b.id binding_id FROM gpt_accounts a
    JOIN email_bindings b ON b.account_id=a.id WHERE b.email_hash=?`).get(emailHash(email))) as any;
  const create = async (name: string) => {
    const email = `${name}@icloud.com`;
    assert.equal((await repository.importAccounts([{ email }])).errors.length, 0);
    return (await account(email));
  };

  await t.test("status-only migration never substitutes import, creation or retirement time for ban time", async () => {
    const record = { id: "unknown-ban", email: "unknown-ban@icloud.com", sold: true,
      lifecycleStatus: "deactivated", statusMessage: "OpenAI access deactivated",
      createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
      retiredAt: "2026-09-01T00:00:00.000Z" };
    fs.writeFileSync(snapshot, JSON.stringify([record]));
    (await syncFromV1());
    let current = (await account(record.email));
    assert.equal(current.deactivation_locked, 1);
    assert.equal(current.deactivated_at, "");
    assert.ok(current.updated_at);
    assert.equal(((await db.prepare("SELECT occurred_at FROM lifecycle_events WHERE account_id=? AND event_type='account_deactivated'").get(current.id)) as any).occurred_at, "");
    fs.writeFileSync(snapshot, JSON.stringify([{ ...record, lifecycleStatus: "active", statusMessage: "", retiredAt: "", updatedAt: "2026-09-08T00:00:00.000Z" }]));
    (await syncFromV1());
    current = (await account(record.email));
    assert.equal(current.deactivation_locked, 1);
    assert.equal(current.deactivated_at, "");
    assert.equal(current.lifecycle_status, "deactivated");
    assert.equal(((await db.prepare("SELECT status FROM sales WHERE account_id=?").get(current.id)) as any).status, "closed");
    assert.equal((await db.prepare("SELECT 1 FROM access_grants WHERE account_id=? AND active=1 AND scope='current'").get(current.id)), undefined);

    fs.writeFileSync(snapshot, JSON.stringify([{ ...record, deactivatedAt: "2026-08-30T12:00:00.123Z" }]));
    (await syncFromV1());
    assert.equal((await account(record.email)).deactivated_at, "2026-08-30T12:00:00.123Z");
    fs.writeFileSync(snapshot, JSON.stringify([{ ...record, deactivatedAt: "2026-08-29T12:00:00.123Z" }]));
    (await syncFromV1());
    assert.equal((await account(record.email)).deactivated_at, "2026-08-29T12:00:00.123Z");
    fs.writeFileSync(snapshot, "[]");
  });

  await t.test("explicit unknown time locks immediately without inventing an event timestamp", async () => {
    const unknown = (await create("explicit-unknown"));
    (await transitions.freezeAccountTransition(unknown.id, "upstream_notice", "offline-test", ""));
    let current = (await account("explicit-unknown@icloud.com"));
    assert.equal(current.deactivation_locked, 1);
    assert.equal(current.deactivated_at, "");
    assert.ok(current.updated_at);
    (await transitions.freezeAccountTransition(unknown.id, "duplicate", "offline-test", ""));
    assert.equal((await account("explicit-unknown@icloud.com")).deactivated_at, "");
    (await transitions.freezeAccountTransition(unknown.id, "metadata_confirmed", "offline-test", "2026-08-20T00:00:00.321Z"));
    current = (await account("explicit-unknown@icloud.com"));
    assert.equal(current.deactivated_at, "2026-08-20T00:00:00.321Z");
    const manual = (await create("manual-freeze"));
    (await transitions.freezeAccountTransition(manual.id));
    assert.ok(Date.parse((await account("manual-freeze@icloud.com")).deactivated_at));
  });

  await t.test("legacy routes retain all sender-recipient combinations and bounded compatibility fields", async () => {
    const record = { id: "route-migration", email: "route-migration@icloud.com", createdAt: "2026-08-01T00:00:00.000Z",
      sourceEmail: "sender@openai.com", toEmail: "route-migration@icloud.com", internalStatusMessage: "already_registered",
      fromPatterns: ["^first@openai\\.com$", "^second@openai\\.com$"],
      toPatterns: ["^route-migration@icloud\\.com$", "^alternate@icloud\\.com$"],
      raw: "BODY_MUST_NOT_PERSIST", html: "<div>BODY_MUST_NOT_PERSIST</div>" };
    fs.writeFileSync(snapshot, JSON.stringify([record]));
    (await syncFromV1());
    const owner = (await account(record.email));
    const binding = (await db.prepare("SELECT source_json FROM email_bindings WHERE id=?").get(owner.binding_id)) as any;
    assert.deepEqual(JSON.parse(binding.source_json).compatibility, {
      sourceEmail: record.sourceEmail, toEmail: record.toEmail, internalStatusMessage: record.internalStatusMessage,
    });
    assert.equal(binding.source_json.includes("BODY_MUST_NOT_PERSIST"), false);
    const rules = (await db.prepare("SELECT * FROM mail_routing_rules WHERE binding_id=?").all(owner.binding_id)) as any[];
    assert.equal(rules.length, 4);
    assert.ok(rules.some((rule) => new RegExp(rule.sender_pattern).test("first@openai.com") && new RegExp(rule.recipient_pattern).test("alternate@icloud.com")));
    (await syncFromV1());
    assert.equal(((await db.prepare("SELECT count(*) count FROM mail_routing_rules WHERE binding_id=?").get(owner.binding_id)) as any).count, 4);
    fs.writeFileSync(snapshot, "[]");
  });

  await t.test("V1 unlimited no-AT Free exception still increments recycle generation", async () => {
    const original = (await create("no-at-generation"));
    const now = new Date().toISOString();
    (await db.prepare("INSERT INTO account_origins(account_id,source_type,source_id,is_auto,first_seen_at) VALUES(?,'test','review',1,?)").run(original.id, now));
    (await db.prepare(`INSERT INTO account_business_evidence(account_id,mail_verified_no_plus,mail_verified_at,recycle_generation,updated_at)
      VALUES(?,1,?,2,?)`).run(original.id, now, now));
    (await db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,sender_pattern,recipient_pattern,source,created_at,updated_at)
      VALUES('recycle-source',?,'^sender@openai\\.com$','^no-at-generation@icloud\\.com$','test',?,?)`).run(original.binding_id, now, now));
    const result = (await repository.recycleAccountByMode(original.id, "untagged_free"));
    const evidence = (await db.prepare("SELECT recycle_generation FROM account_business_evidence WHERE account_id=?").get(result.replacement.id)) as any;
    assert.equal(evidence.recycle_generation, 3);
    assert.equal(result.previous.lifecycleStatus, "retired");
    const replacement = (await account(result.replacement.primaryEmail));
    const rules = (await db.prepare("SELECT * FROM mail_routing_rules WHERE binding_id=?").all(replacement.binding_id)) as any[];
    assert.equal(rules.length, 2);
    assert.ok(rules.every((rule) => new RegExp(rule.sender_pattern).test("sender@openai.com")));
    assert.ok(rules.some((rule) => new RegExp(rule.recipient_pattern).test("no-at-generation@icloud.com")));
    assert.ok(rules.some((rule) => new RegExp(rule.recipient_pattern).test(result.replacement.primaryEmail)));
    assert.equal(((await db.prepare("SELECT valid_to FROM mail_routing_rules WHERE id='recycle-source'").get()) as any).valid_to, rules[0].valid_from);
  });

  await t.test("stale migration cannot reactivate a recycled identity, binding or routing window", async () => {
    const record = { id: "retired-migration", email: "retired-migration@icloud.com", createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z", sold: true };
    fs.writeFileSync(snapshot, JSON.stringify([record]));
    (await syncFromV1());
    const previous = (await account(record.email));
    (await transitions.freezeAccountTransition(previous.id, "test", "test", "2026-08-20T00:00:00.000Z"));
    (await repository.recycleAccountByMode(previous.id, "deactivated"));
    const before = (await db.prepare("SELECT valid_to FROM email_bindings WHERE id=?").get(previous.binding_id)) as any;
    (await syncFromV1());
    const after = (await db.prepare("SELECT is_current,valid_to FROM email_bindings WHERE id=?").get(previous.binding_id)) as any;
    assert.equal(after.is_current, 0);
    assert.equal(after.valid_to, before.valid_to);
    assert.equal(((await db.prepare("SELECT valid_to FROM mail_routing_rules WHERE binding_id=?").get(previous.binding_id)) as any).valid_to, before.valid_to);
    assert.equal((await account(record.email)).deactivation_locked, 1);
    assert.equal((await db.prepare("SELECT 1 FROM access_grants WHERE account_id=? AND active=1 AND scope='current'").get(previous.id)), undefined);
    fs.writeFileSync(snapshot, "[]");
  });

  await t.test("recycle bookkeeping failure rolls back both old and replacement identities", async () => {
    const original = (await create("atomic-alias"));
    const now = new Date().toISOString();
    (await db.prepare("UPDATE gpt_accounts SET note='automyai OpenAI signup pool pending' WHERE id=?").run(original.id));
    (await db.prepare("INSERT INTO account_origins(account_id,source_type,source_id,is_auto,first_seen_at) VALUES(?,'test','review',1,?)").run(original.id, now));
    const before = ((await db.prepare("SELECT count(*) count FROM gpt_accounts").get()) as any).count;
    (await db.exec(db.dialect === "mysql" ? `CREATE TRIGGER reject_recycle_bookkeeping BEFORE INSERT ON account_origins FOR EACH ROW BEGIN IF NEW.source_type='recycle' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='offline injected failure'; END IF; END` : `CREATE TEMP TRIGGER reject_recycle_bookkeeping BEFORE INSERT ON account_origins
      WHEN NEW.source_type='recycle' BEGIN SELECT RAISE(ABORT,'offline injected failure'); END`));
    try {
      await assert.rejects(async () => (await repository.recycleAccountByMode(original.id, "alias_rotate")), /offline injected failure|ER_SIGNAL_EXCEPTION/);
      assert.equal(((await db.prepare("SELECT count(*) count FROM gpt_accounts").get()) as any).count, before);
      assert.equal((await account("atomic-alias@icloud.com")).lifecycle_status, "active");
      assert.equal(((await db.prepare("SELECT is_current FROM email_bindings WHERE id=?").get(original.binding_id)) as any).is_current, 1);
      assert.equal((await db.prepare("SELECT 1 FROM account_relations WHERE from_account_id=? AND relation_type='mailbox_recycle'").get(original.id)), undefined);
    } finally {
      (await db.exec("DROP TRIGGER reject_recycle_bookkeeping"));
    }
  });
});
