import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function identityHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

test("只读迁移核对下 Sub2API 不建账号、不隔离已有身份", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-v1-authority-"));
  const metadata = [
    { id: 1, name: "conflict", platform: "openai", status: "active", updated_at: "2026-09-02T00:00:00.000Z", credentials: { email: "kept@icloud.com" } },
    { id: 2, name: "external-only", platform: "openai", status: "active", updated_at: "2026-09-02T00:00:00.000Z", credentials: { email: "external@icloud.com" } },
    { id: 3, name: "credential-only", platform: "openai", status: "active", updated_at: "2026-09-02T00:00:00.000Z", credentials: { email: "kept@icloud.com" } },
  ];
  const exported = [
    { name: "conflict", platform: "openai", credentials: { email: "kept@icloud.com", chatgpt_user_id: "different-identity", access_token: "ignored-at" } },
    { name: "external-only", platform: "openai", credentials: { email: "external@icloud.com", chatgpt_user_id: "external-identity", access_token: "external-at" } },
    { name: "credential-only", platform: "openai", credentials: { email: "kept@icloud.com", chatgpt_user_id: "v1-identity", access_token: "accepted-at", plan_type: "free" } },
  ];
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/v1/admin/accounts/data")) response.end(JSON.stringify({ data: { accounts: exported } }));
    else if (request.url?.startsWith("/api/v1/admin/accounts")) response.end(JSON.stringify({ data: { items: metadata, total: metadata.length } }));
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "authority-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "authority-encryption";
  process.env.V2_READ_ONLY = "true";
  process.env.V2_ACCOUNT_AUTHORITY = "v1";
  process.env.SUB2API_API_URL = `http://127.0.0.1:${address.port}/api/v1`;
  process.env.SUB2API_ADMIN_TOKEN = "test-token";

  const [{ db }, { emailHash }, { encryptSecret }, { syncSub2ApiAlive }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/association.js"),
    import("../src/server/crypto.js"), import("../src/server/sub2api-sync.js"),
  ]);
  t.after(() => db.close());

  const now = "2026-09-01T00:00:00.000Z";
  db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, identity_status, sold, plan, source_status, arrived_at, created_at, updated_at)
    VALUES('v1-account', 'active', 'confirmed', 1, 'plus', 'current', ?, ?, ?)`).run(now, now, now);
  db.prepare(`INSERT INTO mailbox_families(id, provider, canonical_address_enc, canonical_address_hash, created_at, updated_at)
    VALUES('family', 'icloud', ?, ?, ?, ?)`).run(encryptSecret("kept@icloud.com"), emailHash("kept@icloud.com"), now, now);
  db.prepare(`INSERT INTO email_bindings(id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider, valid_from, is_current, legacy_mapping_id, created_at, updated_at)
    VALUES('binding', 'v1-account', 'family', ?, ?, 'kept', 'icloud.com', 'icloud', ?, 1, 'legacy-v1-account', ?, ?)`).run(
    encryptSecret("kept@icloud.com"), emailHash("kept@icloud.com"), now, now, now,
  );
  db.prepare(`INSERT INTO credentials(account_id, openai_subject_hash, source, updated_at)
    VALUES('v1-account', ?, 'v1-shadow-import', ?)`).run(identityHash("v1-identity"), now);
  db.prepare(`INSERT INTO account_origins(account_id, source_type, source_id, first_seen_at, metadata_json)
    VALUES('v1-account', 'legacy_v1', 'access-config', ?, '{}')`).run(now);
  db.prepare(`INSERT INTO sales(id, account_id, binding_id, status, started_at, created_at, updated_at)
    VALUES('sale', 'v1-account', 'binding', 'active', ?, ?, ?)`).run(now, now, now);
  db.prepare(`INSERT INTO access_grants(id, account_id, binding_id, sale_id, public_token_hash, login_identifier_hash, login_identifier_enc, password_hash, scope, active, created_at, updated_at)
    VALUES('grant', 'v1-account', 'binding', 'sale', 'public', 'login', '', 'password', 'current', 1, ?, ?)`).run(now, now);

  const result = await syncSub2ApiAlive();
  assert.equal(result.created, 0);
  assert.equal(result.rebinds, 0);
  assert.equal(result.conflicts, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(db.prepare("SELECT lifecycle_status, identity_status, sold, plan FROM gpt_accounts WHERE id='v1-account'").get(), {
    lifecycle_status: "active", identity_status: "confirmed", sold: 1, plan: "plus",
  });
  assert.deepEqual(db.prepare("SELECT status FROM sales WHERE id='sale'").get(), { status: "active" });
  assert.deepEqual(db.prepare("SELECT active FROM access_grants WHERE id='grant'").get(), { active: 1 });
  assert.equal((db.prepare("SELECT count(*) count FROM pending_reviews WHERE status='pending'").get() as any).count, 0);
  assert.equal((db.prepare("SELECT count(*) count FROM gpt_accounts").get() as any).count, 1);
  assert.deepEqual(db.prepare("SELECT access_token_alive FROM credentials WHERE account_id='v1-account'").get(), { access_token_alive: 1 });
});
