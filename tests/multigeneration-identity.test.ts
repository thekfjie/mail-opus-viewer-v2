import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("回收各代保持独立，未完成换绑目标不建账号映射", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-multigeneration-"));
  const configFile = path.join(directory, "access-config.json");
  const mailIndexFile = path.join(directory, "mail-index-cache.json");
  const backupsDirectory = path.join(directory, "backups");
  fs.mkdirSync(backupsDirectory, { recursive: true });

  const sourceEmail = "genes.folds-37+oai8hoaaw@icloud.com";
  const targetEmail = "genes.folds-37+oai8hoaaw@ai-mail.tech";
  const laterEmail = "genes.folds-37+oai0l5pop@icloud.com";
  fs.writeFileSync(configFile, JSON.stringify([{
    id: "generation-two",
    email: sourceEmail,
    toEmail: sourceEmail,
    sold: true,
    lifecycleStatus: "retired",
    retiredAt: "2026-08-14T07:11:02.623Z",
    mailNotBefore: "2026-08-09T10:09:12.144Z",
    mailNotAfter: "2026-08-14T07:11:02.623Z",
    recycledToId: "generation-three",
    recycledToEmail: laterEmail,
    rebindNextId: "generation-two-domain",
    rebindNextEmail: targetEmail,
    rebindChangedAt: "2026-08-21T19:28:20.000Z",
    createdAt: "2026-08-09T10:09:12.144Z",
    updatedAt: "2026-08-21T19:28:20.000Z",
  }, {
    id: "generation-three",
    email: laterEmail,
    toEmail: laterEmail,
    sold: false,
    recycledFromId: "generation-two",
    recycledFromEmail: sourceEmail,
    mailNotBefore: "2026-08-14T07:11:02.623Z",
    createdAt: "2026-08-14T07:11:02.623Z",
    updatedAt: "2026-08-28T18:31:14.448Z",
  }, {
    id: "generation-two-domain",
    email: targetEmail,
    toEmail: targetEmail,
    domainMailbox: true,
    sold: true,
    rebindPreviousId: "generation-two",
    rebindPreviousEmail: sourceEmail,
    rebindChangedAt: "2026-08-21T19:28:20.000Z",
    mailNotBefore: "2026-08-21T19:28:06.000Z",
    createdAt: "2026-08-22T09:01:58.672Z",
    updatedAt: "2026-08-22T09:01:58.672Z",
  }], null, 2));
  fs.writeFileSync(mailIndexFile, JSON.stringify({ version: 2, entries: {
    "generation-three": {
      configKey: "test",
      mails: [{
        id: 3720,
        from: "ChatGPT <noreply_at_tm_openai_com_example@icloud.com>",
        to: "Hide My Email <genes.folds-37@icloud.com>",
        subject: "Your ChatGPT email address was changed",
        created_at: "2026-08-21 19:28:20",
        created_at_utc: "2026-08-21T19:28:20.000Z",
        folder: "inbox",
      }],
    },
  } }, null, 2));

  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.V1_CONFIG_FILE = configFile;
  process.env.V1_BACKUPS_DIR = backupsDirectory;
  process.env.V1_MAIL_INDEX_FILE = mailIndexFile;
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "multigeneration-test-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "multigeneration-test-encryption";
  process.env.V2_READ_ONLY = "true";

  const [{ db }, { syncFromV1 }, { resolveAccountMatch }] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/legacy-import.js"),
    import("../src/server/account-transitions.js"),
  ]);
  t.after(() => db.close());

  syncFromV1();
  const sourceBinding = db.prepare("SELECT account_id, id FROM email_bindings WHERE legacy_mapping_id='generation-two'").get() as any;
  const targetBinding = db.prepare("SELECT account_id FROM email_bindings WHERE legacy_mapping_id='generation-two-domain'").get() as any;
  const laterBinding = db.prepare("SELECT account_id FROM email_bindings WHERE legacy_mapping_id='generation-three'").get() as any;
  assert.equal(targetBinding, undefined);
  assert.notEqual(sourceBinding.account_id, laterBinding.account_id);

  const reboundAccount = db.prepare("SELECT lifecycle_status, identity_status, quarantine_reason FROM gpt_accounts WHERE id=?").get(sourceBinding.account_id) as any;
  assert.deepEqual(reboundAccount, { lifecycle_status: "retired", identity_status: "unknown", quarantine_reason: "" });
  const relations = db.prepare("SELECT relation_type, from_account_id, to_account_id FROM account_relations ORDER BY relation_type").all() as any[];
  assert.ok(!relations.some((row) => row.relation_type === "email_rebind"));
  assert.ok(relations.some((row) => row.relation_type === "mailbox_recycle" && row.from_account_id === sourceBinding.account_id && row.to_account_id === laterBinding.account_id));

  const claim = db.prepare(`SELECT oc.account_id, b.legacy_mapping_id, oc.claim_type
    FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id
    JOIN email_bindings b ON b.id=oc.binding_id WHERE m.provider_message_id='3720'`).get() as any;
  assert.deepEqual(claim, {
    account_id: laterBinding.account_id,
    legacy_mapping_id: "generation-three",
    claim_type: "legacy_mapping_index",
  });

  db.prepare(`INSERT INTO openai_identity_observations(
    id, account_id, subject_hash, source, status, first_seen_at, last_seen_at, evidence_json
  ) VALUES('third-identity', ?, 'third-subject-hash', 'test', 'confirmed', ?, ?, '{}')`).run(
    laterBinding.account_id, "2026-08-28T18:31:14.448Z", "2026-08-28T18:31:14.448Z",
  );
  const observedOldMailbox = resolveAccountMatch("third-subject-hash", sourceEmail);
  assert.equal(observedOldMailbox.kind, "account");
  assert.equal(observedOldMailbox.accountId, laterBinding.account_id);
  assert.equal(observedOldMailbox.method, "recycled_mailbox_identity");
});
