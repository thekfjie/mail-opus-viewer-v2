import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");
const jwt = (sub: string, accountUser = "", user = "") => `fake.${Buffer.from(JSON.stringify({
  sub, "https://api.openai.com/auth": { chatgpt_account_user_id: accountUser, chatgpt_user_id: user },
})).toString("base64url")}.fake`;

test("Sub2API review cases distinguish identity aliases, duplicate labels and API gateways", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-sub2api-review-"));
  process.env.PROJECT_ROOT = directory;
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "review-test-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "review-test-encryption";
  process.env.SUB2API_API_URL = "http://127.0.0.1:1/api/v1";
  process.env.SUB2API_ADMIN_TOKEN = "fake-test-token";
  process.env.V2_READ_ONLY = "false";
  const [{ db }, { encryptSecret, decryptSecret }, { emailHash, stableId }, sync] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/crypto.js"),
    import("../src/server/association.js"), import("../src/server/sub2api-sync.js"),
  ]);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const now = "2026-09-01T00:00:00.000Z";
  function seed(id: string, email: string, identity: string, locked = false): void {
    db.prepare(`INSERT INTO gpt_accounts(id,lifecycle_status,identity_status,deactivation_locked,deactivated_at,arrived_at,created_at,updated_at)
      VALUES(?,?,'confirmed',?,?,?,?,?)`).run(id, locked ? "deactivated" : "active", Number(locked), locked ? now : "", now, now, now);
    db.prepare(`INSERT INTO mailbox_families(id,provider,canonical_address_hash,created_at,updated_at)
      VALUES(?,'domain',?,?,?)`).run(id, emailHash(email), now, now);
    db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,
      valid_from,is_current,legacy_mapping_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'domain',?,1,?,?,?)`).run(id, id, id, encryptSecret(email), emailHash(email), email.split("@")[0], email.split("@")[1], now, id, now, now);
    db.prepare(`INSERT INTO credentials(account_id,openai_subject_hash,source,updated_at) VALUES(?,?,'legacy-v1',?)`).run(id, hash(identity), now);
  }
  seed("account-user", "first@example.test", "membership-first", true);
  seed("subject", "second@example.test", "subject-second");
  seed("mismatch", "conflict@example.test", "original-person");
  seed("different-email", "third@example.test", "membership-third");
  seed("other-label", "fourth@example.test", "membership-fourth");
  db.prepare(`INSERT INTO access_grants(id,account_id,binding_id,public_token_hash,login_identifier_hash,login_identifier_enc,
    password_hash,scope,active,created_at,updated_at) VALUES('mismatch-grant','mismatch','mismatch','mismatch-public',
    'mismatch-login',?,'mismatch-password','current',1,?,?)`).run(encryptSecret("conflict@example.test"), now, now);
  let metadata: any[] = [
    { id: 1, name: "1", credentials: { email: "first@example.test" } },
    { id: 2, name: "1", credentials: { email: "second@example.test" } },
    { id: 3, name: "same-label", credentials: { email: "third@example.test" } },
    { id: 4, name: "same-label", credentials: { email: "fourth@example.test" } },
    { id: 5, name: "conflict", credentials: { email: "conflict@example.test" } },
    { id: 6, name: "compatible-api", type: "apikey", credentials: { base_url: "https://example.test" } },
  ].map((item) => ({ platform: "openai", status: "active", type: "oauth", created_at: now, updated_at: now, ...item }));
  let exported: any[] = [
    { name: "1", credentials: { email: "first@example.test", chatgpt_user_id: "user-first", access_token: jwt("subject-first", "membership-first", "user-first") } },
    { name: "1", credentials: { email: "second@example.test", chatgpt_user_id: "user-second", access_token: jwt("subject-second", "membership-second", "user-second") } },
    { name: "same-label", credentials: { email: "third@example.test", chatgpt_user_id: "user-third", access_token: jwt("subject-third", "membership-third", "user-third") } },
    { name: "same-label", credentials: { email: "fourth@example.test", chatgpt_user_id: "user-fourth", access_token: jwt("subject-fourth", "membership-fourth", "user-fourth") } },
    { name: "conflict", credentials: { email: "conflict@example.test", chatgpt_user_id: "different-person", access_token: jwt("different-person") } },
    { name: "compatible-api", type: "apikey", credentials: { api_key: "fake-gateway-key", base_url: "https://example.test" } },
  ].map((item) => ({ platform: "openai", type: "oauth", ...item }));
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    requests.push(pathname);
    if (pathname.endsWith("/admin/accounts/data")) return new Response(JSON.stringify({ data: { accounts: exported } }));
    if (pathname.endsWith("/admin/accounts")) return new Response(JSON.stringify({ data: { items: metadata, total: metadata.length } }));
    throw new Error("unexpected offline request");
  };
  // Legacy false positives disappear only after the complete successful sync.
  for (const id of [1, 2, 3, 4, 6]) db.prepare(`INSERT INTO pending_reviews(id,review_type,candidate_email_hash,reason,created_at,updated_at)
    VALUES(?,'sub2api_unresolved',?,'old matcher ambiguity',?,?)`).run(stableId("pending-review", "sub2api-unresolved", String(id)), `old-${id}`, now, now);
  const result = await sync.syncSub2ApiAlive();
  assert.deepEqual(result, { total: 6, active: 5, matched: 5, created: 0, rebinds: 0, conflicts: 1, skipped: 0 });
  assert.equal(requests.length, 2);
  assert.deepEqual(db.prepare("SELECT lifecycle_status,identity_status,deactivation_locked FROM gpt_accounts WHERE id='account-user'").get(),
    { lifecycle_status: "deactivated", identity_status: "confirmed", deactivation_locked: 1 });
  assert.deepEqual(db.prepare("SELECT lifecycle_status,identity_status FROM gpt_accounts WHERE id='subject'").get(),
    { lifecycle_status: "active", identity_status: "confirmed" });
  assert.equal((db.prepare("SELECT openai_subject_hash FROM credentials WHERE account_id='subject'").get() as any).openai_subject_hash, hash("subject-second"));
  for (const [id, index] of [["account-user", 0], ["subject", 1], ["different-email", 2], ["other-label", 3]] as const) {
    const row = db.prepare("SELECT access_token_enc FROM credentials WHERE account_id=?").get(id) as any;
    assert.equal(decryptSecret(row.access_token_enc), exported[index].credentials.access_token);
  }
  assert.deepEqual(db.prepare("SELECT lifecycle_status,identity_status FROM gpt_accounts WHERE id='mismatch'").get(),
    { lifecycle_status: "active", identity_status: "confirmed" });
  assert.deepEqual(db.prepare("SELECT active,revoked_at,revoke_reason FROM access_grants WHERE id='mismatch-grant'").get(),
    { active: 1, revoked_at: "", revoke_reason: "" });
  assert.equal((db.prepare("SELECT COUNT(*) n FROM lifecycle_events WHERE account_id='mismatch' AND event_type='account_quarantined'").get() as any).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM pending_reviews WHERE status='pending'").get() as any).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM pending_reviews WHERE review_type='sub2api_unresolved' AND status='resolved'").get() as any).n, 5);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM gpt_accounts").get() as any).n, 5);
  await sync.syncSub2ApiAlive();
  assert.equal((db.prepare("SELECT COUNT(*) n FROM pending_reviews WHERE status='pending'").get() as any).n, 1);
  assert.equal(requests.length, 4);

  // An older confirmed alias for the same account must not replace its
  // selected identity hash and spuriously conflict with the current version.
  db.prepare(`INSERT INTO openai_identity_observations(id,account_id,subject_hash,source,status,first_seen_at,last_seen_at)
    VALUES('older-alias','subject',?,'legacy-v1','confirmed',?,?)`).run(hash("membership-second"), now, now);
  assert.equal(sync.sub2ApiIdentityMaterial(exported[1]).identityHash, hash("subject-second"));

  // Same-token aliases that actually point at different local accounts remain
  // ambiguous; a successful match on just one field cannot hide the conflict.
  seed("cross-alias", "cross@example.test", "cross-existing");
  const alias = sync.sub2ApiIdentityMaterial({ credentials: { access_token: jwt("cross-existing", "membership-first", "user-first") } });
  assert.deepEqual(alias.conflictingAccountIds.sort(), ["account-user", "cross-alias"]);

  // A reused name with a contradictory complete email cannot import under the
  // wrong metadata record, even when that name has only one candidate.
  metadata = [{ ...metadata[0], id: 9, name: "name-reused", credentials: { email: "metadata@example.test" } }];
  exported = [{ platform: "openai", type: "oauth", name: "name-reused", credentials: {
    email: "different-export@example.test", access_token: jwt("export-only"),
  } }];
  const changed = await sync.syncSub2ApiAlive();
  assert.equal(changed.created, 0);
  assert.equal(changed.skipped, 1);
  assert.equal(requests.length, 6);
});
