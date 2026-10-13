import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SqliteTestDatabase as Database } from "../src/server/storage/sqlite-test.js";
import test from "node:test";
import { smokeProduction } from "../scripts/smoke-production.js";

test("candidate smoke uses explicit protected credentials and local header-only HTTP without database writes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-candidate-smoke-"));
  const filename = path.join(directory, "snapshot.sqlite");
  const environment = path.join(directory, "private.env");
  const secret = "fake-smoke-encryption";
  const password = "fake-smoke-customer-password";
  const email = "customer@icloud.com";
  const token = "fake-customer-public-token";
  const encrypt = (text: string) => {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(secret).digest(), nonce);
    const value = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return `v1.${nonce.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${value.toString("base64url")}`;
  };
  fs.writeFileSync(environment, `VIEWER_ADMIN_PASSWORD=fake-smoke-admin-password\nCREDENTIAL_ENCRYPTION_KEY=${secret}\n`, { mode: 0o600 });
  const db = new Database(filename);
  (await db.exec(`CREATE TABLE gpt_accounts(id TEXT PRIMARY KEY,deleted_at TEXT); INSERT INTO gpt_accounts VALUES('account','');
    CREATE TABLE access_grants(account_id TEXT,login_identifier_enc TEXT,password_plain_enc TEXT,public_token_enc TEXT,
      login_identifier_hash TEXT,active INTEGER,scope TEXT,created_at TEXT);`));
  (await db.prepare("INSERT INTO access_grants VALUES('account',?,?,?,'fake-hash',1,'current','2026-09-08T00:00:00Z')")
    .run(encrypt(email), encrypt(password), encrypt(token)));
  (await db.close());
  const before = fs.readFileSync(filename);
  const paths: string[] = [];
  let leakBody = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://127.0.0.1:8791");
    assert.equal(init?.redirect, "error");
    assert.doesNotMatch(url.pathname, /mail-detail|verification-code|backfill|mail-events/);
    paths.push(url.pathname);
    const headers = new Headers({ "cache-control": "no-store" });
    const requestCookie = new Headers(init?.headers).get("cookie");
    let body: any = { ok: true };
    let html: string | undefined;
    switch (url.pathname) {
      case "/health": body = { ok: true, independent: true, commandWriter: "v2" }; break;
      case "/api/admin/login":
        assert.equal(JSON.parse(String(init?.body)).password, "fake-smoke-admin-password");
        headers.append("set-cookie", "mail_opus_admin=fake-alias; HttpOnly; Path=/");
        headers.append("set-cookie", "mail_opus_v2_admin=fake-admin; HttpOnly; Path=/");
        break;
      case "/api/admin/session": assert.equal(requestCookie, "mail_opus_admin=fake-alias"); break;
      case "/api/admin/mappings":
        assert.equal(requestCookie, "mail_opus_admin=fake-alias");
        assert.equal(url.searchParams.get("includeRebindTargets"), "1");
        body = { results: [{ id: "account", email }], flagsRefreshing: false }; break;
      case "/api/admin/pending-mailboxes": body = { results: [] }; break;
      case "/api/v2/admin/login": headers.append("set-cookie", "mail_opus_v2_admin=fake-admin; HttpOnly; Path=/"); break;
      case "/api/v2/admin/accounts":
        assert.equal(requestCookie, "mail_opus_v2_admin=fake-admin");
        body = { results: [{ id: "account" }], total: 1 }; break;
      case "/api/v2/admin/overview": body = { independent: true, commandWriter: "v2" }; break;
      case "/": html = '<script src="/customer.js"></script>'; break;
      case "/customer.js": html = "function customer() {}"; break;
      case "/admin": html = '<div id="root"></div><script src="/assets/fake.js"></script><link href="/assets/fake.css">'; break;
      case "/assets/fake.js": html = "function admin() {}"; break;
      case "/assets/fake.css": html = "body {color: black;}"; break;
      case "/api/preset":
        assert.equal(url.searchParams.get("m"), token);
        body = { email, password }; break;
      case "/api/login":
        assert.deepEqual(JSON.parse(String(init?.body)), { email, password });
        headers.append("set-cookie", "mail_opus_v2_customer=fake-customer; HttpOnly; Path=/"); break;
      case "/api/session":
        assert.equal(requestCookie, "mail_opus_v2_customer=fake-customer");
        body = { ok: true, email }; break;
      case "/api/mails": body = { count: 1, results: [{ id: "mail", subject: "Login code", needsDetail: true, ...(leakBody ? { html: "canary-body" } : {}) }] }; break;
      case "/api/logout": case "/api/admin/logout": case "/api/v2/admin/logout": break;
      default: assert.fail("unexpected candidate endpoint");
    }
    return new Response(html ?? JSON.stringify(body), { status: 200, headers });
  };
  const args = ["--base", "http://127.0.0.1:8791", "--database", filename, "--env", environment];
  try {
    const report = await smokeProduction(args, transport);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.counts.mailBodyRequests, 0);
    assert.equal(report.counts.customerMailHeadersReturned, 1);
    assert.equal(report.counts.staticAssetsChecked, 2);
    assert.ok(report.counts.requests < 32);
    const output = JSON.stringify(report);
    for (const value of [secret, password, email, token, "fake-alias", "fake-admin"]) assert.equal(output.includes(value), false);
    assert.deepEqual(fs.readFileSync(filename), before);
    leakBody = true;
    const leaking = await smokeProduction(args, transport);
    assert.equal(leaking.ok, false);
    assert.equal(leaking.checks.customerIndexOnly, false);
    const calls = paths.length;
    await assert.rejects(smokeProduction(["--base", "https://example.test", "--database", filename, "--env", environment], transport));
    assert.equal(paths.length, calls);
    fs.chmodSync(environment, 0o644);
    await assert.rejects(smokeProduction(args, transport));
    assert.equal(paths.length, calls);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
