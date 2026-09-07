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

  const [{ db }, cryptoModule, repository, classification] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/crypto.js"),
    import("../src/server/repository.js"),
    import("../src/server/mail-classification.js"),
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
  db.prepare(`INSERT INTO mailbox_families(id, provider, canonical_address_hash, created_at, updated_at)
    VALUES('family-old', 'icloud', 'old-family', ?, ?), ('family-new', 'domain', 'new-family', ?, ?),
      ('family-other', 'domain', 'other-family', ?, ?)`).run(
    "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z",
    "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z",
  );
  const insertBinding = db.prepare(`INSERT INTO email_bindings(id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider,
    valid_from, valid_to, is_current, legacy_mapping_id, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertBinding.run(oldBinding, accountId, "family-old", encryptSecret("same+oai@icloud.com"), "old-email", "same+oai", "icloud.com", "icloud",
    "2026-08-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z", 0, "legacy-old", "2026-08-01T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
  insertBinding.run(newBinding, accountId, "family-new", encryptSecret("same+oai@example.com"), "new-email", "same+oai", "example.com", "domain",
    "2026-08-10T00:00:00.000Z", "", 1, "legacy-new", "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
  insertBinding.run("binding-other", "other-account", "family-other", encryptSecret("other@example.net"), "other-email", "other", "example.net", "domain",
    "2026-08-10T00:00:00.000Z", "", 1, "legacy-other", "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");

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
  assert.deepEqual(currentIds, ["new-security-after"]);
  assert.equal(customerMailDetail(current, "old-security-after"), null);
  assert.equal(customerMailDetail(current, "old-billing-after"), null);
  assert.equal(customerMailDetail(current, "ambiguous"), null);
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
});
