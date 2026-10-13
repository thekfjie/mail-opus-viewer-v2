import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("mail ownership accepts confirmed historical identity and rejects retained credential conflicts", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-review-rejected-"));
  Object.assign(process.env, { PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "test.sqlite"), ENV_FILE: "/dev/null",
    V2_SESSION_SECRET: "test-rejected-session", CREDENTIAL_ENCRYPTION_KEY: "test-rejected-encryption" });
  const [{ db }, { encryptSecret }, { emailHash, stableId }, { noticeEvidence, resolveNoticeEvidence }, { ingestSharedMailEvent }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/crypto.js"), import("../src/server/association.js"),
    import("../src/server/mail-account-evidence.js"), import("../src/server/mail-sync.js"),
  ]);
  t.after(async () => { (await db.close()); fs.rmSync(directory, { recursive: true, force: true }); });
  const at = "2026-09-01T00:00:00.000Z";
  const subject = "OpenAI - Access Deactivated";
  const hash = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");
  const user = { known: "11111111-1111-4111-8111-111111111111", rejected: "22222222-2222-4222-8222-222222222222",
    unknown: "33333333-3333-4333-8333-333333333333", obsolete: "44444444-4444-4444-8444-444444444444" };
  (await db.prepare("INSERT INTO gpt_accounts(id,lifecycle_status,arrived_at,created_at,updated_at) VALUES('account','active',?,?,?)").run(at, at, at));
  (await db.prepare("INSERT INTO mailbox_families(id,provider,canonical_address_hash,created_at,updated_at) VALUES('family','domain','family',?,?)").run(at, at));
  (await db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,valid_from,
    legacy_mapping_id,created_at,updated_at) VALUES('binding','account','family',?,?,'owner','example.test','domain',?,'binding',?,?)`)
    .run(encryptSecret("owner@example.test"), emailHash("owner@example.test"), at, at, at));
  (await db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,recipient_pattern,valid_from,source,created_at,updated_at)
    VALUES('rule','binding','^owner@example\\.test$',?,'test',?,?)`).run(at, at, at));
  (await db.prepare("INSERT INTO credentials(account_id,openai_subject_hash,source,updated_at) VALUES('account',?,'test',?)").run(hash("confirmed-membership"), at));
  const version = async (id: string, membership: string, userId: string, status: string, retired = "") => {
    const token = `fake.${Buffer.from(JSON.stringify({ sub: `subject-${id}`, "https://api.openai.com/auth": {
      chatgpt_account_user_id: membership, chatgpt_user_id: userId,
    } })).toString("base64url")}.fake`;
    (await db.prepare(`INSERT INTO credential_versions(id,account_id,subject_hash,access_token_enc,token_fingerprint,first_seen_at,last_seen_at,
      validity_status,retired_reason,source,created_at,updated_at) VALUES(?,'account',?,?,?,?,?,?,?,'test',?,?)`)
      .run(id, hash(membership), encryptSecret(token), hash(token), at, at, status, retired, at, at));
  };
  (await version("valid-history", "confirmed-membership", user.known, "invalid", "superseded"));
  (await version("rejected", "rejected-membership", user.rejected, "conflict"));
  // Even a matching subject hash cannot turn a rejected version into proof.
  (await version("rejected-same-hash", "confirmed-membership", user.unknown, "conflict"));
  (await version("unconfirmed", "unconfirmed-membership", user.obsolete, "unknown"));
  const evidence = (id?: string) => noticeEvidence(subject, "trustandsafety@tm.openai.com",
    `OpenAI account associated with owner@example.test${id ? ` (User ID: ${id})` : ""}.`);
  assert.deepEqual((await resolveNoticeEvidence(evidence(user.known), ["account"])), { accountId: "account", bindingId: "binding", conflict: false });
  assert.deepEqual((await resolveNoticeEvidence(evidence(), ["account"])), { accountId: "account", bindingId: "binding", conflict: false });
  for (const id of [user.rejected, user.unknown, user.obsolete]) {
    assert.deepEqual((await resolveNoticeEvidence(evidence(id), ["account"])), { accountId: "", bindingId: "", conflict: true });
  }
  (await db.prepare(`INSERT INTO openai_identity_observations(id,account_id,subject_hash,source,status,first_seen_at,last_seen_at)
    VALUES('rejected-observation','account',?,'test','rejected',?,?)`).run(hash("unconfirmed-membership"), at, at));
  assert.equal((await resolveNoticeEvidence(evidence(user.obsolete), ["account"])).conflict, true);
  (await db.prepare("UPDATE openai_identity_observations SET status='confirmed' WHERE id='rejected-observation'").run());
  assert.equal((await resolveNoticeEvidence(evidence(user.obsolete), ["account"])).accountId, "account");
  (await db.prepare("UPDATE credential_versions SET retired_reason='identity_conflict' WHERE id='unconfirmed'").run());
  assert.equal((await resolveNoticeEvidence(evidence(user.obsolete), ["account"])).conflict, true);
  const marker = "MAIL-REJECTED-EVIDENCE-NO-BODY-PERSISTENCE";
  await ingestSharedMailEvent({ id: "811", created_at: "2026-09-09 00:00:00", address: "owner@example.test",
    raw: `From: trustandsafety@tm.openai.com\r\nTo: owner@example.test\r\nSubject: ${subject}\r\n\r\nOpenAI account associated with owner@example.test (User ID: ${user.rejected}). ${marker}` });
  assert.equal(((await db.prepare("SELECT deactivation_locked FROM gpt_accounts WHERE id='account'").get()) as any).deactivation_locked, 0);
  const messageId = stableId("mail-message", "shared-mail-api", "811");
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM mail_ownership_claims WHERE message_id=? AND visible_to_customer=1").get(messageId)) as any).n, 1);
  assert.equal((await db.prepare("SELECT status FROM pending_reviews WHERE id=?").get(stableId("mail-review", messageId))), undefined);
  assert.equal(db.serialize().includes(Buffer.from(marker)), false);
});
