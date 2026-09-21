import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("legacy signed sessions and real HTTP CookieJar survive local V2 routing", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opus-loopback-session-"));
  Object.assign(process.env, {
    PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "test.sqlite"), ENV_FILE: "/dev/null",
    V2_SESSION_SECRET: "offline-loopback-session", CREDENTIAL_ENCRYPTION_KEY: "offline-loopback-key",
    VIEWER_ADMIN_PASSWORD: "offline-admin-password", PUBLIC_ORIGIN: "https://public.example.test", V2_READ_ONLY: "false",
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("external network forbidden"); });
  const [{ buildApp }, { db }, repository, { signSession }] = await Promise.all([
    import("../src/server/server.js"), import("../src/server/db.js"),
    import("../src/server/repository.js"), import("../src/server/crypto.js"),
  ]);
  const app = await buildApp();
  t.after(async () => { await app.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const adminToken = signSession("admin", "administrator");
  assert.equal((await app.inject({ url: "/api/admin/session", headers: { cookie: `mail_opus_admin=${adminToken}` } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/admin/session", headers: { cookie: "mail_opus_admin=forged-token" } })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/admin/session", headers: { cookie: `mail_opus_admin=${signSession("customer", "administrator")}` } })).statusCode, 401);
  const cases = [
    { remoteAddress: "127.0.0.1", headers: { host: "127.0.0.1:8789" }, secure: false },
    { remoteAddress: "::1", headers: { host: "[::1]:8789" }, secure: false },
    { remoteAddress: "127.0.0.1", headers: { host: "public.example.test", "x-forwarded-proto": "http" }, secure: true },
    { remoteAddress: "192.0.2.5", headers: { host: "127.0.0.1:8789", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http" }, secure: true },
    { remoteAddress: "127.0.0.1", headers: { host: "127.0.0.1:8789", "x-forwarded-proto": "https" }, secure: true },
    { remoteAddress: "127.0.0.1", headers: { host: "127.0.0.1:8789", "x-forwarded-proto": "http", "x-forwarded-host": "public.example.test" }, secure: true },
  ];
  for (const scenario of cases) {
    const response = await app.inject({ method: "POST", url: "/api/v2/admin/login", remoteAddress: scenario.remoteAddress,
      headers: scenario.headers, payload: { password: "offline-admin-password" } });
    assert.equal(response.statusCode, 200);
    assert.equal(Boolean(response.cookies[0].secure), scenario.secure, JSON.stringify(scenario));
  }
  assert.equal(repository.importAccounts([{ email: "cookiejar@icloud.com" }]).errors.length, 0);
  const owner = db.prepare("SELECT account_id,id FROM email_bindings WHERE is_current=1").get() as any;
  repository.createCustomerGrant(owner.account_id, owner.id, { password: "offline-customer-password" });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const script = [
    "import json, sys",
    "from urllib.request import build_opener, HTTPCookieProcessor, ProxyHandler, Request",
    "from http.cookiejar import CookieJar",
    "base = sys.argv[1]",
    "jar = CookieJar()",
    "opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(jar))",
    "payload = json.dumps({'email':'cookiejar@icloud.com','password':'offline-customer-password'}).encode()",
    "request = Request(base + '/api/login', data=payload, headers={'Content-Type':'application/json'}, method='POST')",
    "with opener.open(request, timeout=5) as response: assert response.status == 200",
    "assert any(cookie.name == 'mail_opus_v2_customer' and not cookie.secure for cookie in jar)",
    "with opener.open(base + '/api/session', timeout=5) as response: assert json.load(response)['ok'] is True",
    "with opener.open(base + '/api/mails', timeout=5) as response: assert response.status == 200",
    "print('cookiejar_session_ok')",
  ].join("\n");
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("python3", ["-c", script, address], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "cookiejar_session_ok");
});
