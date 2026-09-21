import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("metadata-only events verify upstream headers once for fresh and migrated mail indexes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-metadata-event-"));
  process.env.PROJECT_ROOT = directory;
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "fake-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "fake-encryption";
  const [{ db }, { ingestSharedMailEvent }, { encryptSecret, decryptSecret }, { stableId }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/mail-sync.js"), import("../src/server/crypto.js"), import("../src/server/association.js"),
  ]);
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const now = "2026-09-01T00:00:00.000Z";
  db.prepare(`INSERT INTO gpt_accounts(id,lifecycle_status,arrived_at,created_at,updated_at) VALUES('account','active',?,?,?)`).run(now, now, now);
  db.prepare(`INSERT INTO mailbox_families(id,provider,canonical_address_hash,created_at,updated_at) VALUES('family','domain','family',?,?)`).run(now, now);
  db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,
    valid_from,is_current,legacy_mapping_id,created_at,updated_at)
    VALUES('binding','account','family',?,'owner','owner','example.com','domain',?,1,'legacy',?,?)`)
    .run(encryptSecret("owner@example.com"), now, now, now);
  db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,recipient_pattern,valid_from,source,created_at,updated_at)
    VALUES('rule','binding','^owner@example\\.com$',?,'test',?,?)`).run(now, now, now);
  const marker = "METADATA-EVENT-BODY-DOES-NOT-PERSIST-728291";
  const raw = `From: OpenAI <noreply@openai.com>\r\nTo: forward@example.net\r\nDelivered-To: owner@example.com\r\nSubject: Your verification code\r\n\r\n123456 ${marker}`;
  const receivedAt = "2026-09-08T03:00:00.000Z";
  for (const id of [31, 32]) {
    if (id === 32) {
      db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,recipient_enc,subject,received_at,folder,category,is_security,metadata_json,indexed_at)
        VALUES(?,'shared-mail-api','32','legacy-sender@example.com',?,'Legacy indexed subject',?,'inbox','security',1,'{"source":"v1-mail-index"}',?)`)
        .run(stableId("mail-message", "shared-mail-api", "32"), encryptSecret("legacy-recipient@example.com"), now, now);
    }
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const reader = { byId: async (mailId: string) => {
      reads += 1;
      assert.equal(mailId, String(id));
      await barrier;
      return { id, raw, address: "forward@example.net", created_at: "2026-09-08 03:00:00" };
    } };
    const task = ingestSharedMailEvent({ id: String(id), from: "relay@example.net", to: "forward@example.net", subject: "Forwarded metadata" }, reader);
    while (!reads) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((db.prepare("SELECT status FROM mail_ingestion_state WHERE provider_message_id=?").get(String(id)) as any).status, "pending_time");
    if (id === 32) {
      const row = db.prepare("SELECT * FROM mail_messages WHERE provider_message_id='32'").get() as any;
      assert.equal(row.received_at, now);
      assert.equal(row.sender, "legacy-sender@example.com");
      assert.equal(row.subject, "Legacy indexed subject");
      assert.equal(decryptSecret(row.recipient_enc), "legacy-recipient@example.com");
    }
    release();
    assert.equal((await task).processingStatus, "processed");
    assert.equal(reads, 1);
    const row = db.prepare("SELECT * FROM mail_messages WHERE provider_message_id=?").get(String(id)) as any;
    assert.equal(row.sender, "noreply@openai.com");
    assert.equal(row.subject, "Your verification code");
    assert.equal(row.received_at, receivedAt);
    assert.equal((db.prepare("SELECT account_id FROM mail_ownership_claims WHERE message_id=?").get(row.id) as any).account_id, "account");
    await ingestSharedMailEvent({ id: String(id), from: "", to: "", subject: "" }, reader);
    assert.equal(reads, 1);
  }
  const migratedId = stableId("mail-message", "shared-mail-api", "33");
  db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,recipient_enc,subject,received_at,indexed_at)
    VALUES(?,'shared-mail-api','33','known@example.com',?,'Known subject',?,?)`)
    .run(migratedId, encryptSecret("owner@example.com"), now, now);
  let missingReads = 0;
  const pending = await ingestSharedMailEvent({ id: 33, from: "", to: "", subject: "" }, {
    byId: async () => { missingReads += 1; throw new Error(marker); },
  });
  assert.equal(pending.processingStatus, "pending_time");
  assert.equal(missingReads, 1);
  const retained = db.prepare("SELECT * FROM mail_messages WHERE id=?").get(migratedId) as any;
  assert.equal(retained.sender, "known@example.com");
  assert.equal(retained.subject, "Known subject");
  assert.equal(retained.received_at, now);
  assert.equal(decryptSecret(retained.recipient_enc), "owner@example.com");
  assert.equal(db.serialize().includes(Buffer.from(marker)), false);
  for (const file of fs.readdirSync(directory)) assert.equal(fs.readFileSync(path.join(directory, file)).includes(Buffer.from(marker)), false, file);
});
