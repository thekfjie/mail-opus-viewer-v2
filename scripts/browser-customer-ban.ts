import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [playwrightModule, executablePath] = process.argv.slice(2);
if (!playwrightModule || !executablePath) throw new Error("Pass installed Playwright and Chromium; no downloads");
if (process.env.ENV_FILE !== "/dev/null" || !String(process.env.DATABASE_PATH).includes("opus-v2-offline-")) throw new Error("Use scripts/test-offline.mjs");
const { chromium } = await import(pathToFileURL(path.resolve(playwrightModule)).href);
const [{ db }, repository, { buildApp }, { encryptSecret }, { sharedMailReader }] = await Promise.all([
  import("../src/server/db.js"), import("../src/server/repository.js"), import("../src/server/server.js"),
  import("../src/server/crypto.js"), import("../src/server/upstream-mail.js"),
]);
const artifacts = path.resolve("artifacts/browser"); fs.mkdirSync(artifacts, { recursive: true });
const canary = "OFFLINE-BANNED-CUSTOMER-TRANSIENT-MAIL";
let fakeBodyReads = 0;
let currentMail = { id: "", address: "", created_at: "" };
sharedMailReader.byId = async (id: string) => {
  assert.equal(id, currentMail.id); fakeBodyReads += 1;
  return { ...currentMail, raw: `From: noreply@openai.com\r\nTo: ${currentMail.address}\r\nSubject: Your code\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${canary}` };
};
globalThis.fetch = async () => { throw new Error("Offline browser cannot call upstream"); };
const app = await buildApp();
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors: string[] = [];
const checks: Record<string, unknown>[] = [];
try {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const action of ["revoke", "reclaim"] as const) {
    const name = `${width}-${theme}-${action}`;
    const email = `customer-${name}@icloud.com`;
    assert.equal((await repository.importAccounts([{ email, openaiSubject: name, accessToken: `offline-at-${name}`, plan: "plus" }])).errors.length, 0);
    const account = (await repository.listAccounts({ search: email, limit: 10 })).results[0];
    const binding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(account.id)) as any;
    const grant = (await repository.createCustomerGrant(account.id, binding.id, { password: `offline-password-${name}` }));
    currentMail = { id: String(9100 + checks.length), address: email, created_at: new Date(Date.now() + 1000).toISOString() };
    (await db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,sender,recipient_enc,subject,received_at,indexed_at)
      VALUES(?,'shared-mail-api',?,'noreply@openai.com',?,'Your code',?,?)`).run(currentMail.id, currentMail.id, encryptSecret(email), currentMail.created_at, currentMail.created_at));
    (await db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,reason,visible_to_customer,created_at)
      VALUES(?,?,?,'exact','offline fixture',1,?)`).run(currentMail.id, account.id, binding.id, currentMail.created_at));
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
    await context.route("**/*", (route: any) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage(); page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`${origin}/#m=${encodeURIComponent(grant.publicToken)}`);
    await page.locator(".mail-body").filter({ hasText: canary }).waitFor();
    assert.equal(await page.locator(".mailbox-status-banner").count(), 0);
    (await repository.deactivateAccount(account.id, "offline-browser-ban"));
    await page.locator("#refreshBtn").click();
    const banner = page.getByRole("status");
    await banner.filter({ hasText: "账号已封禁，邮箱访问仍有效，管理员回收/撤销前可继续查看。" }).waitFor();
    const style = await banner.evaluate((element: HTMLElement) => {
      const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
      return { color: style.color, border: style.borderTopColor, borderWidth: style.borderTopWidth, left: rect.left, right: rect.right,
        width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    const rgb = style.color.match(/\d+/g)!.map(Number);
    assert.ok(rgb[0] > rgb[1] && rgb[0] > rgb[2], "ban banner red in both themes");
    assert.equal(style.border, style.color); assert.equal(style.borderWidth, "1px");
    assert.ok(style.left >= 0 && style.right <= style.width); assert.equal(style.overflow, false);
    assert.equal(await page.locator(".mail-body").filter({ hasText: canary }).isVisible(), true);
    await page.reload();
    await banner.filter({ hasText: "账号已封禁，邮箱访问仍有效" }).waitFor();
    await page.locator(".mail-body").filter({ hasText: canary }).waitFor();
    await page.goto(`${origin}/#m=${encodeURIComponent(grant.publicToken)}`);
    await page.reload();
    await banner.filter({ hasText: "账号已封禁，邮箱访问仍有效" }).waitFor();
    await page.locator(".mail-body").filter({ hasText: canary }).waitFor();
    if (action === "revoke") await page.screenshot({ path: path.join(artifacts, `customer-ban-${width}-${theme}.png`), fullPage: true });
    if (action === "revoke") (await repository.revokeCustomerGrant(account.id, grant.grantId));
    else (await repository.recycleAccount(account.id, `replacement-${name}@icloud.com`));
    const beforeInvalid = fakeBodyReads;
    await page.locator("#refreshBtn").click();
    await page.getByText("邮箱访问已失效，请重新登录或联系管理员确认授权。", { exact: true }).waitFor();
    assert.equal(await page.locator(".mail-body").count(), 0);
    assert.equal(await page.locator(".mailbox-status-banner").count(), 0);
    await page.goto(`${origin}/#m=${encodeURIComponent(grant.publicToken)}`);
    await page.reload();
    await page.getByText("账号链接无效或已失效", { exact: true }).waitFor();
    assert.equal(await page.locator("#password").inputValue(), "");
    assert.equal(fakeBodyReads, beforeInvalid, "invalid link/session does not read upstream");
    const persistent = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length,
      caches: (await caches.keys()).length, databases: (await indexedDB.databases()).length }));
    assert.deepEqual(persistent, { local: 0, session: 0, caches: 0, databases: 0 });
    checks.push({ width, theme, action, bannedLinkStillWorks: true, sessionRefresh: true, redStatus: true,
      oldLinkAndSessionInvalidAfterAction: true, noPersistentMail: true, noHorizontalOverflow: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(db.serialize().includes(Buffer.from(canary)), false);
  assert.equal(((await db.prepare("SELECT count(*) AS count FROM mail_read_requests").get()) as any).count, 0);
  console.log(JSON.stringify({ ok: true, checks, fakeBodyReads, upstreamRequests: 0, pageErrors: errors }));
} finally { await browser.close(); await app.close(); (await db.close()); }
