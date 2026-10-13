import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("reviewed account notices preserve recycled identities without storing body evidence", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opus-mail-review-"));
  Object.assign(process.env, { PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "test.sqlite"),
    ENV_FILE: "/dev/null", V2_SESSION_SECRET: "test-review-session", CREDENTIAL_ENCRYPTION_KEY: "test-review-encryption",
    VIEWER_ADMIN_PASSWORD: "test-review-admin", V2_CF_D1_READ_TOKEN: "" });
  const [{ db }, { encryptSecret }, { emailHash, stableId }, mail, { listPendingReviews }, { buildApp }, { sharedMailReader }, { classifyMail }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/crypto.js"), import("../src/server/association.js"),
    import("../src/server/mail-sync.js"), import("../src/server/repository.js"), import("../src/server/server.js"),
    import("../src/server/upstream-mail.js"), import("../src/server/mail-classification.js"),
  ]);
  const app = await buildApp();
  t.after(async () => { await app.close(); (await db.close()); fs.rmSync(directory, { recursive: true, force: true }); });
  const at = "2026-09-01T00:00:00.000Z", receipt = "2026-09-08 21:58:44";
  const digest = (s: string) => crypto.createHash("sha256").update(s).digest("base64url");
  const add = async (id: string, email: string, userId: string, historical = false, recovered = false) => {
    (await db.prepare(`INSERT INTO gpt_accounts(id,lifecycle_status,source_status,arrived_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).run(id, historical ? "retired" : "active", recovered ? "recovered" : "current", at, at, at));
    (await db.prepare("INSERT INTO mailbox_families(id,provider,canonical_address_hash,created_at,updated_at) VALUES(?,'icloud',?,?,?)")
      .run(id, emailHash(email), at, at));
    (await db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,
      valid_from,valid_to,is_current,legacy_mapping_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'icloud.com','icloud',?,?,?,?,?,?)`)
      .run(id, id, id, encryptSecret(email), emailHash(email), email.split("@")[0], at,
        historical ? "2026-09-03T00:00:00.000Z" : "", Number(!historical), id, at, at));
    (await db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,recipient_pattern,valid_from,valid_to,source,created_at,updated_at)
      VALUES(?,?,'^shared@example\\.com$',?,?,'test',?,?)`).run(id, id, at, historical ? "2026-09-03T00:00:00.000Z" : "", at, at));
    if (!recovered) {
      (await db.prepare("INSERT INTO credentials(account_id,openai_subject_hash,source,updated_at) VALUES(?,?,'test',?)")
        .run(id, digest(`membership-${id}`), at));
      const token = ["e30", Buffer.from(JSON.stringify({ sub: `auth0|${id}`, "https://api.openai.com/auth": {
        chatgpt_user_id: userId, chatgpt_account_user_id: `membership-${id}` } })).toString("base64url"), "fake"].join(".");
      (await db.prepare(`INSERT INTO credential_versions(id,account_id,subject_hash,access_token_enc,token_fingerprint,first_seen_at,last_seen_at,source,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'test',?,?)`).run(id, id, digest(`membership-${id}`), encryptSecret(token), digest(token), at, at, at, at));
    }
  };
  (await add("old", "box@icloud.com", "11111111-1111-4111-8111-111111111111", true));
  (await add("current", "box+oaione@icloud.com", "22222222-2222-4222-8222-222222222222"));
  (await add("sibling", "box+oaitwo@icloud.com", "33333333-3333-4333-8333-333333333333"));
  (await add("rollback-shell", "obsolete@icloud.com", "", true, true));
  (await db.prepare("UPDATE mail_routing_rules SET recipient_pattern='',valid_to='' WHERE id='rollback-shell'").run());
  const marker = "NO-PERSISTED-MAIL-REVIEW-BODY-93832";
  const row = (id: string, text: string, japanese = false, sender = "trustandsafety@tm.openai.com") => ({ id,
    created_at: receipt, address: "shared@example.com", raw: [`From: ${sender}`, "To: shared@example.com",
      `Subject: ${japanese ? "OpenAI - アクセスが無効になりました [case]" : "OpenAI - Access Deactivated [case]"}`,
      "Content-Type: text/plain; charset=utf-8", "", text, marker].join("\r\n") });
  const owner = async (id: string) => ((await db.prepare("SELECT account_id FROM mail_ownership_claims WHERE message_id=? ORDER BY account_id")
    .all(stableId("mail-message", "shared-mail-api", id))) as any[]).map((r) => r.account_id);
  const locked = async (id: string) => ((await db.prepare("SELECT deactivation_locked FROM gpt_accounts WHERE id=?").get(id)) as any).deactivation_locked;
  const detected = async (id: string) => ((await db.prepare("SELECT COUNT(*) n FROM lifecycle_events WHERE account_id=? AND event_type='deactivation_mail_detected'").get(id)) as any).n;

  await t.test("Japanese translated notice uses exact alias plus the same JWT's user identity", async () => {
    await mail.ingestSharedMailEvent(row("701", "メールアドレス box+oaione@icloud.com に関連するアカウント。ユーザー ID: 22222222-2222-4222-8222-222222222222", true));
    assert.deepEqual((await owner("701")), ["current"]);
    assert.equal((await locked("current")), 0); assert.equal((await detected("current")), 1);
    assert.equal((await locked("old")), 0); assert.equal((await locked("sibling")), 0);
  });
  await t.test("late English notice records evidence on the old identity without freezing either generation", async () => {
    await mail.ingestSharedMailEvent(row("702", "OpenAI account associated with box@icloud.com (User ID: 11111111-1111-4111-8111-111111111111)."));
    assert.deepEqual((await owner("702")), ["old"]); assert.equal((await locked("old")), 0); assert.equal((await detected("old")), 1); assert.equal((await locked("sibling")), 0);
    const claim = (await db.prepare("SELECT visible_to_customer FROM mail_ownership_claims WHERE message_id=?")
      .get(stableId("mail-message", "shared-mail-api", "702"))) as any;
    assert.equal(claim.visible_to_customer, 1);
    assert.equal(((await db.prepare("SELECT deactivated_at FROM gpt_accounts WHERE id='old'").get()) as any).deactivated_at, "");
  });
  await t.test("conflicting child identity does not hide mail from its identified batch", async () => {
    await mail.ingestSharedMailEvent(row("703", "OpenAI account associated with box+oaitwo@icloud.com (User ID: 22222222-2222-4222-8222-222222222222)."));
    const id = stableId("mail-message", "shared-mail-api", "703");
    assert.equal((await locked("sibling")), 0);
    assert.equal(((await db.prepare("SELECT COUNT(*) n FROM mail_ownership_claims WHERE message_id=? AND visible_to_customer=1").get(id)) as any).n, 2);
    assert.ok(!(await listPendingReviews()).some((r) => (r.evidence as any).messageId === id));
  });
  await t.test("unidentified delivery in one batch stays visible and duplicate events cost zero reads", async () => {
    const initial = row("704", "A deactivation notice without identifying context.");
    await mail.ingestSharedMailEvent(initial);
    const messageId = stableId("mail-message", "shared-mail-api", "704");
    assert.equal(((await db.prepare("SELECT COUNT(*) n FROM mail_ownership_claims WHERE message_id=? AND visible_to_customer=1").get(messageId)) as any).n, 2);
    assert.ok(!(await listPendingReviews()).some((r) => (r.evidence as any).messageId === messageId));
    let reads = 0;
    sharedMailReader.byId = async () => { reads++; return initial; };
    await mail.ingestSharedMailEvent({ id: "704" }, sharedMailReader);
    assert.equal(reads, 0);
  });
  await t.test("associated old address wins over a current-address footer in the same identity", async () => {
    const oldEmail = "before@icloud.com";
    (await db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,
      valid_from,valid_to,is_current,legacy_mapping_id,created_at,updated_at)
      VALUES('same-old','current','current',?,?,'before','icloud.com','icloud',?, ?,0,'same-old',?,?)`)
      .run(encryptSecret(oldEmail), emailHash(oldEmail), at, "2026-09-03T00:00:00.000Z", at, at));
    (await db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,recipient_pattern,valid_from,valid_to,source,created_at,updated_at)
      VALUES('same-old','same-old','^shared@example\\.com$',?,?,'test',?,?)`).run(at,"2026-09-03T00:00:00.000Z",at,at));
    await mail.ingestSharedMailEvent(row("707", "OpenAI account associated with before@icloud.com (User ID: 22222222-2222-4222-8222-222222222222). Contact box+oaione@icloud.com."));
    const messageId = stableId("mail-message", "shared-mail-api", "707");
    assert.deepEqual((await db.prepare("SELECT binding_id,visible_to_customer FROM mail_ownership_claims WHERE message_id=?").all(messageId)),
      [{ binding_id: "same-old", visible_to_customer: 1 }]);
  });
  await t.test("repeated bindings in one account chain select the receipt-time stage without conflict", async () => {
    const repeatedEmail = "repeated@icloud.com";
    for (const [id, from, to] of [
      ["repeat-old", at, "2026-09-05T00:00:00.000Z"],
      ["repeat-new", "2026-09-05T00:00:00.000Z", ""],
    ]) {
      (await db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,
        valid_from,valid_to,is_current,legacy_mapping_id,created_at,updated_at)
        VALUES(?,'current','current',?,?,'repeated','icloud.com','icloud',?,?,0,?,?,?)`)
        .run(id, encryptSecret(repeatedEmail), emailHash(repeatedEmail), from, to, id, at, at));
      (await db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,recipient_pattern,valid_from,valid_to,source,created_at,updated_at)
        VALUES(?,?,'^shared@example\\.com$',?,?,'test',?,?)`).run(id, id, from, to, at, at));
    }
    await mail.ingestSharedMailEvent(row("708",
      "OpenAI account associated with repeated@icloud.com (User ID: 22222222-2222-4222-8222-222222222222)."));
    const messageId = stableId("mail-message", "shared-mail-api", "708");
    assert.deepEqual((await db.prepare(`SELECT account_id,binding_id,visible_to_customer FROM mail_ownership_claims
      WHERE message_id=?`).all(messageId)),
    [{ account_id: "current", binding_id: "repeat-new", visible_to_customer: 1 }]);
    assert.ok(!(await listPendingReviews()).some((review) => (review.evidence as any).messageId === messageId));
  });
  await t.test("retired recovered sample cannot claim unrelated future mail", async () => {
    await mail.ingestSharedMailEvent({ ...row("705", "general"), raw: "From: noreply@openai.com\r\nTo: shared@example.com\r\nSubject: News\r\n\r\nbody" });
    assert.ok(!(await owner("705")).includes("rollback-shell"));
  });
  await t.test("non-OpenAI sender cannot use body text to select a recycled identity", async () => {
    await mail.ingestSharedMailEvent(row("706", "OpenAI account associated with box+oaitwo@icloud.com (User ID: 33333333-3333-4333-8333-333333333333).", false, "attacker@example.com"));
    assert.equal((await locked("sibling")), 0);
    assert.ok((await listPendingReviews()).some((r) => (r.evidence as any).messageId === stableId("mail-message", "shared-mail-api", "706")));
  });
  await t.test("V1 strict Plus and security signals classify without changing account plan", () => {
    assert.equal(classifyMail("Welcome to ChatGPT Plus").category, "billing");
    assert.equal(classifyMail("Your OpenAI code is 123456").category, "security");
    assert.equal(classifyMail("Your multi-factor authentication settings have been changed").category, "security");
    assert.notEqual(classifyMail("Introducing Welcome to ChatGPT Plus newsletter").category, "billing");
  });
  await t.test("rotated iCloud sender requires recipient and confirmed identity; unresolved notices never disappear", async () => {
    (await add("relay-old", "rotating@icloud.com", "44444444-4444-4444-8444-444444444444", true));
    (await add("relay-new", "rotating+fresh@icloud.com", "55555555-5555-4555-8555-555555555555"));
    const before = (await db.prepare("SELECT * FROM access_grants ORDER BY id").all());
    const bindingsBefore = (await db.prepare("SELECT * FROM email_bindings ORDER BY id").all());
    const originalRules = (await db.prepare("SELECT id,sender_pattern FROM mail_routing_rules").all()) as any[];
    (await db.prepare("UPDATE mail_routing_rules SET sender_pattern='^previous-relay@icloud\\.com$'").run());
    const sender = "trustandsafety_at_tm_openai_com_changedopaque_123abc@icloud.com";
    const text = "OpenAI account associated with rotating@icloud.com (User ID: 44444444-4444-4444-8444-444444444444).";
    try {
      await mail.ingestSharedMailEvent(row("720", text, false, sender));
      assert.deepEqual((await owner("720")), ["relay-old"]);
      assert.equal((await locked("relay-old")), 0); assert.equal((await detected("relay-old")), 1); assert.equal((await locked("relay-new")), 0);
      assert.equal(((await db.prepare("SELECT visible_to_customer FROM mail_ownership_claims WHERE message_id=?")
        .get(stableId("mail-message", "shared-mail-api", "720"))) as any).visible_to_customer, 1);
      assert.deepEqual((await db.prepare("SELECT * FROM access_grants ORDER BY id").all()), before);
      assert.deepEqual((await db.prepare("SELECT * FROM email_bindings ORDER BY id").all()), bindingsBefore);

      for (const [id, body, from] of [
        ["721", text.replace("44444444-4444-4444-8444-444444444444", "66666666-6666-4666-8666-666666666666"), sender],
        ["722", text, "attacker@example.com"],
        ["723", "OpenAI account associated with rotating@icloud.com.", sender],
        ["724", "No identifying context", sender],
      ]) {
        await mail.ingestSharedMailEvent(row(id, body, false, from));
        assert.deepEqual((await owner(id)), []);
        assert.ok((await listPendingReviews()).some((r) => (r.evidence as any).messageId === stableId("mail-message", "shared-mail-api", id)));
      }
      const outside = row("725", text, false, sender);
      await mail.ingestSharedMailEvent({ ...outside, address: "unrelated@example.org", raw: outside.raw.replaceAll("shared@example.com", "unrelated@example.org") });
      assert.deepEqual((await owner("725")), []);
      await mail.ingestSharedMailEvent({ ...row("726", text, false, sender), raw: row("726", text, false, sender).raw.replace("OpenAI - Access Deactivated [case]", "An ordinary notification") });
      assert.deepEqual((await owner("726")), []);
      assert.equal((await locked("relay-new")), 0);

      const reviewId = stableId("mail-review", stableId("mail-message", "shared-mail-api", "724"));
      let reads = 0;
      const reader = { byId: async (id: string) => { reads++; assert.equal(id, "724"); await new Promise(resolve => setImmediate(resolve)); return row(id, text, false, sender); } };
      const result = await Promise.all([mail.reprocessReviewedMail(reviewId, reader), mail.reprocessReviewedMail(reviewId, reader)]);
      assert.equal(result[0].status, "resolved"); assert.equal(result[1].status, "resolved"); assert.equal(reads, 1);
      await mail.ingestSharedMailEvent({ id: "724" }, reader);
      assert.equal(reads, 1);
      assert.deepEqual((await owner("724")), ["relay-old"]);
    } finally {
      for (const rule of originalRules) (await db.prepare("UPDATE mail_routing_rules SET sender_pattern=? WHERE id=?").run(rule.sender_pattern, rule.id));
    }
  });
  assert.equal(db.serialize().includes(Buffer.from(marker)), false);
  for (const entry of fs.readdirSync(directory)) if (fs.statSync(path.join(directory, entry)).isFile()) {
    assert.equal(fs.readFileSync(path.join(directory, entry)).includes(Buffer.from(marker)), false);
  }
});
