import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrations } from "../src/server/migrations.js";

test("V7-V10 migrations repair production anomalies idempotently", () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-${process.pid}-${Date.now()}.sqlite`));
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_meta VALUES(6, '2026-01-01T00:00:00.000Z');
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
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
  `);
  const now = "2026-09-02T00:00:00.000Z";
  const insertAccount = database.prepare(`INSERT INTO gpt_accounts(
    id, lifecycle_status, source_status, identity_status, created_at, updated_at
  ) VALUES(?, 'active', ?, ?, ?, ?)`);
  const insertBinding = database.prepare("INSERT INTO email_bindings(id, account_id, is_current, valid_from) VALUES(?, ?, ?, ?)");
  const insertRelation = database.prepare(`INSERT INTO account_relations(
    id, relation_type, from_account_id, to_account_id, changed_at, association_method, evidence_json, created_at
  ) VALUES(?, 'email_rebind', ?, ?, ?, 'legacy_rebind', ?, ?)`);
  database.transaction(() => {
    for (let index = 0; index < 91; index += 1) {
      const accountId = `linked-${index}`;
      const from = `binding-old-${index}`;
      const to = `binding-new-${index}`;
      insertAccount.run(accountId, "current", "confirmed", now, now);
      insertBinding.run(from, accountId, 0, now);
      insertBinding.run(to, accountId, 1, now);
      insertRelation.run(`relation-${index}`, accountId, accountId, now, JSON.stringify({ previousBindingId: from, nextBindingId: to }), now);
    }
    for (let index = 0; index < 47; index += 1) {
      const accountId = `unbound-${index}`;
      const recovered = index < 20;
      insertAccount.run(accountId, recovered ? "recovered" : "current", recovered ? "unknown" : "confirmed", now, now);
      if (!recovered) database.prepare(`INSERT INTO credentials(account_id, openai_subject_hash, updated_at)
        VALUES(?, ?, ?)`).run(accountId, `subject-${index}`, now);
    }
  })();

  assert.deepEqual(runMigrations(database).map((item) => item.version), [7, 8, 9, 10]);
  assert.equal((database.prepare("SELECT count(*) n FROM binding_transitions").get() as any).n, 91);
  assert.equal((database.prepare("SELECT count(*) n FROM account_relations WHERE from_account_id=to_account_id").get() as any).n, 0);
  assert.equal((database.prepare(`SELECT count(*) n FROM gpt_accounts a WHERE lifecycle_status='active'
    AND NOT EXISTS(SELECT 1 FROM email_bindings b WHERE b.account_id=a.id AND b.is_current=1)`).get() as any).n, 0);
  assert.equal((database.prepare("SELECT count(*) n FROM gpt_accounts WHERE lifecycle_status='retired'").get() as any).n, 20);
  assert.equal((database.prepare("SELECT count(*) n FROM gpt_accounts WHERE lifecycle_status='quarantined'").get() as any).n, 27);
  assert.equal((database.prepare("SELECT count(*) n FROM pending_reviews WHERE review_type='active_identity_without_binding'").get() as any).n, 27);

  assert.deepEqual(runMigrations(database), []);
  assert.equal((database.prepare("SELECT count(*) n FROM binding_transitions").get() as any).n, 91);
  assert.equal((database.prepare("SELECT count(*) n FROM schema_meta WHERE version IN (7,8,9,10)").get() as any).n, 4);
  assert.equal(database.pragma("foreign_key_check").length, 0);
  database.close();
});

test("V9 restores promotion-invalid credential state without rebuilding data", () => {
  const database = new Database(path.join(os.tmpdir(), `mail-opus-migration-v9-${process.pid}-${Date.now()}.sqlite`));
  database.exec(`
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
  `);
  assert.deepEqual(runMigrations(database).map((item) => item.version), [9, 10]);
  assert.deepEqual(database.prepare("SELECT validity_status FROM credential_versions").get(), { validity_status: "invalid" });
  assert.deepEqual(database.prepare("SELECT access_token_alive, refresh_token_alive FROM credentials").get(), { access_token_alive: 0, refresh_token_alive: 0 });
  assert.deepEqual(runMigrations(database), []);
  database.close();
});
