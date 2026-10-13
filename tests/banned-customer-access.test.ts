import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("banned customers retain links and sessions until an administrator reclaims or revokes access", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opus-banned-customer-"));
  Object.assign(process.env, { PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "test.sqlite"), ENV_FILE: "/dev/null",
    V2_SESSION_SECRET: "banned-customer-test-session", CREDENTIAL_ENCRYPTION_KEY: "banned-customer-test-encryption",
    VIEWER_ADMIN_PASSWORD: "banned-customer-test-admin", V2_READ_ONLY: "false", V2_CF_D1_READ_TOKEN: "" });
  const [{ db }, repository, transitions, { buildApp }, { sharedMailReader }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/repository.js"), import("../src/server/account-transitions.js"),
    import("../src/server/server.js"), import("../src/server/upstream-mail.js"),
  ]);
  const app = await buildApp();
  t.after(async () => { await app.close(); (await db.close()); fs.rmSync(directory, { recursive: true, force: true }); });
  const create = async (email: string) => {
    assert.equal((await repository.importAccounts([{ email }])).imported, 1);
    const account = (await repository.listAccounts({ search: email, limit: 10 })).results.find((r) => r.primaryEmail === email)!;
    const binding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(account.id)) as any;
    (await db.prepare("UPDATE email_bindings SET valid_from='2026-08-01T00:00:00.000Z' WHERE id=?").run(binding.id));
    const grant = (await repository.createCustomerGrant(account.id, binding.id, { password: "fake-customer-password" }));
    return { accountId: account.id, bindingId: binding.id, grant };
  };
  const login = async (email: string) => {
    const result = await app.inject({ method: "POST", url: "/api/login", payload: { email, password: "fake-customer-password" } });
    assert.equal(result.statusCode, 200);
    const cookie = result.cookies.find((c) => c.name === "mail_opus_v2_customer")!;
    return `${cookie.name}=${cookie.value}`;
  };
  let bodyReads = 0;
  sharedMailReader.byId = async (id: string) => {
    bodyReads++;
    assert.equal(id, "851");
    return { id, created_at: "2026-09-08 12:00:01", address: "used@icloud.com",
      raw: "From: noreply@openai.com\r\nTo: used@icloud.com\r\nSubject: Appeal received\r\n\r\nThis confirmation remains readable after a GPT ban." };
  };

  const used = (await create("used@icloud.com"));
  const cookie = await login("used@icloud.com");
  const grantBefore = (await db.prepare("SELECT * FROM access_grants WHERE id=?").get(used.grant.grantId));
  const saleBefore = (await db.prepare("SELECT * FROM sales WHERE account_id=?").get(used.accountId));
  (await transitions.freezeAccountTransition(used.accountId, "upstream_notice", "test", "2026-09-08T12:00:00.000Z"));
  assert.deepEqual((await db.prepare("SELECT * FROM access_grants WHERE id=?").get(used.grant.grantId)), grantBefore);
  assert.deepEqual((await db.prepare("SELECT * FROM sales WHERE account_id=?").get(used.accountId)), saleBefore);
  assert.equal((await app.inject({ url: "/api/session", headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/preset?m=${used.grant.publicToken}` })).statusCode, 200);
  assert.ok((await repository.authenticateCustomer("used@icloud.com", "fake-customer-password")));
  (await db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,subject,received_at,indexed_at)
    VALUES('after-ban','shared-mail-api','851','noreply@openai.com','Appeal received','2026-09-08T12:00:01.000Z','2026-09-08T12:00:01.000Z')`).run());
  (await db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,visible_to_customer,created_at)
    VALUES('after-ban',?,?,'exact','offline fixture',1,'2026-09-08T12:00:01.000Z')`).run(used.accountId, used.bindingId));
  const listed = await app.inject({ url: "/api/mails", headers: { cookie } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().results.some((r: any) => r.id === "after-ban"), true);
  assert.equal(bodyReads, 0);
  const detail = await app.inject({ url: "/api/mail-detail?id=after-ban", headers: { cookie } });
  assert.equal(detail.statusCode, 200);
  assert.equal(bodyReads, 1);

  await t.test("banned accounts can issue customer links through the API; explicit reclaim still blocks issuance", async () => {
    const email = "first-after-ban@icloud.com";
    assert.equal((await repository.importAccounts([{ email }])).imported, 1);
    const account = (await repository.listAccounts({ search: email, limit: 10 })).results.find(r => r.primaryEmail === email)!;
    const binding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(account.id)) as any;
    (await transitions.freezeAccountTransition(account.id, "notice", "test", "2026-09-08T12:00:00.000Z"));
    const before = (await db.prepare("SELECT deactivation_locked,deactivated_at FROM gpt_accounts WHERE id=?").get(account.id));
    const current = (await repository.listAccounts({ search: email, limit: 10 })).results.find(r => r.id === account.id)!;
    assert.equal(current.sellable, true); assert.deepEqual(current.sellBlockers, []);
    const url = `/api/v2/admin/accounts/${account.id}/grants`;
    assert.equal((await app.inject({ method: "POST", url, payload: { bindingId: binding.id } })).statusCode, 401);
    const adminLogin = await app.inject({ method: "POST", url: "/api/v2/admin/login", payload: { password: "banned-customer-test-admin" } });
    const admin = adminLogin.cookies.find(c => c.name === "mail_opus_v2_admin")!;
    const headers = { cookie: `${admin.name}=${admin.value}` };
    const created = await app.inject({ method: "POST", url, headers, payload: { bindingId: binding.id, password: "fake-customer-password" } });
    assert.equal(created.statusCode, 200, created.body);
    const access = (await repository.getCurrentCustomerExport(account.id))!;
    assert.equal(access.available, true);
    assert.ok((await repository.authenticateCustomer(email, "fake-customer-password")));
    assert.deepEqual((await db.prepare("SELECT deactivation_locked,deactivated_at FROM gpt_accounts WHERE id=?").get(account.id)), before);
    (await transitions.recycleAccountTransition(account.id, "first-after-ban+fresh@icloud.com"));
    assert.equal((await repository.authenticateCustomer(email, "fake-customer-password")), null);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { bindingId: binding.id } })).statusCode, 400);
    // Even inconsistent imported current-binding flags cannot bypass retirement.
    (await db.prepare("UPDATE email_bindings SET is_current=1 WHERE id=?").run(binding.id));
    await assert.rejects(async () => (await repository.createCustomerGrant(account.id, binding.id)), /已回收/);
    (await db.prepare("UPDATE email_bindings SET is_current=0 WHERE id=?").run(binding.id));
  });

  // Historical grants are also revoked when reclaiming this identity, while
  // the new identity receives no customer permissions or credentials.
  (await db.prepare(`INSERT INTO access_grants(id,account_id,binding_id,public_token_hash,login_identifier_hash,login_identifier_enc,
    password_hash,scope,visible_from,visible_to,active,created_at,updated_at)
    VALUES('historical-grant',?,?,'old-public','old-login','','old-password','historical',
      '2026-08-01T00:00:00.000Z','2026-08-02T00:00:00.000Z',1,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z')`)
    .run(used.accountId, used.bindingId));
  const child = (await transitions.recycleAccountTransition(used.accountId, "used+oaifresh@icloud.com"));
  assert.equal((await repository.grantByPublicToken(used.grant.publicToken)), null);
  assert.equal((await repository.grantById("historical-grant")), null);
  assert.equal((await repository.authenticateCustomer("used@icloud.com", "fake-customer-password")), null);
  assert.equal((await app.inject({ url: "/api/session", headers: { cookie } })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/mails", headers: { cookie } })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/mail-detail?id=after-ban", headers: { cookie } })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/preset?m=${used.grant.publicToken}` })).statusCode, 404);
  assert.equal(bodyReads, 1);
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM access_grants WHERE account_id=? AND active=1").get(child.replacementId)) as any).n, 0);
  assert.equal(((await db.prepare("SELECT deactivation_locked FROM gpt_accounts WHERE id=?").get(used.accountId)) as any).deactivation_locked, 1);
  assert.equal(((await db.prepare("SELECT deactivation_locked FROM gpt_accounts WHERE id=?").get(child.replacementId)) as any).deactivation_locked, 0);

  const unused = (await create("unused@icloud.com"));
  const untouched = (await db.prepare("SELECT * FROM access_grants WHERE id=?").get(unused.grant.grantId));
  (await transitions.freezeAccountTransition(unused.accountId, "unknown_date", "test", ""));
  assert.deepEqual((await db.prepare("SELECT * FROM access_grants WHERE id=?").get(unused.grant.grantId)), untouched);
  const unusedCookie = await login("unused@icloud.com");
  assert.equal((await app.inject({ url: "/api/session", headers: { cookie: unusedCookie } })).statusCode, 200);
  assert.equal((await transitions.revokeGrantTransition(unused.accountId, unused.grant.grantId)), true);
  assert.equal((await app.inject({ url: "/api/session", headers: { cookie: unusedCookie } })).statusCode, 401);
  assert.equal((await repository.grantByPublicToken(unused.grant.publicToken)), null);
  assert.equal((await repository.authenticateCustomer("unused@icloud.com", "fake-customer-password")), null);
  assert.equal(bodyReads, 1);

  const rebound = (await create("rebound@icloud.com"));
  assert.equal(((await db.prepare("SELECT first_used_at FROM access_grants WHERE id=?").get(rebound.grant.grantId)) as any).first_used_at, "");
  (await transitions.freezeAccountTransition(rebound.accountId, "upstream_notice", "test", "2026-09-08T12:00:00.000Z"));
  const cutoff = "2026-09-08T13:00:00.000Z";
  const next = (await transitions.rebindAccountTransition(rebound.accountId, "rebound@ai-mail.tech", {
    source: "sub2api-sync", changedAt: cutoff,
  }));
  const historical = (await db.prepare("SELECT * FROM access_grants WHERE id=?").get(rebound.grant.grantId)) as any;
  assert.deepEqual({ active: historical.active, scope: historical.scope, visibleTo: historical.visible_to,
    firstUsed: historical.first_used_at, revokedAt: historical.revoked_at, revokeReason: historical.revoke_reason },
  { active: 1, scope: "historical", visibleTo: cutoff, firstUsed: "", revokedAt: "", revokeReason: "" });
  assert.equal((await app.inject({ url: `/api/preset?m=${rebound.grant.publicToken}` })).statusCode, 200);
  const reboundCookie = await login("rebound@icloud.com");
  for (const [id, bindingId, at] of [
    ["rebind-old", rebound.bindingId, "2026-09-08T12:30:00.000Z"],
    ["rebind-old-outside", rebound.bindingId, cutoff],
    ["rebind-new", next.bindingId, "2026-09-08T13:30:00.000Z"],
  ]) {
    (await db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,subject,received_at,indexed_at)
      VALUES(?,'test',?,'Offline rebind mail',?,?)`).run(id, id, at, at));
    (await db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,created_at)
      VALUES(?,?,?,'exact','offline fixture',?)`).run(id, rebound.accountId, bindingId, at));
  }
  const reboundList = await app.inject({ url: "/api/mails", headers: { cookie: reboundCookie } });
  assert.equal(reboundList.statusCode, 200);
  assert.deepEqual(reboundList.json().results.map((r: any) => r.id), ["rebind-old"]);
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM access_grants WHERE binding_id=? AND active=1 AND scope!='admin_only'").get(next.bindingId)) as any).n, 0);
  (await transitions.recycleAccountTransition(rebound.accountId, "rebound+fresh@ai-mail.tech"));
  assert.equal((await repository.grantByPublicToken(rebound.grant.publicToken)), null);
  assert.equal((await app.inject({ url: "/api/session", headers: { cookie: reboundCookie } })).statusCode, 401);
  assert.equal(bodyReads, 1);
});
