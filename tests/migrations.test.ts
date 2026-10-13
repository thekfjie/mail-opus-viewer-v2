import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteTestDatabase as Database } from "../src/server/storage/sqlite-test.js";
import { runMigrations } from "../src/server/migrations.js";
import { encryptSecret } from "../src/server/crypto.js";

test("V7-V26 migrations repair production anomalies idempotently", async () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-${process.pid}-${Date.now()}.sqlite`));
  database.pragma("foreign_keys = ON");
  (await database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES(6, '2026-01-01T00:00:00.000Z');
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE raw_import_records(source_hash TEXT NOT NULL, payload_json TEXT NOT NULL);
    INSERT INTO raw_import_records VALUES('stable-source-hash', '{"raw":"legacy-body-canary"}');
    CREATE TABLE gpt_accounts(
      id TEXT PRIMARY KEY, lifecycle_status TEXT NOT NULL, deleted_at TEXT NOT NULL DEFAULT '', source_status TEXT NOT NULL,
      identity_status TEXT NOT NULL DEFAULT 'unknown', retired_at TEXT NOT NULL DEFAULT '', quarantined_at TEXT NOT NULL DEFAULT '',
      quarantine_reason TEXT NOT NULL DEFAULT '', billing_channel_override TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, hide_promotion INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE mailbox_families(id TEXT PRIMARY KEY);
    CREATE TABLE email_bindings(
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES gpt_accounts(id), is_current INTEGER NOT NULL,
      valid_from TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', source_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE credentials(
      account_id TEXT PRIMARY KEY REFERENCES gpt_accounts(id), access_token_enc TEXT NOT NULL DEFAULT '', refresh_token_enc TEXT NOT NULL DEFAULT '',
      id_token_enc TEXT NOT NULL DEFAULT '', session_token_enc TEXT NOT NULL DEFAULT '', openai_password_enc TEXT NOT NULL DEFAULT '',
      openai_subject_hash TEXT NOT NULL DEFAULT '', access_token_fingerprint TEXT NOT NULL DEFAULT '', access_token_first_seen_at TEXT NOT NULL DEFAULT '',
      access_token_alive INTEGER NOT NULL DEFAULT 0, refresh_token_alive INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '', source_updated_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
    );
    CREATE TABLE account_relations(
      id TEXT PRIMARY KEY, relation_type TEXT NOT NULL, from_account_id TEXT NOT NULL REFERENCES gpt_accounts(id),
      to_account_id TEXT NOT NULL REFERENCES gpt_accounts(id), changed_at TEXT NOT NULL, association_method TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE TABLE payment_exposure_jobs(
      job_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES gpt_accounts(id), job_kind TEXT NOT NULL,
      scheduled_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE pending_reviews(
      id TEXT PRIMARY KEY, review_type TEXT NOT NULL, account_id TEXT REFERENCES gpt_accounts(id), candidate_email_hash TEXT NOT NULL,
      reason TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `));
  const now = "2026-09-02T00:00:00.000Z";
  const insertAccount = database.prepare(`INSERT INTO gpt_accounts(
    id, lifecycle_status, source_status, identity_status, created_at, updated_at
  ) VALUES(?, 'active', ?, ?, ?, ?)`);
  const insertBinding = database.prepare("INSERT INTO email_bindings(id, account_id, is_current, valid_from) VALUES(?, ?, ?, ?)");
  const insertRelation = database.prepare(`INSERT INTO account_relations(
    id, relation_type, from_account_id, to_account_id, changed_at, association_method, evidence_json, created_at
  ) VALUES(?, 'email_rebind', ?, ?, ?, 'legacy_rebind', ?, ?)`);
  (await database.transaction(async () => {
    for (let index = 0; index < 91; index += 1) {
      const accountId = `linked-${index}`;
      const from = `binding-old-${index}`;
      const to = `binding-new-${index}`;
      (await insertAccount.run(accountId, "current", "confirmed", now, now));
      (await insertBinding.run(from, accountId, 0, now));
      (await insertBinding.run(to, accountId, 1, now));
      (await insertRelation.run(`relation-${index}`, accountId, accountId, now, JSON.stringify({ previousBindingId: from, nextBindingId: to }), now));
    }
    for (let index = 0; index < 47; index += 1) {
      const accountId = `unbound-${index}`;
      const recovered = index < 20;
      (await insertAccount.run(accountId, recovered ? "recovered" : "current", recovered ? "unknown" : "confirmed", now, now));
      if (!recovered) (await database.prepare(`INSERT INTO credentials(account_id, openai_subject_hash, updated_at)
        VALUES(?, ?, ?)`).run(accountId, `subject-${index}`, now));
    }
  })());

  assert.deepEqual((await runMigrations(database)).map((item) => item.version), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 29]);
  assert.equal(((await database.prepare("SELECT remote_job_id FROM payment_exposure_jobs LIMIT 1").get()) as any)?.remote_job_id, undefined);
  assert.equal(((await database.prepare("SELECT openai_mfa_enabled FROM gpt_accounts LIMIT 1").get()) as any).openai_mfa_enabled, 0);
  assert.deepEqual((await database.prepare("SELECT * FROM raw_import_records").get()), { source_hash: "stable-source-hash", payload_json: "{}" });
  assert.equal(((await database.prepare("SELECT count(*) n FROM binding_transitions").get()) as any).n, 91);
  assert.equal(((await database.prepare("SELECT count(*) n FROM account_relations WHERE from_account_id=to_account_id").get()) as any).n, 0);
  assert.equal(((await database.prepare(`SELECT count(*) n FROM gpt_accounts a WHERE lifecycle_status='active'
    AND NOT EXISTS(SELECT 1 FROM email_bindings b WHERE b.account_id=a.id AND b.is_current=1)`).get()) as any).n, 0);
  assert.equal(((await database.prepare("SELECT count(*) n FROM gpt_accounts WHERE lifecycle_status='retired'").get()) as any).n, 20);
  assert.equal(((await database.prepare("SELECT count(*) n FROM gpt_accounts WHERE lifecycle_status='quarantined'").get()) as any).n, 27);
  assert.equal(((await database.prepare("SELECT count(*) n FROM pending_reviews WHERE review_type='active_identity_without_binding'").get()) as any).n, 27);

  assert.deepEqual((await runMigrations(database)), []);
  assert.equal(((await database.prepare("SELECT count(*) n FROM binding_transitions").get()) as any).n, 91);
  assert.equal(((await database.prepare("SELECT count(*) n FROM schema_meta WHERE version IN (7,8,9,10)").get()) as any).n, 4);
  assert.equal(database.pragma("foreign_key_check").length, 0);
  (await database.close());
});

test("V29 adds remote_job_id and maps legacy local jobs to their original remote id", async () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-v27-${process.pid}-${Date.now()}.sqlite`));
  (await database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES(26, '2026-09-15T00:00:00.000Z');
    CREATE TABLE payment_exposure_jobs(job_id TEXT PRIMARY KEY,status TEXT NOT NULL);
    INSERT INTO payment_exposure_jobs VALUES('legacy-local-job','completed');
  `));
  assert.deepEqual((await runMigrations(database)).map((item) => item.version), [29]);
  assert.deepEqual((await database.prepare("SELECT job_id,remote_job_id FROM payment_exposure_jobs").get()), {
    job_id: "legacy-local-job",
    remote_job_id: "legacy-local-job",
  });
  assert.deepEqual((await runMigrations(database)), []);
  (await database.close());
});

test("V21 repair ignores administrator sale events but preserves explicit administrator deactivation", async () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-v21-scope-${process.pid}-${Date.now()}.sqlite`));
  (await database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES(20, '2026-09-14T00:00:00.000Z');
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE gpt_accounts(
      id TEXT PRIMARY KEY,lifecycle_status TEXT NOT NULL,deactivation_locked INTEGER NOT NULL,deactivated_at TEXT NOT NULL,
      retired_at TEXT NOT NULL DEFAULT '',identity_status TEXT NOT NULL DEFAULT 'confirmed',note TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL
    );
    CREATE TABLE lifecycle_events(
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,binding_id TEXT,event_type TEXT NOT NULL,occurred_at TEXT NOT NULL,
      source TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL
    );
    INSERT INTO gpt_accounts(id,lifecycle_status,deactivation_locked,deactivated_at,updated_at) VALUES
      ('sold-before-mail','deactivated',1,'2026-09-13T01:00:00.000Z','2026-09-13T01:00:00.000Z'),
      ('manually-stopped','deactivated',1,'2026-09-13T02:00:00.000Z','2026-09-13T02:00:00.000Z');
    INSERT INTO lifecycle_events VALUES
      ('sold','sold-before-mail',NULL,'account_sold','2026-09-12T00:00:00.000Z','v2-admin','{}','2026-09-12T00:00:00.000Z'),
      ('sold-mail','sold-before-mail',NULL,'account_deactivated','2026-09-13T01:00:00.000Z','shared-mail-api-sync',
        '{"reason":"mail_deactivation_detected:sold"}','2026-09-13T01:00:00.000Z'),
      ('manual-mail','manually-stopped',NULL,'account_deactivated','2026-09-13T01:30:00.000Z','shared-mail-api-sync',
        '{"reason":"mail_deactivation_detected:manual"}','2026-09-13T01:30:00.000Z'),
      ('manual','manually-stopped',NULL,'account_deactivated','2026-09-13T02:00:00.000Z','v2-admin',
        '{"reason":"admin_manual"}','2026-09-13T02:00:00.000Z');
  `));
  assert.deepEqual((await runMigrations(database)).map((item) => item.version), [21, 22, 23, 24, 25, 26, 29]);
  assert.deepEqual((await database.prepare("SELECT lifecycle_status,deactivation_locked FROM gpt_accounts WHERE id='sold-before-mail'").get()),
    { lifecycle_status: "active", deactivation_locked: 0 });
  assert.deepEqual((await database.prepare("SELECT lifecycle_status,deactivation_locked FROM gpt_accounts WHERE id='manually-stopped'").get()),
    { lifecycle_status: "deactivated", deactivation_locked: 1 });
  assert.equal(((await database.prepare("SELECT COUNT(*) n FROM lifecycle_events WHERE event_type='automatic_deactivation_reverted'").get()) as any).n, 1);
  assert.deepEqual(JSON.parse(String(((await database.prepare("SELECT value FROM settings WHERE key='migration_v21_summary'").get()) as any).value)),
    { revertedAutomaticMailDeactivations: 1 });
  (await database.close());
});

test("V25 restores V23 bare-pool claims as shared batch mail", async () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-v23-pool-${process.pid}-${Date.now()}.sqlite`));
  (await database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES(22, '2026-09-14T00:00:00.000Z');
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE gpt_accounts(id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE email_bindings(
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,email_enc TEXT NOT NULL,valid_from TEXT NOT NULL DEFAULT '',
      valid_to TEXT NOT NULL DEFAULT '',receive_disabled_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE mail_messages(
      id TEXT PRIMARY KEY,provider TEXT NOT NULL,received_at TEXT NOT NULL,recipient_enc TEXT NOT NULL
    );
    CREATE TABLE mail_ownership_claims(
      message_id TEXT NOT NULL,account_id TEXT NOT NULL,binding_id TEXT NOT NULL,claim_type TEXT NOT NULL,
      visible_to_customer INTEGER NOT NULL,reason TEXT NOT NULL DEFAULT '',PRIMARY KEY(message_id,binding_id)
    );
    INSERT INTO gpt_accounts VALUES('child-a',''),('child-b',''),('child-c','');
  `));
  const insertBinding = database.prepare("INSERT INTO email_bindings(id,account_id,email_enc,valid_from) VALUES(?,?,?,'2026-09-01T00:00:00.000Z')");
  (await insertBinding.run("binding-a", "child-a", encryptSecret("pool+oaia@icloud.com")));
  (await insertBinding.run("binding-b", "child-b", encryptSecret("pool+oaib@icloud.com")));
  (await insertBinding.run("binding-c", "child-c", encryptSecret("pool+oaic@icloud.com")));
  const insertMessage = database.prepare("INSERT INTO mail_messages VALUES(?,'shared-mail-api','2026-09-10T00:00:00.000Z',?)");
  (await insertMessage.run("bare", encryptSecret("pool@icloud.com")));
  (await insertMessage.run("explicit", encryptSecret("pool+oaia@icloud.com")));
  const insertClaim = database.prepare("INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,visible_to_customer) VALUES(?,?,?,'routing_rule',1)");
  (await insertClaim.run("bare", "child-c", "binding-c"));
  (await insertClaim.run("explicit", "child-a", "binding-a"));
  assert.deepEqual((await runMigrations(database)).map((item) => item.version), [23, 24, 25, 26, 29]);
  assert.deepEqual((await database.prepare("SELECT message_id,visible_to_customer FROM mail_ownership_claims ORDER BY message_id").all()), [
    { message_id: "bare", visible_to_customer: 1 },
    { message_id: "explicit", visible_to_customer: 1 },
  ]);
  assert.deepEqual(JSON.parse(String(((await database.prepare("SELECT value FROM settings WHERE key='migration_v23_summary'").get()) as any).value)),
    { hiddenAmbiguousBaseMessages: 1, affectedPools: 1 });
  assert.deepEqual(JSON.parse(String(((await database.prepare("SELECT value FROM settings WHERE key='migration_v25_summary'").get()) as any).value)),
    { sharedBatchMessages: 1, restoredClaims: 1, affectedBatches: 1, v24AuditEvidenceRetained: true });
  (await database.close());
});

test("V24 rejects the reviewed wrong legacy claims and persists the zero-charge correction", async () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-v24-review-${process.pid}-${Date.now()}.sqlite`));
  (await database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES(23, '2026-09-14T00:00:00.000Z');
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE gpt_accounts(
      id TEXT PRIMARY KEY,plan TEXT NOT NULL,billing_channel TEXT NOT NULL,billing_channel_override TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE mail_messages(id TEXT PRIMARY KEY,provider TEXT NOT NULL,provider_message_id TEXT NOT NULL);
    CREATE TABLE mail_ownership_claims(
      message_id TEXT NOT NULL,account_id TEXT NOT NULL,binding_id TEXT NOT NULL,claim_type TEXT NOT NULL,
      visible_to_customer INTEGER NOT NULL,reason TEXT NOT NULL
    );
    CREATE TABLE lifecycle_events(
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,binding_id TEXT,event_type TEXT NOT NULL,occurred_at TEXT NOT NULL,
      source TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE account_business_evidence(account_id TEXT PRIMARY KEY,billing_started_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE billing_channel_observations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,active INTEGER NOT NULL);
    INSERT INTO gpt_accounts VALUES
      ('99f6a2b4-5f11-f621-83bb-cbace5f67266','plus','id-gopay','','old'),
      ('12c8c11b-ae4f-2638-a19b-5ad4c89d9c86','plus','id-gopay','','old');
    INSERT INTO mail_messages VALUES
      ('changed','shared-mail-api','5556'),('trial','shared-mail-api','5619');
    INSERT INTO mail_ownership_claims VALUES
      ('changed','99f6a2b4-5f11-f621-83bb-cbace5f67266','wrong-binding','legacy_mapping_index',1,'old'),
      ('changed','12c8c11b-ae4f-2638-a19b-5ad4c89d9c86','right-binding','legacy_mapping_index',1,'old'),
      ('trial','99f6a2b4-5f11-f621-83bb-cbace5f67266','wrong-binding','legacy_mapping_index',1,'old'),
      ('trial','12c8c11b-ae4f-2638-a19b-5ad4c89d9c86','right-binding','legacy_mapping_index',1,'old');
    INSERT INTO account_business_evidence VALUES('99f6a2b4-5f11-f621-83bb-cbace5f67266','2026-08-29T18:57:24.000Z','old');
    INSERT INTO billing_channel_observations VALUES('wrong-channel','99f6a2b4-5f11-f621-83bb-cbace5f67266',1);
  `));
  assert.deepEqual((await runMigrations(database)).map((item) => item.version), [24, 25, 26, 29]);
  assert.deepEqual((await database.prepare(`SELECT account_id,message_id,visible_to_customer,reason
    FROM mail_ownership_claims ORDER BY message_id,account_id`).all()), [
    { account_id: "12c8c11b-ae4f-2638-a19b-5ad4c89d9c86", message_id: "changed", visible_to_customer: 1, reason: "old" },
    { account_id: "99f6a2b4-5f11-f621-83bb-cbace5f67266", message_id: "changed", visible_to_customer: 0, reason: "reviewed_recipient_identity_mismatch" },
    { account_id: "12c8c11b-ae4f-2638-a19b-5ad4c89d9c86", message_id: "trial", visible_to_customer: 1, reason: "old" },
    { account_id: "99f6a2b4-5f11-f621-83bb-cbace5f67266", message_id: "trial", visible_to_customer: 0, reason: "reviewed_recipient_identity_mismatch" },
  ]);
  assert.deepEqual((await database.prepare(`SELECT plan,billing_channel,billing_channel_override FROM gpt_accounts
    WHERE id='99f6a2b4-5f11-f621-83bb-cbace5f67266'`).get()),
  { plan: "free", billing_channel: "", billing_channel_override: "" });
  assert.equal(((await database.prepare(`SELECT billing_started_at FROM account_business_evidence
    WHERE account_id='99f6a2b4-5f11-f621-83bb-cbace5f67266'`).get()) as any).billing_started_at, "");
  assert.equal(((await database.prepare("SELECT active FROM billing_channel_observations WHERE id='wrong-channel'").get()) as any).active, 0);
  assert.equal(((await database.prepare("SELECT COUNT(*) n FROM lifecycle_events WHERE event_type='mail_claim_rejected'").get()) as any).n, 2);
  assert.equal(((await database.prepare("SELECT COUNT(*) n FROM lifecycle_events WHERE event_type='plus_trial_only_corrected'").get()) as any).n, 1);
  assert.deepEqual(JSON.parse(String(((await database.prepare("SELECT value FROM settings WHERE key='migration_v24_summary'").get()) as any).value)),
    { rejectedClaims: 2, correctedAccounts: 1 });
  (await database.close());
});

test("V9 restores promotion-invalid credential state without rebuilding data", async () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-v9-${process.pid}-${Date.now()}.sqlite`));
  (await database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES(8, '2026-09-02T00:00:00.000Z');
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE credential_versions(id TEXT PRIMARY KEY, validity_status TEXT NOT NULL, validity_checked_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
    CREATE TABLE account_current_credentials(account_id TEXT PRIMARY KEY, credential_version_id TEXT NOT NULL);
    CREATE TABLE credentials(account_id TEXT PRIMARY KEY, access_token_alive INTEGER NOT NULL, refresh_token_alive INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE promotion_jobs(id TEXT PRIMARY KEY, credential_version_id TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO credential_versions VALUES('version-invalid', 'alive', '', '2026-09-02T00:00:00.000Z');
    INSERT INTO account_current_credentials VALUES('account-invalid', 'version-invalid');
    INSERT INTO credentials VALUES('account-invalid', 1, 1, '2026-09-02T00:00:00.000Z');
    INSERT INTO promotion_jobs VALUES('job-invalid', 'version-invalid', 'credential_invalid', '2026-09-02T01:00:00.000Z');
  `));
  assert.deepEqual((await runMigrations(database)).map((item) => item.version), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 29]);
  assert.deepEqual((await database.prepare("SELECT validity_status FROM credential_versions").get()), { validity_status: "invalid" });
  assert.deepEqual((await database.prepare("SELECT access_token_alive, refresh_token_alive FROM credentials").get()), { access_token_alive: 0, refresh_token_alive: 0 });
  assert.deepEqual((await runMigrations(database)), []);
  (await database.close());
});

test("V18 replaces only compatibility rules generated from customer sourceEmail", async () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-v18-${process.pid}-${Date.now()}.sqlite`));
  (await database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES(17, '2026-09-13T00:00:00.000Z');
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE email_bindings(id TEXT PRIMARY KEY, provider TEXT NOT NULL, source_json TEXT NOT NULL);
    CREATE TABLE mail_routing_rules(
      id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, sender_pattern TEXT NOT NULL,
      source TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `));
  const insertBinding = database.prepare("INSERT INTO email_bindings VALUES(?,?,?)");
  const insertRule = database.prepare("INSERT INTO mail_routing_rules VALUES(?,?,?,?,?)");
  (await insertBinding.run("customer", "icloud", JSON.stringify({ compatibility: { sourceEmail: "base.user@icloud.com" } })));
  (await insertRule.run("customer-rule", "customer", "(^|<|\\b)base\\.user@icloud\\.com(>|\\b|$)", "v2-compatibility", "old"));
  (await insertBinding.run("relay", "icloud", JSON.stringify({ compatibility: { sourceEmail: "noreply_at_tm_openai_com_route_ab12@icloud.com" } })));
  (await insertRule.run("relay-rule", "relay", "(^|<|\\b)[a-z]+_at_tm[a-z0-9]*_openai_com_route_[a-z0-9]+@icloud\\.com(>|\\b|$)", "v2-compatibility", "old"));
  (await insertBinding.run("custom", "icloud", JSON.stringify({ compatibility: { sourceEmail: "custom.user@icloud.com" } })));
  (await insertRule.run("custom-rule", "custom", "trusted-custom-sender", "v2-compatibility", "old"));

  assert.deepEqual((await runMigrations(database)).map((item) => item.version), [18, 19, 20, 21, 22, 23, 24, 25, 26, 29]);
  const rules = (await database.prepare("SELECT id,sender_pattern FROM mail_routing_rules ORDER BY id").all()) as any[];
  assert.match(rules.find((row) => row.id === "customer-rule").sender_pattern, /openai_com/);
  assert.match(rules.find((row) => row.id === "relay-rule").sender_pattern, /openai_com_route/);
  assert.equal(rules.find((row) => row.id === "custom-rule").sender_pattern, "trusted-custom-sender");
  assert.deepEqual(JSON.parse(((await database.prepare("SELECT value FROM settings WHERE key='migration_v18_summary'").get()) as any).value), {
    repairedCompatibilitySenderRules: 1,
  });
  assert.deepEqual((await runMigrations(database)), []);
  (await database.close());
});

test("V14 repairs historical plan-order messages classified as general", async () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-v14-${process.pid}-${Date.now()}.sqlite`));
  (await database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES(13, '2026-09-08T18:16:45.308Z');
    CREATE TABLE mail_messages(id TEXT PRIMARY KEY, subject TEXT NOT NULL, category TEXT NOT NULL);
    INSERT INTO mail_messages VALUES('plan-jp', 'ChatGPT - 新しいプラン', 'general');
    INSERT INTO mail_messages VALUES('security', 'Your temporary ChatGPT login code', 'security');
  `));
  assert.deepEqual((await runMigrations(database)).map((item) => item.version), [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 29]);
  assert.deepEqual((await database.prepare("SELECT id,category FROM mail_messages ORDER BY id").all()), [
    { id: "plan-jp", category: "billing" },
    { id: "security", category: "security" },
  ]);
  (await database.close());
});

test("V26 repairs localized plan-order messages already stored before the rule", async () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-v26-plan-${process.pid}-${Date.now()}.sqlite`));
  (await database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES(25, '2026-09-14T00:00:00.000Z');
    CREATE TABLE mail_messages(id TEXT PRIMARY KEY, subject TEXT NOT NULL, category TEXT NOT NULL);
    INSERT INTO mail_messages VALUES('momo-trial', 'ChatGPT - Kế hoạch mới của bạn', 'general');
    INSERT INTO mail_messages VALUES('marketing', 'Try ChatGPT Plus free for one month', 'promotion');
  `));
  assert.deepEqual((await runMigrations(database)).map((item) => item.version), [26, 29]);
  assert.deepEqual((await database.prepare("SELECT id,category FROM mail_messages ORDER BY id").all()), [
    { id: "marketing", category: "promotion" },
    { id: "momo-trial", category: "billing" },
  ]);
  assert.deepEqual((await runMigrations(database)), []);
  (await database.close());
});

test("V15 restores only pure V1 per-mapping duplicates", async () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-v15-${process.pid}-${Date.now()}.sqlite`));
  (await database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES(14, '2026-09-12T00:00:00.000Z');
    CREATE TABLE mail_ownership_claims(
      message_id TEXT NOT NULL, account_id TEXT NOT NULL, binding_id TEXT NOT NULL,
      claim_type TEXT NOT NULL, visible_to_customer INTEGER NOT NULL
    );
    INSERT INTO mail_ownership_claims VALUES
      ('legacy-only','account-a','binding-a','legacy_mapping_index',0),
      ('legacy-only','account-b','binding-b','legacy_mapping_index',0),
      ('real-conflict','account-a','binding-a','legacy_mapping_index',0),
      ('real-conflict','account-b','binding-b','routing_rule',0);
  `));
  assert.deepEqual((await runMigrations(database)).map((item) => item.version), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 29]);
  assert.deepEqual((await database.prepare("SELECT message_id,account_id,visible_to_customer FROM mail_ownership_claims ORDER BY message_id,account_id").all()), [
    { message_id: "legacy-only", account_id: "account-a", visible_to_customer: 1 },
    { message_id: "legacy-only", account_id: "account-b", visible_to_customer: 1 },
    { message_id: "real-conflict", account_id: "account-a", visible_to_customer: 0 },
    { message_id: "real-conflict", account_id: "account-b", visible_to_customer: 0 },
  ]);
  assert.deepEqual((await runMigrations(database)), []);
  (await database.close());
});
