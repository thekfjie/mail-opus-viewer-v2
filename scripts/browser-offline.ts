import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [playwrightModule, executablePath] = process.argv.slice(2);
if (!playwrightModule || !executablePath) throw new Error("Pass an installed Playwright module and Chromium executable; no downloads are performed");
const { chromium } = await import(pathToFileURL(path.resolve(playwrightModule)).href);
const { db } = await import("../src/server/db.js");
const { importAccounts, createCustomerGrant, deactivateAccount } = await import("../src/server/repository.js");
const { buildApp } = await import("../src/server/server.js");
const { sharedMailReader } = await import("../src/server/upstream-mail.js");
const { encryptSecret } = await import("../src/server/crypto.js");
const artifacts = path.resolve("artifacts/browser");
fs.mkdirSync(artifacts, { recursive: true });

const result = (await importAccounts(Array.from({ length: 8 }, (_, i) => {
  const email = `offline-browser-${i}@icloud.com`;
  const token = [Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ sub: `offline-${i}`, email,
    exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_plan_type: "free" } })).toString("base64url"), "offline-signature"].join(".");
  return { email, accessToken: token, refreshToken: `offline-refresh-${i}`, plan: "free" };
})));
assert.equal(result.errors.length, 0);
const owners = (await db.prepare("SELECT a.id,b.id binding_id FROM gpt_accounts a JOIN email_bindings b ON b.account_id=a.id AND b.is_current=1 ORDER BY a.id").all()) as any[];
const grant = (await createCustomerGrant(owners[0].id, owners[0].binding_id, { password: "offline-customer-password" }));
(await deactivateAccount(owners[1].id, "offline-browser-fixture"));
const receivedAt = new Date(Date.now() + 10).toISOString();
const bodyMarker = "OFFLINE-BROWSER-TRANSIENT-CONTENT";
const recipient = "browser-delivery@example.com";
(await db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,recipient_enc,subject,received_at,indexed_at)
  VALUES('browser-message','shared-mail-api','991','noreply@example.com',?,'Offline delivery',?,?)`).run(encryptSecret(recipient), receivedAt, receivedAt));
(await db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,visible_to_customer,created_at)
  VALUES('browser-message',?,?,'exact','browser fixture',1,?)`).run(owners[0].id, owners[0].binding_id, receivedAt));
let fakeMailReads = 0;
sharedMailReader.byId = async (id: string) => {
  assert.equal(id, "991");
  fakeMailReads += 1;
  return { id, address: recipient, source: "noreply@example.com", created_at: receivedAt,
    raw: `From: noreply@example.com\r\nTo: ${recipient}\r\nSubject: Offline delivery\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>${bodyMarker}</p>` };
};
globalThis.fetch = async () => { throw new Error("Browser fixture cannot call upstream"); };
const app = await buildApp();
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors: string[] = [];
const checks: Record<string, unknown>[] = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    await context.route("**/*", (route: any) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`${origin}/admin`);
    await page.getByPlaceholder("后台口令").fill("offline-admin-not-for-deployment");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator("tr.account-table-row").first().waitFor();
    await page.screenshot({ path: path.join(artifacts, `admin-${viewport.width}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `admin horizontal overflow at ${viewport.width}`);
    await page.locator(".detail-toggle").first().click();
    await page.locator(".detail-drawer-scroll .detail-section-heading").first().waitFor();
    await page.screenshot({ path: path.join(artifacts, `detail-${viewport.width}.png`), fullPage: true });
    const drawer = await page.locator(".detail-drawer").boundingBox();
    assert.ok(drawer && drawer.x >= -1 && drawer.x + drawer.width <= viewport.width + 1);
    await page.getByRole("button", { name: "关闭账号详情" }).click();
    let healthRequests = 0;
    page.on("request", (request: any) => { if (new URL(request.url()).pathname === "/api/v2/admin/mail-health") healthRequests += 1; });
    await page.getByRole("button", { name: "收信状态", exact: true }).click();
    await page.getByRole("heading", { name: "D1 请求预算", exact: true }).waitFor();
    assert.equal(healthRequests, 1);
    assert.equal(fakeMailReads, viewport.width === 1440 ? 0 : 2);
    const healthOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(healthOverflow, false, `mail health horizontal overflow at ${viewport.width}`);
    await page.getByRole("heading", { name: "后台任务与限流", exact: true }).waitFor();
    await page.getByText("进程内计数（离线测试）", { exact: true }).waitFor();
    const [refreshedHealth] = await Promise.all([
      page.waitForResponse((response: any) => new URL(response.url()).pathname === "/api/v2/admin/mail-health"
        && response.request().method() === "GET"),
      page.getByRole("button", { name: "刷新数据", exact: true }).click(),
    ]);
    await refreshedHealth.finished();
    assert.equal(refreshedHealth.status(), 200);
    await page.getByRole("button", { name: "刷新数据", exact: true }).waitFor();
    assert.equal(healthRequests, 2);
    await page.screenshot({ path: path.join(artifacts, `mail-health-${viewport.width}.png`), fullPage: true });
    const adminPreferences = await page.evaluate(() => ({ ...localStorage }));
    await page.goto(`${origin}/#m=${encodeURIComponent(grant.publicToken)}`);
    await page.locator("#refreshBtn").waitFor();
    await page.reload();
    await page.locator("#refreshBtn").waitFor();
    await page.frameLocator("iframe").locator("body").filter({ hasText: bodyMarker }).waitFor();
    await page.screenshot({ path: path.join(artifacts, `customer-${viewport.width}.png`), fullPage: true });
    const customerOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(customerOverflow, false, `customer horizontal overflow at ${viewport.width}`);
    const persistent = await page.evaluate(async () => ({ local: { ...localStorage }, session: sessionStorage.length,
      caches: (await caches.keys()).length, databases: (await indexedDB.databases()).length }));
    assert.deepEqual(persistent, { local: adminPreferences, session: 0, caches: 0, databases: 0 });
    checks.push({ viewport, admin: true, detail: true, mailHealth: true, mailHealthRequests: healthRequests, customerHashAndRefresh: true, noPersistentMailStorage: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(db.serialize().includes(Buffer.from(bodyMarker)), false);
  assert.ok(fakeMailReads >= 4);
  console.log(JSON.stringify({ ok: true, checks, pageErrors: errors, upstreamRequests: 0, fakeMailReads, noStoredBody: true }));
} finally {
  await browser.close();
  await app.close();
  (await db.close());
}
