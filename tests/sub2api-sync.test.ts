import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type Item = Record<string, any>;

function identityHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

test("Sub2API 只同步活 OpenAI 凭证并保持改绑隔离规则", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-sub2api-"));
  const metadata: Item[] = [
    { id: 1, name: "same-local", platform: "openai", status: "active", created_at: "2026-08-20T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z", credentials: { email: "same+oai@example.com" } },
    { id: 2, name: "different-local", platform: "openai", status: "active", created_at: "2026-08-20T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z", credentials: { email: "different@example.com" } },
    { id: 3, name: "brand-new", platform: "openai", status: "active", created_at: "2026-08-21T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z", credentials: { email: "brand-new@example.net" } },
    { id: 4, name: "broken", platform: "openai", status: "error", created_at: "2026-08-21T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z", credentials: { email: "broken@example.net" } },
    { id: 5, name: "not-openai", platform: "anthropic", status: "active", created_at: "2026-08-21T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z", credentials: { email: "claude@example.net" } },
    { id: 6, name: "identity-conflict", platform: "openai", status: "active", created_at: "2026-08-21T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z", credentials: { email: "conflict@example.net" } },
    { id: 7, name: "stale-rebind", platform: "openai", status: "active", created_at: "2026-08-20T00:00:00.000Z", updated_at: "2026-08-20T12:00:00.000Z", credentials: { email: "stale-rebind@icloud.com" } },
  ];
  const exported: Item[] = [
    { name: "same-local", platform: "openai", credentials: { email: "same+oai@example.com", chatgpt_user_id: "identity-a", access_token: "at-a", refresh_token: "rt-a", plan_type: "plus" } },
    { name: "different-local", platform: "openai", credentials: { email: "different@example.com", chatgpt_user_id: "identity-b", access_token: "at-b", refresh_token: "rt-b", plan_type: "free" } },
    { name: "brand-new", platform: "openai", credentials: { email: "brand-new@example.net", chatgpt_user_id: "identity-c", access_token: "at-c", refresh_token: "rt-c", plan_type: "plus" } },
    { name: "broken", platform: "openai", credentials: { email: "broken@example.net", chatgpt_user_id: "identity-d", access_token: "at-d", refresh_token: "rt-d" } },
    { name: "not-openai", platform: "anthropic", credentials: { email: "claude@example.net", access_token: "at-e" } },
    { name: "identity-conflict", platform: "openai", credentials: { email: "conflict@example.net", chatgpt_user_id: "identity-new", access_token: "at-new" } },
    { name: "stale-rebind", platform: "openai", credentials: { email: "stale-rebind@icloud.com", chatgpt_user_id: "identity-stale-rebind", access_token: "at-stale", refresh_token: "rt-stale", plan_type: "free" } },
  ];

  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== "Bearer test-token") {
      response.statusCode = 401;
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }
    if (request.url?.startsWith("/api/v1/admin/accounts/data")) {
      response.end(JSON.stringify({ data: { accounts: exported, exported_at: "2026-08-22T00:00:00.000Z" } }));
      return;
    }
    if (request.url?.startsWith("/api/v1/admin/accounts")) {
      response.end(JSON.stringify({ data: { items: metadata, total: metadata.length, page: 1, page_size: 200 } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "test-session-secret";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "test-encryption-key";
  process.env.V2_READ_ONLY = "false";
  process.env.V2_ACCOUNT_AUTHORITY = "v2";
  process.env.SUB2API_API_URL = `http://127.0.0.1:${address.port}/api/v1`;
  process.env.SUB2API_ADMIN_TOKEN = "test-token";

  const [{ db }, { emailHash }, { decryptSecret, encryptSecret }, { syncSub2ApiAlive }] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/association.js"),
    import("../src/server/crypto.js"),
    import("../src/server/sub2api-sync.js"),
  ]);
  t.after(() => db.close());

  const now = "2026-08-19T00:00:00.000Z";
  function seed(accountId: string, email: string, subject: string, deactivated = false, source = "legacy-v1") {
    const [localPart, domain] = email.split("@");
    const familyId = `family-${accountId}`;
    const bindingId = `binding-${accountId}`;
    db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, deactivation_locked, deactivated_at, plan, arrived_at, created_at, updated_at)
      VALUES(?, ?, ?, ?, 'free', ?, ?, ?)`).run(accountId, deactivated ? "deactivated" : "active", deactivated ? 1 : 0, deactivated ? now : "", now, now, now);
    db.prepare(`INSERT INTO mailbox_families(id, provider, canonical_address_enc, canonical_address_hash, created_at, updated_at)
      VALUES(?, 'icloud', ?, ?, ?, ?)`).run(familyId, encryptSecret(email), emailHash(email), now, now);
    db.prepare(`INSERT INTO email_bindings(id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider,
      valid_from, is_current, legacy_mapping_id, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, 'icloud', ?, 1, ?, ?, ?)`).run(bindingId, accountId, familyId, encryptSecret(email), emailHash(email), localPart, domain, now, `legacy-${accountId}`, now, now);
    db.prepare(`INSERT INTO credentials(account_id, access_token_enc, refresh_token_enc, openai_subject_hash,
      access_token_alive, refresh_token_alive, source, updated_at)
      VALUES(?, '', '', ?, 0, 0, ?, ?)`).run(accountId, identityHash(subject), source, now);
  }

  seed("account-a", "same+oai@icloud.com", "identity-a", true);
  seed("account-b", "old-local@icloud.com", "identity-b");
  seed("account-conflict", "conflict@example.net", "identity-old");
  seed("stale-account", "stale@icloud.com", "identity-stale", false, "sub2api-active");
  seed("stale-rebind-account", "stale-rebind@example.com", "identity-stale-rebind");
  db.prepare("UPDATE gpt_accounts SET plan='plus' WHERE id='stale-rebind-account'").run();
  db.prepare("UPDATE email_bindings SET valid_from='2026-08-21T00:00:00.000Z' WHERE account_id='stale-rebind-account'").run();
  db.prepare(`INSERT INTO email_bindings(id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider,
    valid_from, valid_to, is_current, association_method, legacy_mapping_id, created_at, updated_at)
    VALUES('binding-stale-rebind-old', 'stale-rebind-account', 'family-stale-rebind-account', ?, ?, 'stale-rebind', 'icloud.com', 'icloud',
      '2026-08-19T00:00:00.000Z', '2026-08-21T00:00:00.000Z', 0, 'legacy_explicit_rebind', 'legacy-stale-rebind-old', ?, ?)`).run(
    encryptSecret("stale-rebind@icloud.com"), emailHash("stale-rebind@icloud.com"), now, now,
  );
  db.prepare("UPDATE credentials SET access_token_enc=?, refresh_token_enc=?, access_token_alive=1, refresh_token_alive=1 WHERE account_id='stale-rebind-account'")
    .run(encryptSecret("fresh-target-at"), encryptSecret("fresh-target-rt"));
  db.prepare("UPDATE credentials SET access_token_enc=?, refresh_token_enc=?, access_token_alive=1, refresh_token_alive=1 WHERE account_id='stale-account'")
    .run(encryptSecret("stale-at"), encryptSecret("stale-rt"));
  db.prepare(`INSERT INTO sales(id, account_id, binding_id, status, started_at, first_used_at, last_used_at, created_at, updated_at)
    VALUES('sale-a', 'account-a', 'binding-account-a', 'active', ?, ?, ?, ?, ?)`).run(now, now, now, now, now);
  db.prepare(`INSERT INTO access_grants(id, account_id, binding_id, sale_id, public_token_hash, login_identifier_hash,
    login_identifier_enc, password_hash, scope, visible_from, active, first_used_at, last_used_at, created_at, updated_at)
    VALUES('grant-a', 'account-a', 'binding-account-a', 'sale-a', 'public-a', 'login-a', '', 'password', 'current', ?, 1, ?, ?, ?, ?)`).run(now, now, now, now, now);
  db.prepare("UPDATE gpt_accounts SET sold=1 WHERE id='account-a'").run();

  const result = await syncSub2ApiAlive();
  assert.deepEqual(result, { total: 7, active: 5, matched: 4, created: 1, rebinds: 1, conflicts: 2, skipped: 0 });

  const stopped = db.prepare("SELECT lifecycle_status, deactivation_locked, plan FROM gpt_accounts WHERE id='account-a'").get() as any;
  assert.deepEqual(stopped, { lifecycle_status: "deactivated", deactivation_locked: 1, plan: "plus" });
  const rebind = db.prepare("SELECT id, is_current FROM email_bindings WHERE account_id='account-a' AND email_hash=?").get(emailHash("same+oai@example.com")) as any;
  assert.ok(rebind);
  assert.equal(rebind.is_current, 1);
  const newGrant = db.prepare("SELECT scope, active FROM access_grants WHERE binding_id=?").get(rebind.id) as any;
  assert.deepEqual(newGrant, { scope: "admin_only", active: 0 });
  const oldGrant = db.prepare("SELECT scope, active, visible_to FROM access_grants WHERE id='grant-a'").get() as any;
  assert.equal(oldGrant.scope, "historical");
  assert.equal(oldGrant.active, 1);
  assert.ok(oldGrant.visible_to);

  assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM email_bindings WHERE account_id='account-b'").get() as any).count), 1);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM pending_reviews WHERE account_id='account-b' AND status='pending'").get() as any).count), 1);

  const created = db.prepare("SELECT id, lifecycle_status FROM gpt_accounts WHERE id NOT IN ('account-a','account-b','account-conflict','stale-account','stale-rebind-account')").get() as any;
  assert.ok(created);
  assert.equal(created.lifecycle_status, "active");
  const createdGrant = db.prepare("SELECT scope, active FROM access_grants WHERE account_id=?").get(created.id) as any;
  assert.deepEqual(createdGrant, { scope: "admin_only", active: 0 });
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM email_bindings WHERE email_hash=?").get(emailHash("broken@example.net")) as any).count), 0);
  const staleRebind = db.prepare(`SELECT b.domain, b.is_current, a.plan
    FROM email_bindings b JOIN gpt_accounts a ON a.id=b.account_id
    WHERE a.id='stale-rebind-account' ORDER BY b.is_current DESC LIMIT 1`).get() as any;
  assert.deepEqual(staleRebind, { domain: "example.com", is_current: 1, plan: "plus" });
  const staleRebindCredential = db.prepare("SELECT access_token_enc, refresh_token_enc FROM credentials WHERE account_id='stale-rebind-account'").get() as any;
  assert.equal(decryptSecret(staleRebindCredential.access_token_enc), "fresh-target-at");
  assert.equal(decryptSecret(staleRebindCredential.refresh_token_enc), "fresh-target-rt");

  // An administrator-confirmed regional billing channel is durable Plus
  // evidence. A later stale Free snapshot must not erase a paid account.
  db.prepare("UPDATE gpt_accounts SET plan='plus', billing_channel_override='vn-momo' WHERE id='account-b'").run();
  await syncSub2ApiAlive();
  assert.equal((db.prepare("SELECT plan FROM gpt_accounts WHERE id='account-b'").get() as any).plan, "plus");

  // Header-only "new plan" subjects are fetch candidates, not proof that a
  // paid subscription became active. A stale upstream Free snapshot may
  // therefore clear the derived plan.
  db.prepare(`INSERT INTO mail_messages(
    id, provider, provider_message_id, sender, subject, received_at, category, indexed_at
  ) VALUES('plus-receipt', 'shared-mail-api', 'plus-receipt', 'OpenAI', 'ChatGPT - Your new plan', ?, 'billing', ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO mail_ownership_claims(
    message_id, account_id, binding_id, claim_type, reason, visible_to_customer, created_at
  ) VALUES('plus-receipt', 'stale-rebind-account', 'binding-stale-rebind-account', 'test', 'activation evidence', 1, ?)`)
    .run(now);
  db.prepare("UPDATE gpt_accounts SET plan='plus' WHERE id='stale-rebind-account'").run();
  await syncSub2ApiAlive();
  assert.equal((db.prepare("SELECT plan FROM gpt_accounts WHERE id='stale-rebind-account'").get() as any).plan, "plus");

  db.prepare(`INSERT INTO mail_messages(
    id, provider, provider_message_id, sender, subject, received_at, category, indexed_at
  ) VALUES('strict-plus-receipt', 'shared-mail-api', 'strict-plus-receipt', 'OpenAI', 'Welcome to ChatGPT Plus', ?, 'billing', ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO mail_ownership_claims(
    message_id, account_id, binding_id, claim_type, reason, visible_to_customer, created_at
  ) VALUES('strict-plus-receipt', 'stale-rebind-account', 'binding-stale-rebind-account', 'test', 'strict activation evidence', 1, ?)`)
    .run(now);
  db.prepare("UPDATE gpt_accounts SET plan='plus' WHERE id='stale-rebind-account'").run();
  await syncSub2ApiAlive();
  assert.equal((db.prepare("SELECT plan FROM gpt_accounts WHERE id='stale-rebind-account'").get() as any).plan, "plus");

  const conflict = db.prepare("SELECT lifecycle_status, identity_status FROM gpt_accounts WHERE id='account-conflict'").get() as any;
  assert.deepEqual(conflict, { lifecycle_status: "quarantined", identity_status: "conflict" });
  assert.equal((db.prepare("SELECT access_token_alive FROM credentials WHERE account_id='account-conflict'").get() as any).access_token_alive, 0);

  const stale = db.prepare("SELECT access_token_alive, refresh_token_alive FROM credentials WHERE account_id='stale-account'").get() as any;
  assert.deepEqual(stale, { access_token_alive: 0, refresh_token_alive: 0 });

  const invalidVersion = db.prepare("SELECT credential_version_id FROM account_current_credentials WHERE account_id='account-a'").get() as any;
  const invalidated = db.prepare("UPDATE credential_versions SET validity_status='invalid', validity_checked_at=? WHERE id=?")
    .run(now, invalidVersion.credential_version_id);
  assert.equal(invalidated.changes, 1);
  const beforeResync = db.prepare(`SELECT cc.credential_version_id, cv.token_fingerprint, cv.validity_status
    FROM account_current_credentials cc JOIN credential_versions cv ON cv.id=cc.credential_version_id
    WHERE cc.account_id='account-a'`).get() as any;
  assert.equal(beforeResync.validity_status, "invalid");
  await syncSub2ApiAlive();
  const afterResync = db.prepare(`SELECT cc.credential_version_id, cv.token_fingerprint, cv.validity_status
    FROM account_current_credentials cc JOIN credential_versions cv ON cv.id=cc.credential_version_id
    WHERE cc.account_id='account-a'`).get() as any;
  assert.deepEqual(afterResync, beforeResync);
  assert.deepEqual(db.prepare("SELECT access_token_alive, refresh_token_alive FROM credentials WHERE account_id='account-a'").get(), {
    access_token_alive: 0, refresh_token_alive: 0,
  });

  metadata.find((item) => item.name === "brand-new")!.status = "error";
  await syncSub2ApiAlive();
  const noLongerActive = db.prepare("SELECT access_token_alive, refresh_token_alive FROM credentials WHERE account_id=?").get(created.id) as any;
  assert.deepEqual(noLongerActive, { access_token_alive: 0, refresh_token_alive: 0 });
});
