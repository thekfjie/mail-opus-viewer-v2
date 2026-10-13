import { databaseSnapshot } from "./helpers/database-snapshot.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteTestDatabase as Database } from "../src/server/storage/sqlite-test.js";
import { applyMailIngestionSchema, D1MailReader, MAIL_READ_LIMITS } from "../src/server/cf-mail.js";

test("expired D1 process reservations recover without dropping requests or unknown costs", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-mail-read-recovery-"));
  const filename = path.join(directory, "test.sqlite");
  const now = Date.now();
  let db = new Database(filename);
  (await applyMailIngestionSchema(db));
  (await db.prepare("INSERT INTO mail_read_requests(id,started_at) VALUES('interrupted',?)").run(now - 30_000));
  (await db.prepare("UPDATE mail_read_control SET owner='interrupted',lease_until=? WHERE id=1").run(now - 1));
  (await db.close());
  db = new Database(filename);
  try {
    let calls = 0;
    const reader = new D1MailReader(db, { accountId: "fake", databaseId: "fake", readToken: "fake",
      now: () => now, transport: async () => {
        calls += 1;
        return new Response(JSON.stringify({ success: true, result: [{ success: true, results: [], meta: { rows_read: 1 } }] }));
      } });
    await reader.byId("1");
    assert.equal(calls, 1);
    assert.deepEqual((await db.prepare("SELECT outcome,rows_read FROM mail_read_requests WHERE id='interrupted'").get()),
      { outcome: "mail_d1_interrupted", rows_read: MAIL_READ_LIMITS.maxRowsRead });
    assert.equal(((await db.prepare("SELECT COUNT(*) n FROM mail_read_requests").get()) as any).n, 2);
    assert.equal(((await db.prepare("SELECT owner FROM mail_read_control").get()) as any).owner, "");
  } finally {
    (await db.close());
    fs.rmSync(directory, { recursive: true });
  }
});

test("mail events share atomic retry leases, preserve cooldown and keep only index data", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-mail-event-recovery-"));
  process.env.PROJECT_ROOT = directory;
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "fake-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "fake-encryption";
  process.env.OUTLOOK_MANAGER_PASSWORD = "fake-outlook-password";
  const [{ db }, { ingestSharedMailEvent, retrySharedMailEvent }, { MailReadError }, { accountVerificationCode }, { encryptSecret }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/mail-sync.js"), import("../src/server/cf-mail.js"),
    import("../src/server/native-mail.js"), import("../src/server/crypto.js"),
  ]);
  t.after(async () => { (await db.close()); fs.rmSync(directory, { recursive: true }); });
  const marker = "MAIL-BODY-MUST-NOT-PERSIST-8297";
  const raw = `From: noreply@openai.com\r\nTo: pending@example.com\r\nSubject: Verification code\r\n\r\n123456 ${marker}`;
  let calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const reader = { byId: async () => { calls += 1; await barrier; throw new Error(marker); } };
  const initial = ingestSharedMailEvent({ id: 10, raw }, reader);
  while (!calls) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(retrySharedMailEvent("10", reader), (error: any) => error.code === "mail_event_busy");
  const secondConnection = db.dialect === "mysql" ? new (await import("../src/server/storage/mysql.js")).MySqlDatabase(process.env.MYSQL_URL!) : new Database(process.env.DATABASE_PATH!);
  assert.equal(((await secondConnection.prepare("SELECT attempts FROM mail_ingestion_state WHERE provider_message_id='10'").get()) as any).attempts, 1);
  const duplicate = await ingestSharedMailEvent({ id: 10, raw }, reader);
  assert.equal(duplicate.processingStatus, "pending_time");
  assert.equal(calls, 1);
  release();
  assert.equal((await initial).processingStatus, "pending_time");
  const state = (await db.prepare("SELECT updated_at,error_code,attempts FROM mail_ingestion_state WHERE provider_message_id='10'").get());
  await ingestSharedMailEvent({ id: 10, raw }, reader);
  assert.equal(calls, 1);
  assert.deepEqual((await db.prepare("SELECT updated_at,error_code,attempts FROM mail_ingestion_state WHERE provider_message_id='10'").get()), state);
  await assert.rejects(retrySharedMailEvent("10", reader), (error: any) => error.code === "mail_event_cooling_down");
  (await secondConnection.prepare("UPDATE mail_ingestion_leases SET owner='dead-worker',lease_until=?,retry_after=0 WHERE provider_message_id='10'")
    .run(Date.now() - 1));
  (await secondConnection.close());
  const completed = await retrySharedMailEvent("10", { byId: async () => {
    calls += 1;
    return { id: 10, raw, created_at: "2026-09-07 08:00:00" };
  } });
  assert.equal(completed.processingStatus, "processed");
  assert.equal(calls, 2);
  await ingestSharedMailEvent({ id: 10, raw, created_at: "2026-09-08 08:00:00" }, reader);
  assert.equal(((await db.prepare("SELECT received_at FROM mail_messages WHERE provider_message_id='10'").get()) as any).received_at, "2026-09-07T08:00:00.000Z");
  assert.equal(calls, 2);

  await ingestSharedMailEvent({ id: 11, raw }, { byId: async () => { throw new MailReadError("mail_read_busy", 429); } });
  assert.equal(((await db.prepare("SELECT attempts FROM mail_ingestion_state WHERE provider_message_id='11'").get()) as any).attempts, 0);
  await assert.rejects(retrySharedMailEvent("11", reader), (error: any) => error.code === "mail_event_cooling_down");
  assert.equal(calls, 2);
  assert.equal((await databaseSnapshot(db)).includes(marker), false);
  for (const filename of fs.readdirSync(directory)) {
    assert.equal(fs.readFileSync(path.join(directory, filename)).includes(Buffer.from(marker)), false, filename);
  }

  const now = "2026-09-01T00:00:00.000Z";
  (await db.prepare(`INSERT INTO gpt_accounts(id,lifecycle_status,arrived_at,created_at,updated_at)
    VALUES('otp-account','active',?,?,?)`).run(now, now, now));
  (await db.prepare(`INSERT INTO mailbox_families(id,provider,canonical_address_hash,created_at,updated_at)
    VALUES('otp-family','domain','otp-family',?,?)`).run(now, now));
  for (const [id, email, from, to, current] of [
    ["old-otp", "old@example.com", now, "2026-09-07T08:00:00.500Z", 0],
    ["new-otp", "new@example.com", "2026-09-07T08:00:00.500Z", "", 1],
  ] as const) {
    (await db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,
      valid_from,valid_to,is_current,legacy_mapping_id,created_at,updated_at)
      VALUES(?,'otp-account','otp-family',?,?,?,'example.com','domain',?,?,?,?,?,?)`)
      .run(id, encryptSecret(email), id, email.split("@")[0], from, to, current, id, now, now));
    (await db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,recipient_pattern,valid_from,valid_to,source,created_at,updated_at)
      VALUES(?,?,?,?,?,'test',?,?)`).run(id, id, `^${email.replace(".", "\\.")}$`, from, to, now, now));
  }
  for (const [id, email, at] of [[20, "old@example.com", "2026-09-07 08:00:00.499"],
    [21, "old@example.com", "2026-09-07 08:00:00.501"], [22, "new@example.com", "2026-09-07 08:00:00.502"],
    [23, "old@example.com", "2026-09-07 08:00:00.500"]] as const) {
    await ingestSharedMailEvent({ id, raw: `From: noreply@openai.com\r\nTo: ${email}\r\nSubject: Your verification code\r\n\r\n${marker}`, created_at: at });
  }
  const detailIds: string[] = [];
  const detailReader = async (_accountId: string, id: string) => {
    detailIds.push(id);
    const row = (await db.prepare("SELECT provider_message_id FROM mail_messages WHERE id=?").get(id)) as any;
    return { mail: { subject: "Verification code", text: `1234${row.provider_message_id} ${marker}`, html: `<p>${marker}</p>` } };
  };
  const currentOtp = await accountVerificationCode("otp-account", {}, detailReader) as any;
  assert.equal(currentOtp.item.verificationCode, "123422");
  const oldOtp = await accountVerificationCode("otp-account", { bindingId: "old-otp" }, detailReader) as any;
  assert.equal(oldOtp.item.verificationCode, "123420");
  const overrideOtp = await accountVerificationCode("otp-account", { bindingId: "old-otp", ignoreAccessWindow: true }, detailReader) as any;
  assert.equal(overrideOtp.item.verificationCode, "123421");
  assert.equal(((await db.prepare(`SELECT visible_to_customer FROM mail_ownership_claims c JOIN mail_messages m ON m.id=c.message_id
    WHERE m.provider_message_id='21'`).get()) as any).visible_to_customer, 0);
  assert.equal(JSON.stringify(overrideOtp).includes(marker), false);
  assert.equal(detailIds.length, 3);
  await accountVerificationCode("otp-account", { bindingId: "old-otp" }, detailReader);
  assert.equal(detailIds.length, 3);
  (await db.prepare("UPDATE email_bindings SET valid_to='2026-09-07T08:00:00.498Z' WHERE id='old-otp'").run());
  assert.equal((await accountVerificationCode("otp-account", { bindingId: "old-otp" }, detailReader) as any).item, null);
  assert.equal(detailIds.length, 3);
  const { outlookManagerFetch } = await import("../src/server/upstream-mail.js");
  const originalFetch = globalThis.fetch;
  const upstreamCalls: string[] = [];
  globalThis.fetch = async (input) => {
    upstreamCalls.push(String(input));
    return String(input).endsWith("/login")
      ? new Response(JSON.stringify({ success: true }), { headers: { "set-cookie": "fake-session=fake; Path=/" } })
      : new Response(JSON.stringify({ error: { message: marker } }), { status: 503 });
  };
  try {
    await assert.rejects(outlookManagerFetch("/api/accounts"), (error: any) => {
      assert.equal(error.message.includes(marker), false);
      return error.code === "outlook_upstream_503";
    });
    assert.equal(upstreamCalls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});
