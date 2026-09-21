import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function jwt(email: string, sub: string, plan = "free", stamp = 1): string {
  return [Buffer.from('{"alg":"RS256"}').toString("base64url"), Buffer.from(JSON.stringify({
    iss: "https://auth.openai.com", sub, email, iat: stamp, "https://api.openai.com/auth": { chatgpt_plan_type: plan },
  })).toString("base64url"), "offline-signature"].join(".");
}

test("offline V1 business migration preserves locks, evidence, recycle rules and OAuth semantics", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opus-offline-business-"));
  const snapshot = path.join(directory, "snapshot.json");
  fs.writeFileSync(snapshot, "[]");
  Object.assign(process.env, { PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "test.sqlite"),
    V1_CONFIG_FILE: snapshot, V1_ENV_FILE: "", V1_BACKUPS_DIR: "", V1_MAIL_INDEX_FILE: "", V1_CHANGE_OUTBOX_FILE: "",
    V1_MAIL_FLAG_FILE: "", V1_USAGE_AUDIT_FILE: "", V2_READ_ONLY: "false", V2_ACCOUNT_AUTHORITY: "v2",
    V2_SESSION_SECRET: "offline-session-key", CREDENTIAL_ENCRYPTION_KEY: "offline-encryption-key" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network forbidden in business tests"); };
  const [{ db }, repository, transitions, native, { syncFromV1 }, association, secrets] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/repository.js"), import("../src/server/account-transitions.js"),
    import("../src/server/native-operations.js"), import("../src/server/legacy-import.js"),
    import("../src/server/association.js"), import("../src/server/crypto.js"),
  ]);
  t.after(() => { db.close(); globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true }); });
  const create = (name: string, withToken = true, plan = "free") => {
    const email = `${name}@icloud.com`;
    const result = repository.importAccounts([{ email, plan, ...(withToken ? { accessToken: jwt(email, name, plan), refreshToken: `offline-refresh-${name}` } : {}) }]);
    assert.equal(result.errors.length, 0);
    return db.prepare("SELECT a.*,b.id binding_id FROM gpt_accounts a JOIN email_bindings b ON b.account_id=a.id WHERE b.email_hash=? AND b.is_current=1")
      .get(association.emailHash(email)) as any;
  };
  const index = (owner: any, id: string, subject: string, receivedAt: string) => {
    db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,subject,received_at,indexed_at) VALUES(?,'test',?,?,?,?)`)
      .run(id, id, subject, receivedAt, receivedAt);
    db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,created_at) VALUES(?,?,?,'exact','offline',?)`)
      .run(id, owner.id, owner.binding_id, receivedAt);
  };

  await t.test("migration preserves customer access after ban and cannot reopen explicit revocation", () => {
    const marker = "DO_NOT_PERSIST_EMAIL_CONTENT".repeat(2048);
    const records = [{ id: "legacy-sold", email: "legacy-sold@icloud.com", sold: true,
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
      raw: marker, body: marker, html: marker, nested: { mime: marker } }];
    fs.writeFileSync(snapshot, JSON.stringify(records));
    syncFromV1();
    const binding = db.prepare("SELECT * FROM email_bindings WHERE legacy_mapping_id='legacy-sold'").get() as any;
    transitions.freezeAccountTransition(binding.account_id, "mail", "test", "2026-08-20T12:00:00.123Z");
    const first = db.prepare("SELECT * FROM access_grants WHERE legacy_public_token=1 AND binding_id=?").get(binding.id) as any;
    assert.equal(first.scope, "current");
    assert.equal(first.active, 1);
    assert.equal(first.visible_to, "");
    syncFromV1();
    const next = db.prepare("SELECT * FROM access_grants WHERE id=?").get(first.id) as any;
    assert.equal(next.scope, first.scope);
    assert.equal(next.visible_to, first.visible_to);
    assert.equal((db.prepare("SELECT status FROM sales WHERE account_id=?").get(binding.account_id) as any).status, "active");
    transitions.revokeGrantTransition(binding.account_id, first.id);
    syncFromV1();
    assert.equal((db.prepare("SELECT active FROM access_grants WHERE id=?").get(first.id) as any).active, 0);
    const manifest = db.prepare("SELECT payload_json FROM raw_import_records").get() as any;
    assert.ok(manifest.payload_json.length < 512);
    assert.deepEqual(Object.keys(JSON.parse(manifest.payload_json)).sort(), ["emailHash", "id", "sourceType", "updatedAt"]);
    assert.equal(manifest.payload_json.includes("DO_NOT_PERSIST"), false);
    fs.writeFileSync(snapshot, "[]");
  });

  await t.test("a ban preserves customer visibility while its earliest confirmed timestamp stays sticky", () => {
    const owner = create("millisecond");
    const grant = repository.createCustomerGrant(owner.id, owner.binding_id, { password: "offline-customer-pass" });
    const used = repository.grantByPublicToken(grant.publicToken)!;
    db.prepare("UPDATE access_grants SET visible_from='2026-01-01T00:00:00.000Z' WHERE id=?").run(used.id);
    index(owner, "ban-last", "OpenAI - Access Deactivated", "2026-08-20T12:00:00.123Z");
    index(owner, "ban-next", "Temporary ChatGPT login code", "2026-08-20T12:00:00.124Z");
    transitions.freezeAccountTransition(owner.id, "mail", "test", "2026-08-20T12:00:00.123Z");
    const retained = repository.grantById(used.id)!;
    assert.deepEqual(repository.listCustomerMails(retained, 0, 20).results.map((mail) => mail.id).sort(), ["ban-last", "ban-next"]);
    assert.ok(repository.customerMailDetail(retained, "ban-next"));
    transitions.freezeAccountTransition(owner.id, "late duplicate", "test", "2026-08-21T00:00:00.000Z");
    assert.equal(repository.grantById(used.id)?.visibleTo, "");
    transitions.freezeAccountTransition(owner.id, "earlier evidence", "test", "2026-08-19T00:00:00.000Z");
    assert.equal(repository.grantById(used.id)?.visibleTo, "");
    assert.equal((db.prepare("SELECT deactivated_at FROM gpt_accounts WHERE id=?").get(owner.id) as any).deactivated_at, "2026-08-19T00:00:00.000Z");
  });

  await t.test("four recycle modes inherit V1 shared-mail and paid/hidden-tag protection", () => {
    const sold = create("sold-recycle");
    const grant = repository.createCustomerGrant(sold.id, sold.binding_id, { password: "offline-customer-pass" });
    repository.grantByPublicToken(grant.publicToken);
    db.prepare("UPDATE access_grants SET visible_from=? WHERE id=?").run(new Date(Date.now() - 9 * 86400_000).toISOString(), grant.grantId);
    transitions.freezeAccountTransition(sold.id, "old ban", "test", new Date(Date.now() - 8 * 86400_000).toISOString());
    const child = repository.recycleAccountByMode(sold.id, "deactivated");
    assert.equal(child.replacement.deactivationLocked, false);
    assert.equal(repository.revealCredentials(child.replacement.id), null);
    assert.equal(repository.grantByPublicToken(grant.publicToken), null);
    const free = create("free-recycle");
    assert.equal(repository.recycleAccountByMode(free.id, "untagged_free").replacement.plan, "free");
    const invalid = create("invalid-recycle");
    db.prepare("UPDATE credential_versions SET validity_status='invalid' WHERE account_id=?").run(invalid.id);
    assert.equal(repository.recycleAccountByMode(invalid.id, "invalid_at").mode, "invalid_at");
    const hidden = create("hidden-recycle");
    db.prepare("INSERT INTO account_business_evidence(account_id,hidden_tags_json,updated_at) VALUES(?,?,?)")
      .run(hidden.id, JSON.stringify([{ ipCountry: "US", billingCountry: "US", billingCurrency: "USD" }]), new Date().toISOString());
    assert.throws(() => repository.recycleAccountByMode(hidden.id, "untagged_free"), /标记/);
    const unknown = create("unknown-recycle", false);
    assert.throws(() => repository.recycleAccountByMode(unknown.id, "untagged_free"), /证据/);
    const direct = create("direct-recycle");
    db.prepare(`INSERT INTO mailbox_connections(id,binding_id,provider,secret_ref,status,created_at,updated_at)
      VALUES('direct',?,'external','v2:local','active',?,?)`).run(direct.binding_id, new Date().toISOString(), new Date().toISOString());
    assert.throws(() => repository.recycleAccountByMode(direct.id, "untagged_free"), /共享收件池/);
    const pending = create("pending-alias", false);
    db.prepare("UPDATE gpt_accounts SET note='automyai OpenAI signup pool pending' WHERE id=?").run(pending.id);
    db.prepare("INSERT INTO account_origins(account_id,source_type,source_id,is_auto,first_seen_at) VALUES(?,'test','test',1,?)").run(pending.id, new Date().toISOString());
    assert.equal(repository.recycleAccountByMode(pending.id, "alias_rotate").mode, "alias_rotate");
  });

  await t.test("usage evidence survives narrower index and only exact V1 activity subjects count", () => {
    const owner = create("usage-audit", true, "plus");
    index(owner, "usage-billing", "Welcome to ChatGPT Plus", "2026-08-01T00:00:00.000Z");
    index(owner, "usage-rebind", "Your email address was changed", "2026-08-03T00:00:00.000Z");
    native.runUsageAudit();
    assert.equal((db.prepare("SELECT suspected_unused FROM gpt_accounts WHERE id=?").get(owner.id) as any).suspected_unused, 1);
    index(owner, "usage-code", "ChatGPT の一時的な認証コード", "2026-08-04T00:00:00.000Z");
    native.runUsageAudit();
    assert.equal((db.prepare("SELECT suspected_unused FROM gpt_accounts WHERE id=?").get(owner.id) as any).suspected_unused, 0);
    db.prepare("DELETE FROM mail_ownership_claims WHERE account_id=?").run(owner.id);
    native.runUsageAudit();
    assert.equal((db.prepare("SELECT billing_started_at FROM account_business_evidence WHERE account_id=?").get(owner.id) as any).billing_started_at, "2026-08-01T00:00:00.000Z");
  });

  await t.test("batch input preserves every line and rejects conflicting same-account tokens", () => {
    const a = create("batch-a");
    const b = create("batch-b");
    const lines = [JSON.stringify({ email: "batch-a@icloud.com", accessToken: jwt("batch-a@icloud.com", "batch-a", "free", 2) }),
      JSON.stringify({ email: "batch-b@icloud.com", accessToken: jwt("batch-b@icloud.com", "batch-b", "free", 2) })].join("\n");
    const preview = native.previewOauthBatch(lines);
    assert.equal(preview.total, 2);
    assert.equal(preview.ready, 2);
    assert.equal(native.applyOauthBatch(lines, preview.batchHash, true).applied, 2);
    const conflicts = [2, 3].map((stamp) => JSON.stringify({ email: "batch-a@icloud.com", accessToken: jwt("batch-a@icloud.com", "batch-a", "free", stamp) })).join("\n");
    assert.equal(native.previewOauthBatch(conflicts).conflicts, 2);
    const rtOnly = native.previewOauthBatch("offline-refresh-batch-b");
    assert.equal(rtOnly.ready, 1);
    assert.ok(a.id && b.id);
  });

  await t.test("explicit source import rebinds atomically and stores mailbox credentials independently", () => {
    const owner = create("explicit-source");
    const before = repository.revealCredentials(owner.id)!.accessToken;
    const target = "different-local@owned.example";
    const result = repository.importAccounts([{ email: target, rebindPreviousEmail: "explicit-source@icloud.com",
      accessToken: jwt(target, "explicit-source", "free", 2), address: "https://mailbox.example/read?secret=offline-only" }]);
    assert.equal(result.rebound, 1);
    assert.equal(result.errors.length, 0);
    assert.notEqual(repository.revealCredentials(owner.id)!.accessToken, before);
    const connection = db.prepare(`SELECT mc.* FROM mailbox_connections mc JOIN email_bindings b ON b.id=mc.binding_id
      WHERE b.account_id=? AND b.is_current=1`).get(owner.id) as any;
    assert.match(connection.secret_ref, /^v2:/);
    assert.deepEqual(JSON.parse(secrets.decryptSecret(connection.credentials_enc)), { address: "https://mailbox.example/read?secret=offline-only" });
    const rejected = repository.importAccounts([{ email: "rollback@owned.example", rebindPreviousEmail: target,
      accessToken: jwt("rollback@owned.example", "explicit-source", "free", 3), address: "x".repeat(17000) }]);
    assert.equal(rejected.imported, 0);
    assert.equal(rejected.rebound, 0);
    assert.equal(repository.getAccountDetail(owner.id)!.primaryEmail, target);
    const password = repository.importAccounts([{ email: "password-only@icloud.com", openaiPassword: "offline-password-only" }]);
    assert.equal(password.imported, 1);
    const passwordOwner = db.prepare("SELECT account_id FROM email_bindings WHERE email_hash=?").get(association.emailHash("password-only@icloud.com")) as any;
    assert.equal(repository.revealCredentials(passwordOwner.account_id)?.openaiPassword, "offline-password-only");
    assert.equal(db.prepare("SELECT 1 FROM credential_versions WHERE account_id=?").get(passwordOwner.account_id), undefined);
  });

  await t.test("OAuth result validates refreshed credentials and cannot overwrite concurrent admin changes", async () => {
    const rotated = create("oauth-rotated");
    const edited = create("oauth-edited");
    const banned = create("oauth-banned");
    const job = "offline-health-job";
    const now = new Date().toISOString();
    db.prepare("INSERT INTO oauth_health_jobs(id,status,created_at,updated_at) VALUES(?,'queued',?,?)").run(job, now, now);
    const newAt = jwt("oauth-rotated@icloud.com", "oauth-rotated", "free", 2);
    await native.runOauthHealth(job, async (material) => {
      if (material.accessToken === jwt("oauth-rotated@icloud.com", "oauth-rotated")) return {
        status: "alive", accessStatus: "alive", refreshStatus: "alive", detail: "refreshed_at_verified",
        rotatedTokens: { accessToken: newAt, refreshToken: "new-rt-offline", idToken: "new-id-offline" },
      };
      if (material.accessToken === jwt("oauth-edited@icloud.com", "oauth-edited")) repository.saveAccountCredentials(edited.id, { accessToken: jwt("oauth-edited@icloud.com", "oauth-edited", "free", 3) });
      if (material.accessToken === jwt("oauth-banned@icloud.com", "oauth-banned")) transitions.freezeAccountTransition(banned.id);
      return { status: "dead", accessStatus: "invalid", refreshStatus: "invalid", detail: "rt_http_400" };
    });
    assert.equal(repository.revealCredentials(rotated.id)?.accessToken, newAt);
    assert.equal(repository.revealCredentials(rotated.id)?.refreshToken, "new-rt-offline");
    const adminCurrent = db.prepare(`SELECT cv.validity_status FROM account_current_credentials cc JOIN credential_versions cv ON cv.id=cc.credential_version_id WHERE cc.account_id=?`).get(edited.id) as any;
    assert.equal(adminCurrent.validity_status, "alive");
    assert.equal((db.prepare("SELECT deactivation_locked FROM gpt_accounts WHERE id=?").get(banned.id) as any).deactivation_locked, 1);
    const publicResults = JSON.stringify(db.prepare("SELECT * FROM oauth_health_results WHERE job_id=?").all(job));
    assert.equal(publicResults.includes(newAt), false);
    assert.equal(publicResults.includes("new-rt-offline"), false);
    assert.match(publicResults, /credential_changed_during_probe/);
    const encrypted = db.prepare("SELECT refresh_token_enc FROM credentials WHERE account_id=?").get(rotated.id) as any;
    assert.equal(secrets.decryptSecret(encrypted.refresh_token_enc), "new-rt-offline");
  });
});
