import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("independent HTTP customer and automation contracts use local state and exact-ID body reads", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-runtime-api-"));
  Object.assign(process.env, {
    PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "test.sqlite"), ENV_FILE: path.join(directory, "absent.env"),
    V2_SESSION_SECRET: "fake-runtime-session", CREDENTIAL_ENCRYPTION_KEY: "fake-runtime-encryption",
    VIEWER_ADMIN_PASSWORD: "fake-admin-password", IMPORT_API_KEY: "fake-import-key", PUBLIC_ORIGIN: "https://mail.example.test",
    V2_MAIL_WEBHOOK_SECRET: "fake-webhook-key", V2_CF_D1_READ_TOKEN: "", V2_READ_ONLY: "false",
  });
  let externalRequests = 0;
  t.mock.method(globalThis, "fetch", async () => { externalRequests += 1; throw new Error("external network forbidden"); });
  const [{ buildApp }, { db }, repository, crypto, upstream, { createWorker }, compatibility] = await Promise.all([
    import("../src/server/server.js"), import("../src/server/db.js"), import("../src/server/repository.js"),
    import("../src/server/crypto.js"), import("../src/server/upstream-mail.js"), import("../src/server/worker.js"),
    import("../src/server/compatibility-state.js"),
  ]);
  const app = await buildApp();
  t.after(async () => { await app.close(); db.close(); fs.rmSync(directory, { recursive: true }); });
  assert.equal(app.server.listening, false);
  const health = await app.inject("/health");
  assert.equal(health.json().independent, true);
  assert.equal(health.json().commandWriter, "v2");
  assert.equal(externalRequests, 0);
  assert.equal((await app.inject("/api/admin/mappings")).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/accounts", payload: { email: "a@example.test" } })).statusCode, 401);
  const admin = await app.inject({ method: "POST", url: "/api/admin/login", payload: { username: "", password: "fake-admin-password" } });
  assert.equal(admin.statusCode, 200);
  const adminCookie = admin.cookies.map((item) => item.name + "=" + item.value).join("; ");
  const importHeaders = { "x-api-key": "fake-import-key" };
  const pending = await app.inject({ method: "POST", url: "/api/v1/accounts", headers: importHeaders,
    payload: { email: "pending@icloud.com", note: compatibility.SIGNUP_NOTE } });
  assert.equal(pending.statusCode, 201);
  assert.equal(pending.json().temporary, true);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM gpt_accounts").get() as any).n, 0);
  const pendingList = await app.inject({ url: "/api/admin/mappings?view=openai-retry", headers: { cookie: adminCookie } });
  assert.equal(pendingList.json().results[0].email, "pending@icloud.com");
  const cleanup = await app.inject({ method: "POST", url: "/api/v1/accounts/cleanup", headers: importHeaders,
    payload: { email: "pending@icloud.com", kind: "signup", reason: "already_registered" } });
  assert.equal(cleanup.json().pendingRemoved, true);
  const create = await app.inject({ method: "POST", url: "/api/v1/accounts", headers: importHeaders,
    payload: { email: "customer@icloud.com", access_token: "fake-access-token", refresh_token: "fake-refresh-token", openaiSubject: "runtime-subject", plan: "plus" } });
  assert.equal(create.statusCode, 201, create.body);
  assert.equal(create.body.includes("fake-access-token"), false);
  const accountId = create.json().item.id;
  const oauth = await app.inject({ url: "/api/admin/mappings/" + accountId + "/oauth", headers: { cookie: adminCookie } });
  assert.equal(oauth.json().accessToken, "fake-access-token");
  assert.equal(oauth.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ url: "/api/admin/mappings/" + accountId + "/oauth", headers: { cookie: adminCookie, origin: "https://evil.test" } })).statusCode, 403);
  const binding = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(accountId) as any;
  const grant = repository.createCustomerGrant(accountId, binding.id, { password: "fake-customer-password" });
  const preset = await app.inject("/api/preset?m=" + encodeURIComponent(grant.publicToken));
  assert.equal(preset.json().password, "fake-customer-password");
  assert.equal(preset.body.includes("fake-access-token"), false);
  assert.equal(preset.headers["cache-control"], "no-store");
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { email: "customer@icloud.com", password: "fake-customer-password" } });
  assert.equal(login.statusCode, 200, login.body);
  const customerCookie = login.cookies.map((item) => item.name + "=" + item.value).join("; ");
  assert.equal((await app.inject({ url: "/api/admin/mappings", headers: { cookie: customerCookie } })).statusCode, 401);
  const now = new Date(Date.now() + 1000).toISOString();
  db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,recipient_enc,subject,received_at,category,is_security,indexed_at)
    VALUES('message-1','shared-mail-api','77','OpenAI',?,'Login code',?,'security',1,?)`)
    .run(crypto.encryptSecret("route-internal@example.test"), now, now);
  db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,visible_to_customer,created_at)
    VALUES('message-1',?,?,'exact','offline fixture',1,?)`).run(accountId, binding.id, now);
  let bodyReads = 0;
  const canary = "BODY-CANARY-RUNTIME-92415";
  t.mock.method(upstream.sharedMailReader, "byId", async (id: string) => {
    bodyReads += 1; assert.equal(id, "77");
    return { id: 77, address: "route-internal@example.test", created_at: now,
      raw: "From: OpenAI <noreply@openai.com>\r\nTo: route-internal@example.test\r\nSubject: Login code\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>" + canary + " route-internal@example.test 123456</p>" };
  });
  const list = await app.inject({ url: "/api/mails", headers: { cookie: customerCookie } });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().results.length, 1);
  assert.equal(bodyReads, 0);
  assert.equal(list.body.includes("route-internal"), false);
  assert.equal((await app.inject({ url: "/api/mail-detail?id=not-owned", headers: { cookie: customerCookie } })).statusCode, 404);
  assert.equal(bodyReads, 0);
  const detail = await app.inject({ url: "/api/mail-detail?id=message-1", headers: { cookie: customerCookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().mail.html.includes(canary), true);
  assert.equal(detail.body.includes("route-internal"), false);
  assert.equal(detail.body.includes("fake-access-token"), false);
  assert.equal(bodyReads, 1);
  await app.inject({ url: "/api/mail-detail?id=message-1", headers: { cookie: customerCookie } });
  assert.equal(bodyReads, 2);
  db.prepare("UPDATE access_grants SET visible_to=? WHERE id=?").run(now, grant.grantId);
  assert.equal((await app.inject({ url: "/api/mail-detail?id=message-1", headers: { cookie: customerCookie } })).statusCode, 404);
  assert.equal(bodyReads, 2);
  assert.equal(db.serialize().includes(Buffer.from(canary)), false);
  const changed = await app.inject({ method: "POST", url: "/api/change-password", headers: { cookie: customerCookie }, payload: { password: "changed-customer-password" } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(repository.authenticateCustomer("customer@icloud.com", "fake-customer-password"), null);
  assert.ok(repository.authenticateCustomer("customer@icloud.com", "changed-customer-password"));
  const root = await app.inject("/");
  assert.equal(root.body.includes("/customer.js"), true);
  assert.match(String(root.headers["content-security-policy"]), /img-src 'self' data: https:/);
  assert.equal((await app.inject("/?m=" + encodeURIComponent(grant.publicToken))).body.includes("/customer.js"), true);
  const script = await app.inject("/customer.js");
  assert.doesNotMatch(script.body, /sessionStorage|indexedDB|serviceWorker|setTimeout\(boot/);
  assert.match(script.body, /opusmail-theme/);
  assert.match(script.body, /data-theme-choice/);
  const loginCss = await app.inject("/customer-login.css");
  assert.equal(loginCss.statusCode, 200);
  assert.match(loginCss.body, /login-card/);
  const pendingSignup = await app.inject({ method: "POST", url: "/api/v1/accounts", headers: importHeaders,
    payload: { email: "registration@icloud.com", note: compatibility.SIGNUP_NOTE } });
  assert.equal(pendingSignup.statusCode, 201);
  const pendingAt = new Date(Date.now() + 2000).toISOString();
  const pendingMessage = await app.inject({ method: "POST", url: "/api/v2/internal/mail-events",
    headers: { authorization: "Bearer fake-webhook-key" },
    payload: { id: 99, to: "registration@icloud.com", from: "noreply@openai.com", subject: "Your temporary ChatGPT code",
      created_at: pendingAt, parsedText: "Your code is 987654 " + canary } });
  assert.equal(pendingMessage.statusCode, 200, pendingMessage.body);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM gpt_accounts").get() as any).n, 1);
  let pendingReads = 0;
  t.mock.method(upstream.sharedMailReader, "byId", async (id: string) => {
    pendingReads += 1; assert.equal(id, "99");
    return { id: 99, address: "registration@icloud.com", created_at: pendingAt,
      raw: "From: OpenAI <noreply@openai.com>\r\nTo: registration@icloud.com\r\nSubject: Your temporary ChatGPT code\r\n\r\nYour code is 987654 " + canary };
  });
  const pendingOtp = await app.inject({ url: "/api/admin/email-verification-code?email=registration%40icloud.com", headers: { cookie: adminCookie } });
  assert.equal(pendingOtp.statusCode, 200, pendingOtp.body);
  assert.equal(pendingOtp.json().item.verificationCode, "987654");
  assert.equal(pendingOtp.body.includes(canary), false);
  assert.equal(pendingReads, 1);
  await app.inject({ url: "/api/admin/email-verification-code?email=registration%40icloud.com", headers: { cookie: adminCookie } });
  assert.equal(pendingReads, 1);
  const completeSignup = await app.inject({ method: "POST", url: "/api/v1/accounts", headers: importHeaders,
    payload: { email: "registration@icloud.com", accessToken: "fake-registration-at", openaiSubject: "registration-subject" } });
  assert.equal(completeSignup.statusCode, 201, completeSignup.body);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM pending_mailboxes").get() as any).n, 0);
  assert.ok(db.prepare(`SELECT 1 FROM mail_ownership_claims c JOIN mail_messages m ON m.id=c.message_id
    WHERE m.provider_message_id=? AND c.account_id=?`)
    .get(pendingMessage.json().messageId, completeSignup.json().item.id));
  const rejectedHook = await app.inject({ method: "POST", url: "/api/v2/internal/mail-events", payload: { raw: canary } });
  assert.equal(rejectedHook.statusCode, 401);
  const hook = await app.inject({ method: "POST", url: "/api/v2/internal/mail-events", headers: { authorization: "Bearer fake-webhook-key" },
    payload: { id: 88, to: "customer@icloud.com", subject: "Notice", created_at: now, parsedText: canary } });
  assert.equal(hook.statusCode, 200, hook.body);
  assert.equal(db.serialize().includes(Buffer.from(canary)), false);
  const calls: string[] = [];
  const worker = createWorker({
    now: () => Date.now(),
    sub2api: async () => { calls.push("sub2api"); return {} as any; },
    outlook: async () => { calls.push("outlook"); return {} as any; },
    pendingMail: async () => { calls.push("pendingMail"); return { processed: 0, errors: 0 }; },
    schedule: () => { calls.push("schedule"); return {} as any; },
    promotions: async () => { calls.push("promotions"); return {} as any; },
    paymentExposure: async () => { calls.push("paymentExposure"); return {} as any; },
  });
  await worker.runOnce();
  assert.deepEqual(calls, ["pendingMail", "sub2api", "schedule", "promotions", "paymentExposure"]);
  assert.equal(externalRequests, 0);
  for (const file of fs.readdirSync(directory)) assert.equal(fs.readFileSync(path.join(directory, file)).includes(Buffer.from(canary)), false, file);
});
