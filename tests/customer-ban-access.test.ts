import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("停用邮件仅作证据，管理员手动停用后提示并截止新邮件", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-customer-ban-"));
  Object.assign(process.env, { PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "test.sqlite"), ENV_FILE: "/dev/null",
    V2_SESSION_SECRET: "offline-customer-ban-session", CREDENTIAL_ENCRYPTION_KEY: "offline-customer-ban-encryption",
    VIEWER_ADMIN_PASSWORD: "offline-customer-ban-admin", V2_READ_ONLY: "false" });
  let upstreamRequests = 0;
  t.mock.method(globalThis, "fetch", async () => { upstreamRequests += 1; throw new Error("offline only"); });
  const [{ db }, repository, { buildApp }, { encryptSecret }, { sharedMailReader }, { ingestSharedMailEvent }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/repository.js"), import("../src/server/server.js"),
    import("../src/server/crypto.js"), import("../src/server/upstream-mail.js"), import("../src/server/mail-sync.js"),
  ]);
  const app = await buildApp();
  t.after(async () => { await app.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const canary = "OFFLINE-CUSTOMER-BANNED-BODY-TRANSIENT";
  let bodyReads = 0;
  const rows = new Map<string, { address: string; created_at: string }>();
  t.mock.method(sharedMailReader, "byId", async (id: string) => {
    bodyReads += 1;
    const row = rows.get(id)!;
    return { id, ...row, raw: `From: noreply@openai.com\r\nTo: ${row.address}\r\nSubject: Your code\r\n\r\n${canary}` };
  });
  for (const action of ["revoke", "reclaim"] as const) {
    await t.test(action, async () => {
      const email = `banned-${action}@icloud.com`;
      const imported = repository.importAccounts([{ email, accessToken: `offline-at-${action}`, openaiSubject: `offline-${action}`, plan: "plus" }]);
      assert.equal(imported.errors.length, 0);
      const account = repository.listAccounts({ search: email, limit: 10 }).results[0];
      const binding = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(account.id) as any;
      db.prepare("UPDATE email_bindings SET valid_from='2026-09-01T00:00:00.000Z' WHERE id=?").run(binding.id);
      const grant = repository.createCustomerGrant(account.id, binding.id, { password: `offline-password-${action}` });
      const login = await app.inject({ method: "POST", url: "/api/login", payload: { email, password: grant.password } });
      assert.equal(login.statusCode, 200);
      assert.equal(login.json().statusMessage, "");
      const cookie = login.cookies.map((item) => item.name + "=" + item.value).join("; ");
      const banProviderId = action === "revoke" ? "9101" : "9102";
      const banAt = new Date(Date.now() - 1000).toISOString();
      const banRaw = `From: OpenAI <trustandsafety@tm.openai.com>\r\nTo: ${email}\r\nSubject: OpenAI - Access Deactivated\r\nDate: ${new Date(banAt).toUTCString()}\r\n\r\nYour access has been deactivated.`;
      await ingestSharedMailEvent({ id: banProviderId, address: email, raw: banRaw, created_at: banAt });
      assert.deepEqual(db.prepare("SELECT lifecycle_status,deactivation_locked,admin_deactivated_at FROM gpt_accounts WHERE id=?").get(account.id),
        { lifecycle_status: "active", deactivation_locked: 0, admin_deactivated_at: "" });
      const detectedSession = await app.inject({ url: "/api/session", headers: { cookie } });
      assert.equal(detectedSession.statusCode, 200);
      assert.equal(detectedSession.json().statusMessage, "", "ban 邮件检测后取件页不显示停用提醒");
      const beforeId = action === "revoke" ? "before-9001" : "before-9002";
      rows.set(beforeId, { address: email, created_at: banAt });
      db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,recipient_enc,subject,received_at,indexed_at)
        VALUES(?,'shared-mail-api',?,'noreply@openai.com',?,'Before manual stop',?,?)`).run(
        beforeId, beforeId, encryptSecret(email), banAt, banAt,
      );
      db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,visible_to_customer,created_at)
        VALUES(?,?,?,'exact','offline before-stop fixture',1,?)`).run(beforeId, account.id, binding.id, banAt);
      repository.deactivateAccount(account.id, "offline-confirmed-ban");
      const stopped = db.prepare(`SELECT a.admin_deactivated_at,b.receive_disabled_at FROM gpt_accounts a
        JOIN email_bindings b ON b.account_id=a.id AND b.is_current=1 WHERE a.id=?`).get(account.id) as any;
      assert.ok(stopped.admin_deactivated_at);
      assert.equal(stopped.receive_disabled_at, stopped.admin_deactivated_at);
      const createdAt = new Date(Date.parse(stopped.admin_deactivated_at) + 1000).toISOString();
      const afterId = action === "revoke" ? "after-9001" : "after-9002";
      rows.set(afterId, { address: email, created_at: createdAt });
      db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,recipient_enc,subject,received_at,indexed_at)
        VALUES(?,'shared-mail-api',?,'noreply@openai.com',?,'Your code',?,?)`).run(afterId, afterId, encryptSecret(email), createdAt, createdAt);
      db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,visible_to_customer,created_at)
        VALUES(?,?,?,'exact','offline fixture',1,?)`).run(afterId, account.id, binding.id, createdAt);
      const readStart = bodyReads;
      const preset = await app.inject("/api/preset?m=" + encodeURIComponent(grant.publicToken));
      assert.equal(preset.statusCode, 200);
      assert.equal(preset.json().password, grant.password);
      const session = await app.inject({ url: "/api/session", headers: { cookie } });
      assert.equal(session.statusCode, 200);
      assert.equal(session.json().lifecycleStatus, "deactivated");
      assert.equal(session.json().statusMessage, "管理员已停用该账号；仅显示停用前且在授权范围内的邮件，之后的新邮件不再显示。");
      assert.deepEqual(Object.keys(session.json()).sort(), ["ok", "label", "email", "lifecycleStatus", "hidePromotion", "statusMessage"].sort());
      assert.equal(session.headers["cache-control"], "no-store");
      const list = await app.inject({ url: "/api/mails", headers: { cookie } });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json().results.map((row: any) => row.id), [beforeId]);
      assert.equal(bodyReads, readStart, "preset/session/list do not fetch mail bodies");
      assert.equal((await app.inject({ url: "/api/mail-detail?id=" + afterId, headers: { cookie } })).statusCode, 404);
      assert.equal(bodyReads, readStart);
      const detail = await app.inject({ url: "/api/mail-detail?id=" + beforeId, headers: { cookie } });
      assert.equal(detail.statusCode, 200);
      assert.ok(detail.body.includes(canary));
      assert.equal(bodyReads, readStart + 1);
      if (action === "revoke") assert.equal(repository.revokeCustomerGrant(account.id, grant.grantId), true);
      else repository.recycleAccount(account.id, `replacement-${action}@icloud.com`);
      assert.equal((await app.inject("/api/preset?m=" + encodeURIComponent(grant.publicToken))).statusCode, 404);
      assert.equal((await app.inject({ method: "POST", url: "/api/login", payload: { email, password: grant.password } })).statusCode, 401);
      for (const url of ["/api/session", "/api/mails", "/api/mail-detail?id=" + beforeId]) {
        assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 401);
      }
      assert.equal(bodyReads, readStart + 1, "revoked sessions never call upstream");
    });
  }
  assert.equal(upstreamRequests, 0);
  assert.equal(db.serialize().includes(Buffer.from(canary)), false);
});
