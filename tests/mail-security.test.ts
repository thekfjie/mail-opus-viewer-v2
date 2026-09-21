import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("当前绑定只跨阶段显示安全白名单邮件，旧链接严格截止", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-security-"));
  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "security-test-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "security-test-encryption";
  process.env.MAIL_ADMIN_AUTH = "security-test-mail-auth";
  process.env.V2_SHARED_MAIL_PAGE_SIZE = "10";

  const [{ db }, cryptoModule, repository, classification, { ingestSharedMailEvent }] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/crypto.js"),
    import("../src/server/repository.js"),
    import("../src/server/mail-classification.js"),
    import("../src/server/mail-sync.js"),
  ]);
  t.after(() => db.close());

  const { digestToken, encryptSecret } = cryptoModule;
  const { grantByPublicToken, listCustomerMails, customerMailDetail } = repository;
  const accountId = "account";
  const oldBinding = "binding-old";
  const newBinding = "binding-new";
  db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, plan, arrived_at, created_at, updated_at)
    VALUES(?, 'active', 'plus', ?, ?, ?)`).run(accountId, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
  db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, plan, arrived_at, created_at, updated_at)
    VALUES('other-account', 'active', 'free', ?, ?, ?)`).run("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
  db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, plan, arrived_at, created_at, updated_at)
    VALUES('expired-account', 'retired', 'free', ?, ?, ?)`).run("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
  db.prepare(`INSERT INTO mailbox_families(id, provider, canonical_address_hash, created_at, updated_at)
    VALUES('family-old', 'icloud', 'old-family', ?, ?), ('family-new', 'domain', 'new-family', ?, ?),
      ('family-other', 'domain', 'other-family', ?, ?), ('family-expired', 'icloud', 'expired-family', ?, ?)`).run(
    "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z",
    "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z", "2026-08-01T00:00:00.000Z", "2026-08-20T00:00:00.000Z",
  );
  const insertBinding = db.prepare(`INSERT INTO email_bindings(id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider,
    valid_from, valid_to, is_current, legacy_mapping_id, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertBinding.run(oldBinding, accountId, "family-old", encryptSecret("same+oai@icloud.com"), "old-email", "same+oai", "icloud.com", "icloud",
    "2026-08-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z", 0, "legacy-old", "2026-08-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
  insertBinding.run(newBinding, accountId, "family-new", encryptSecret("same+oai@ai-mail.tech"), "new-email", "same+oai", "ai-mail.tech", "domain",
    "2026-08-10T00:00:00.000Z", "", 1, "legacy-new", "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
  insertBinding.run("binding-other", "other-account", "family-other", encryptSecret("other@kfjie.me"), "other-email", "other", "kfjie.me", "domain",
    "2026-08-10T00:00:00.000Z", "", 1, "legacy-other", "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
  insertBinding.run("binding-expired", "expired-account", "family-expired", encryptSecret("expired@icloud.com"), "expired-email", "expired", "icloud.com", "icloud",
    "2026-08-01T00:00:00.000Z", "2026-08-20T00:00:00.000Z", 0, "legacy-expired", "2026-08-01T00:00:00.000Z", "2026-08-20T00:00:00.000Z");

  const insertMessage = db.prepare(`INSERT INTO mail_messages(id, provider, provider_message_id, sender, subject, received_at, category, is_security, indexed_at)
    VALUES(?, 'shared-mail-api', ?, 'OpenAI', ?, ?, ?, ?, ?)`);
  const insertClaim = db.prepare(`INSERT INTO mail_ownership_claims(message_id, account_id, binding_id, claim_type, reason, visible_to_customer, created_at)
    VALUES(?, ?, ?, 'test', 'test ownership', ?, ?)`);
  function mail(id: string, bindingId: string, at: string, category: string, visible = 1) {
    insertMessage.run(id, id, id, at, category, category === "security" ? 1 : 0, at);
    insertClaim.run(id, accountId, bindingId, visible, at);
  }
  mail("old-general-before", oldBinding, "2026-08-09T10:00:00.000Z", "general");
  mail("old-billing-before", oldBinding, "2026-08-09T11:00:00.000Z", "billing");
  mail("old-security-after", oldBinding, "2026-08-11T10:00:00.000Z", "security");
  mail("old-billing-after", oldBinding, "2026-08-11T11:00:00.000Z", "billing");
  mail("new-security-after", newBinding, "2026-08-11T12:00:00.000Z", "security");
  mail("new-hidden", newBinding, "2026-08-11T13:00:00.000Z", "general", 0);
  mail("ambiguous", newBinding, "2026-08-11T14:00:00.000Z", "general");
  insertClaim.run("ambiguous", "other-account", "binding-other", 1, "2026-08-11T14:00:00.000Z");
  mail("legacy-shared", newBinding, "2026-08-11T15:00:00.000Z", "security", 0);
  db.prepare("UPDATE mail_ownership_claims SET claim_type='legacy_mapping_index' WHERE message_id='legacy-shared' AND binding_id=?").run(newBinding);
  insertClaim.run("legacy-shared", "other-account", "binding-other", 0, "2026-08-11T15:00:00.000Z");
  db.prepare("UPDATE mail_ownership_claims SET claim_type='legacy_mapping_index' WHERE message_id='legacy-shared' AND binding_id='binding-other'").run();

  const now = "2026-08-10T00:00:00.000Z";
  db.prepare(`INSERT INTO access_grants(id, account_id, binding_id, public_token_hash, login_identifier_hash, login_identifier_enc,
    password_hash, scope, visible_from, visible_to, active, created_at, updated_at)
    VALUES('grant-current', ?, ?, ?, 'new-login', '', 'password', 'current', ?, '', 1, ?, ?),
          ('grant-old', ?, ?, ?, 'old-login', '', 'password', 'historical', '2026-08-01T00:00:00.000Z', ?, 1, ?, ?)`).run(
    accountId, newBinding, digestToken("new-token"), now, now, now,
    accountId, oldBinding, digestToken("old-token"), now, now, now,
  );

  const current = grantByPublicToken("new-token");
  assert.ok(current);
  const currentIds = listCustomerMails(current, 0, 30).results.map((item) => item.id).sort();
  assert.deepEqual(currentIds, ["legacy-shared", "new-security-after"]);
  assert.equal(customerMailDetail(current, "old-security-after"), null);
  assert.equal(customerMailDetail(current, "old-billing-after"), null);
  assert.equal(customerMailDetail(current, "ambiguous"), null);
  assert.ok(customerMailDetail(current, "legacy-shared"));
  const detail = customerMailDetail(current, "new-security-after");
  assert.ok(detail);
  assert.equal("mailbox_email" in detail, false);
  assert.equal("recipient_enc" in detail, false);

  const historical = grantByPublicToken("old-token");
  assert.ok(historical);
  const historicalIds = listCustomerMails(historical, 0, 30).results.map((item) => item.id).sort();
  assert.deepEqual(historicalIds, ["old-billing-before", "old-general-before"]);
  assert.equal(customerMailDetail(historical, "old-security-after"), null);

  assert.equal(classification.classifyMail("Your authentication code", "OpenAI").category, "security");
  assert.equal(classification.classifyMail("Votre code de connexion temporaire ChatGPT", "OpenAI").category, "security");
  assert.equal(classification.classifyMail("Advanced Account Security is now enabled", "OpenAI").category, "security");
  assert.deepEqual(classification.classifyMail("Your ChatGPT email address was changed", "OpenAI"), {
    category: "rebind", isSecurity: true, safeAcrossBinding: false,
  });
  assert.equal(classification.classifyMail("邮箱换绑成功", "OpenAI").category, "rebind");
  assert.equal(
    classification.classifyMail("OpenAI - アクセスが無効になりました [C-NbtL138PSBMG]", "trustandsafety@tm.openai.com").category,
    "deactivation",
  );
  assert.equal(classification.classifyMail("OpenAI - アカウントが無効になりました", "OpenAI").category, "deactivation");

  db.prepare(`INSERT INTO mail_routing_rules(id, binding_id, sender_pattern, recipient_pattern, valid_from, source, created_at, updated_at)
    VALUES('route-unique', ?, '', '^same\\+oai@ai-mail\\.tech$', '2026-08-10T00:00:00.000Z', 'test', ?, ?),
      ('route-ambiguous-a', ?, '', '^shared@ai-mail\\.tech$', '2026-08-10T00:00:00.000Z', 'test', ?, ?),
      ('route-ambiguous-b', ?, '', '^shared@ai-mail\\.tech$', '2026-08-10T00:00:00.000Z', 'test', ?, ?),
      ('route-expired', ?, '', '^expired@icloud\\.com$', '2026-08-01T00:00:00.000Z', 'test', ?, ?)`).run(
    newBinding, now, now,
    newBinding, now, now,
    "binding-other", now, now,
    "binding-expired", now, now,
  );
  db.prepare("UPDATE mail_routing_rules SET valid_to='2026-08-20T00:00:00.000Z' WHERE id='route-expired'").run();
  insertMessage.run("existing-native-200", "200", "Existing message", "2026-09-07T00:00:00.000Z", "general", 0, now);

  function rawDeactivation(recipient: string, subject: string): string {
    return [
      "From: OpenAI <trustandsafety@tm.openai.com>",
      `To: ${recipient}`,
      `Subject: ${subject}`,
      "Date: Mon, 07 Sep 2026 08:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your access has been deactivated.",
    ].join("\r\n");
  }
  const events = [
    {
      id: 196,
      address: "shared@ai-mail.tech",
      created_at: "2026-09-07T08:01:00.000Z",
      raw: rawDeactivation("shared@ai-mail.tech", "OpenAI - Access Deactivated [ambiguous]"),
    },
    {
      id: 195,
      address: "same+oai@ai-mail.tech",
      created_at: "2026-09-07T08:00:00.000Z",
      raw: rawDeactivation("same+oai@ai-mail.tech", "OpenAI - Access Deactivated [unique]"),
    },
    {
      id: 194,
      address: "expired@icloud.com",
      created_at: "2026-09-07T07:59:00.000Z",
      raw: rawDeactivation("expired@icloud.com", "OpenAI - Access Deactivated [delayed]"),
    },
  ];

  const synchronized = await Promise.all(events.map((event) => ingestSharedMailEvent(event)));
  assert.equal(synchronized.length, 3);
  assert.equal(synchronized.reduce((sum, event) => sum + Number(event.inserted), 0), 3);
  // `claims` reports unique persisted bindings, not duplicate route rows
  // produced by exact-recipient plus mailbox-batch expansion.
  assert.equal(synchronized.reduce((sum, event) => sum + event.claims, 0), 3);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) count FROM mail_ownership_claims c JOIN mail_messages m ON m.id=c.message_id
      WHERE m.provider_message_id IN ('194','195','196')`).get() as any).count,
    3,
  );
  assert.equal(synchronized.reduce((sum, event) => sum + Number(event.deactivated), 0), 0);
  assert.deepEqual(
    db.prepare("SELECT lifecycle_status, deactivation_locked, deactivated_at FROM gpt_accounts WHERE id=?").get(accountId),
    { lifecycle_status: "active", deactivation_locked: 0, deactivated_at: "" },
  );
  assert.deepEqual(
    db.prepare("SELECT scope, active, visible_to FROM access_grants WHERE id='grant-current'").get(),
    { scope: "current", active: 1, visible_to: "" },
  );
  assert.deepEqual(
    db.prepare("SELECT lifecycle_status, deactivation_locked FROM gpt_accounts WHERE id='other-account'").get(),
    { lifecycle_status: "active", deactivation_locked: 0 },
  );
  assert.deepEqual(
    db.prepare("SELECT lifecycle_status, deactivation_locked, deactivated_at FROM gpt_accounts WHERE id='expired-account'").get(),
    { lifecycle_status: "retired", deactivation_locked: 0, deactivated_at: "" },
  );
  assert.equal((db.prepare("SELECT COUNT(*) count FROM lifecycle_events WHERE event_type='deactivation_mail_detected'").get() as any).count, 2);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) count FROM mail_ownership_claims c JOIN mail_messages m ON m.id=c.message_id
      WHERE m.provider_message_id='194'`).get() as any).count,
    0,
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) count FROM mail_ownership_claims c JOIN mail_messages m ON m.id=c.message_id
      WHERE m.provider_message_id='196' AND c.visible_to_customer=1`).get() as any).count,
    0,
  );
});
