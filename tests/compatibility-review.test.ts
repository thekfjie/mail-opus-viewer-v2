import { databaseSnapshot } from "./helpers/database-snapshot.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("V1 compatibility preserves routing, cleanup state and customer password revocation", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-compatibility-review-"));
  Object.assign(process.env, {
    PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "test.sqlite"), ENV_FILE: "/dev/null",
    V2_SESSION_SECRET: "fake-compat-session", CREDENTIAL_ENCRYPTION_KEY: "fake-compat-encryption",
    VIEWER_ADMIN_PASSWORD: "fake-admin-password", IMPORT_API_KEY: "fake-import-key", PUBLIC_ORIGIN: "https://mail.example.test",
    V2_READ_ONLY: "false",
  });
  let networkRequests = 0;
  t.mock.method(globalThis, "fetch", async () => { networkRequests += 1; throw new Error("offline transport only"); });
  const [{ buildApp }, { db }, compatibility, repository, crypto, upstream] = await Promise.all([
    import("../src/server/server.js"), import("../src/server/db.js"), import("../src/server/compatibility-state.js"),
    import("../src/server/repository.js"), import("../src/server/crypto.js"), import("../src/server/upstream-mail.js"),
  ]);
  const app = await buildApp();
  t.after(async () => { await app.close(); (await db.close()); fs.rmSync(directory, { recursive: true }); });
  const headers = { "x-api-key": "fake-import-key" };

  await t.test("legacy admin readers can use their cookie and temporary rebind IDs", async () => {
    const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "fake-admin-password" } });
    const alias = login.cookies.find((cookie) => cookie.name === "mail_opus_admin");
    assert.ok(alias);
    assert.ok(login.cookies.find((cookie) => cookie.name === "mail_opus_v2_admin"));
    const cookie = alias.name + "=" + alias.value;
    assert.equal((await app.inject({ url: "/api/admin/session", headers: { cookie } })).statusCode, 200);
    const pending = (await compatibility.upsertCompatibilityAccount({ email: "rebind-target@icloud.com", note: compatibility.REBIND_NOTE }));
    const regular = await app.inject({ url: "/api/admin/mappings", headers: { cookie } });
    assert.equal(regular.json().results.some((row: any) => row.id === pending.id), false);
    const expanded = await app.inject({ url: "/api/admin/mappings?includeRebindTargets=1", headers: { cookie } });
    const target = expanded.json().results.find((row: any) => row.id === pending.id);
    assert.equal(target.email, "rebind-target@icloud.com");
    assert.equal(target.rebindTargetPending, true);
    assert.equal(target.openaiOAuth.hasAccessToken, false);
    const now = new Date(Date.now() + 5000).toISOString();
    (await db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,recipient_enc,subject,received_at,category,is_security,indexed_at)
      VALUES('pending-rebind-mail','shared-mail-api','89','noreply@openai.com',?,'Your temporary ChatGPT code',?,'security',1,?)`)
      .run(crypto.encryptSecret("rebind-target@icloud.com"), now, now));
    (await db.prepare("INSERT INTO pending_mail_claims(pending_id,message_id,created_at) VALUES(?,'pending-rebind-mail',?)").run(pending.id, now));
    let bodyReads = 0;
    t.mock.method(upstream.sharedMailReader, "byId", async (id: string) => {
      bodyReads += 1;
      assert.equal(id, "89");
      return { id: 89, address: "rebind-target@icloud.com", created_at: now,
        raw: "From: OpenAI <noreply@openai.com>\r\nTo: rebind-target@icloud.com\r\nSubject: Your temporary ChatGPT code\r\n\r\nYour code is 674321" };
    });
    const otp = await app.inject({ url: "/api/admin/mapping-verification-code?id=" + encodeURIComponent(pending.id), headers: { cookie } });
    assert.equal(otp.statusCode, 200, otp.body);
    assert.equal(otp.json().item.verificationCode, "674321");
    assert.equal(bodyReads, 1);
    const logout = await app.inject({ method: "POST", url: "/api/admin/logout", headers: { cookie } });
    assert.equal(logout.cookies.find((item) => item.name === "mail_opus_admin")?.value, "");
    assert.equal(logout.cookies.find((item) => item.name === "mail_opus_v2_admin")?.value, "");
  });

  await t.test("sourceEmail remains a sender rule and native imports acquire V1 routing rules", async () => {
    const sourceEmail = "noreply_at_tm_openai_com_route123_ab12@icloud.com";
    const original = (await compatibility.upsertCompatibilityAccount({ email: "previous@icloud.com", sourceEmail, toEmail: "previous@icloud.com" }));
    const id = original.item.id;
    const rules = (await db.prepare("SELECT r.* FROM mail_routing_rules r JOIN email_bindings b ON b.id=r.binding_id WHERE b.account_id=?").all(id)) as any[];
    assert.equal(rules.length, 1);
    assert.equal(new RegExp(rules[0].sender_pattern, "i").test("alert_at_tm1_openai_com_route123_cd34@icloud.com"), true);
    assert.equal(new RegExp(rules[0].sender_pattern, "i").test("alert_at_tm1_openai_com_other_cd34@icloud.com"), false);
    assert.equal(new RegExp(rules[0].recipient_pattern, "i").test("previous@icloud.com"), true);
    const changed = (await compatibility.upsertCompatibilityAccount({ email: "target@icloud.com", rebindPreviousEmail: "previous@icloud.com", sourceEmail }));
    assert.equal(changed.item.id, id);
    const mapping = (await compatibility.compatibilityMapping(id));
    assert.equal(mapping.sourceEmail, sourceEmail);
    assert.equal(mapping.rebindPreviousEmail, "previous@icloud.com");
    assert.equal(mapping.toEmail, "target@icloud.com");
    const response = await app.inject({ method: "POST", url: "/api/v1/accounts", headers,
      payload: { email: "rollback@icloud.com", fromPatterns: ["["] } });
    assert.equal(response.statusCode, 400);
    await assert.rejects(async () => (await compatibility.accountForEmail("rollback@icloud.com")), /账号不存在/);
  });

  await t.test("customer base sourceEmail uses the OpenAI relay sender rule", async () => {
    const imported = (await compatibility.upsertCompatibilityAccount({
      email: "base-source+oaixyz@icloud.com",
      sourceEmail: "base-source@icloud.com",
      toEmail: "base-source+oaixyz@icloud.com",
    }));
    const rule = (await db.prepare(`SELECT r.* FROM mail_routing_rules r
      JOIN email_bindings b ON b.id=r.binding_id WHERE b.account_id=?`).get(imported.item.id)) as any;
    assert.ok(rule);
    assert.equal(new RegExp(rule.sender_pattern, "i").test("noreply_at_tm_openai_com_route123_ab12@icloud.com"), true);
    assert.equal(new RegExp(rule.sender_pattern, "i").test("base-source@icloud.com"), false);
    assert.equal(new RegExp(rule.recipient_pattern, "i").test("base-source+oaixyz@icloud.com"), true);
  });

  await t.test("cleanup uses internal task status without quarantining accounts or leaking it to customers", async () => {
    const completed = (await compatibility.upsertCompatibilityAccount({ email: "duplicate@icloud.com", note: "automyai OpenAI-X workflow completed",
      internalStatusMessage: "user_already_exists", raw: "BODY-CANARY-IGNORED-IMPORT", html: "BODY-CANARY-IGNORED-IMPORT" }));
    const mapping = (await compatibility.compatibilityMapping(completed.item.id));
    assert.equal(mapping.internalStatusMessage, "user_already_exists");
    assert.equal(mapping.lifecycleStatus, "active");
    assert.equal(mapping.statusMessage, "");
    const cleanup = (await compatibility.cleanupCompatibilityAccount({ email: "duplicate@icloud.com", kind: "signup", reason: "already_registered" }));
    assert.equal(cleanup.completedRemoved, 1);
    assert.equal(cleanup.removedCount, 1);
    (await compatibility.upsertCompatibilityAccount({ email: "protected@icloud.com", note: "automyai OpenAI-X workflow completed",
      statusMessage: "already_registered", accessToken: "fake-protected-token" }));
    assert.equal((await compatibility.cleanupCompatibilityAccount({ email: "protected@icloud.com", reason: "already_registered" })).removedCount, 0);
    assert.equal((await databaseSnapshot(db)).includes("BODY-CANARY-IGNORED-IMPORT"), false);
  });

  await t.test("list and detail redact internal addresses while password changes revoke old and in-flight sessions", async () => {
    const created = (await compatibility.upsertCompatibilityAccount({ email: "customer+oaione@icloud.com" }));
    const accountId = created.item.id;
    const siblingCreated = (await compatibility.upsertCompatibilityAccount({ email: "customer+oaitwo@icloud.com" }));
    const otherBatchCreated = (await compatibility.upsertCompatibilityAccount({ email: "separate+oaione@icloud.com" }));
    const binding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(accountId)) as any;
    const siblingBinding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(siblingCreated.item.id)) as any;
    const otherBatchBinding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(otherBatchCreated.item.id)) as any;
    const grant = (await repository.createCustomerGrant(accountId, binding.id, { password: "fake-customer-password" }));
    const siblingGrant = (await repository.createCustomerGrant(siblingCreated.item.id, siblingBinding.id, { password: "fake-sibling-password" }));
    const otherBatchGrant = (await repository.createCustomerGrant(otherBatchCreated.item.id, otherBatchBinding.id, { password: "fake-other-password" }));
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { email: "customer+oaione@icloud.com", password: "fake-customer-password" } });
    const cookie = login.cookies.map((item) => item.name + "=" + item.value).join("; ");
    const now = new Date(Date.now() + 5000).toISOString();
    const internal = "route-internal@example.test";
    const canary = "BODY-CANARY-CUSTOMER-REVIEW";
    (await db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,recipient_enc,subject,received_at,category,is_security,indexed_at)
      VALUES('review-message','shared-mail-api','88',?,?,'Login route-internal%40example.test',?,'security',1,?)`)
      .run(internal.toUpperCase(), crypto.encryptSecret(internal), now, now));
    (await db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,visible_to_customer,created_at)
      VALUES('review-message',?,?,'exact','offline fixture',1,?)`).run(accountId, binding.id, now));
    (await db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,recipient_enc,subject,received_at,category,is_security,indexed_at)
      VALUES('reviewed-legacy-message','shared-mail-api','87','noreply@openai.com',?,'Reviewed legacy mail',?,'billing',0,?)`)
      .run(crypto.encryptSecret("customer@icloud.com"), now, now));
    const insertLegacyClaim = db.prepare(`INSERT INTO mail_ownership_claims(
      message_id,account_id,binding_id,claim_type,reason,visible_to_customer,created_at)
      VALUES('reviewed-legacy-message',?,?, 'legacy_mapping_index','offline fixture',1,?)`);
    (await insertLegacyClaim.run(accountId, binding.id, now));
    (await insertLegacyClaim.run(siblingCreated.item.id, siblingBinding.id, now));
    (await db.prepare(`INSERT INTO lifecycle_events(id,account_id,binding_id,event_type,occurred_at,source,payload_json,created_at)
      VALUES('reviewed-claim-rejection',?,?,'mail_claim_rejected',?,'test',?,?)`).run(
      accountId, binding.id, now, JSON.stringify({ messageId: "reviewed-legacy-message" }), now,
    ));
    assert.equal((await repository.listCustomerMails((await repository.grantById(grant.grantId))!, 0, 20)).results
      .some((item: any) => item.id === "reviewed-legacy-message"), true);
    assert.equal((await repository.listCustomerMails((await repository.grantById(siblingGrant.grantId))!, 0, 20)).results
      .some((item: any) => item.id === "reviewed-legacy-message"), true);
    assert.equal((await repository.listCustomerMails((await repository.grantById(siblingGrant.grantId))!, 0, 20)).results
      .some((item: any) => item.id === "review-message"), true);
    assert.equal((await repository.listCustomerMails((await repository.grantById(otherBatchGrant.grantId))!, 0, 20)).results
      .some((item: any) => item.id === "review-message"), false);
    let bodyReads = 0;
    let releaseBody: (() => void) | undefined;
    let bodyStarted: (() => void) | undefined;
    const sibling = "customer+oaitwo@icloud.com";
    const raw = `From: OpenAI <noreply@openai.com>\r\nTo: ${internal}\r\nSubject: Login code\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>${canary} ${internal.toUpperCase()} route-internal%40example.test route-internal&#64;example.test ${sibling}</p>`;
    t.mock.method(upstream.sharedMailReader, "byId", async () => {
      bodyReads += 1;
      if (bodyStarted) { bodyStarted(); await new Promise<void>((resolve) => { releaseBody = resolve; }); }
      return { id: 88, address: internal, created_at: now, raw };
    });
    const list = await app.inject({ url: "/api/mails", headers: { cookie } });
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.toLowerCase().includes("route-internal"), false);
    assert.equal(bodyReads, 0);
    assert.equal((await app.inject({ url: "/api/mail-detail?id=foreign", headers: { cookie } })).statusCode, 404);
    assert.equal(bodyReads, 0);
    const detail = await app.inject({ url: "/api/mail-detail?id=review-message", headers: { cookie } });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.body.toLowerCase().includes("route-internal"), false);
    assert.equal(detail.body.toLowerCase().includes("customer+oaitwo"), false);
    assert.equal(detail.body.includes(canary), true);
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    const inFlight = app.inject({ url: "/api/mail-detail?id=review-message", headers: { cookie } });
    void inFlight.then(() => {});
    await started;
    const changed = await app.inject({ method: "POST", url: "/api/change-password", headers: { cookie }, payload: { password: "new-customer-password" } });
    assert.equal(changed.statusCode, 200);
    releaseBody!();
    assert.equal((await inFlight).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/session", headers: { cookie } })).statusCode, 401);
    const newCookie = changed.cookies.map((item) => item.name + "=" + item.value).join("; ");
    assert.equal((await app.inject({ url: "/api/session", headers: { cookie: newCookie } })).statusCode, 200);
    const preset = await app.inject("/api/preset?m=" + encodeURIComponent(grant.publicToken));
    assert.equal(preset.json().password, "new-customer-password");
    assert.equal((await databaseSnapshot(db)).includes(canary), false);
    assert.equal(bodyReads, 2);
  });
  assert.equal(networkRequests, 0);
});
