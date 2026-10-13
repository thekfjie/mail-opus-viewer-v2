import { asyncMap } from '../src/server/async-collections.js';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [playwrightModule, executablePath] = process.argv.slice(2);
if (!playwrightModule || !executablePath) throw new Error("Pass installed Playwright and Chromium; no downloads");
if (process.env.ENV_FILE !== "/dev/null" || !String(process.env.DATABASE_PATH).includes("opus-v2-offline-")) throw new Error("Use scripts/test-offline.mjs");
const { chromium } = await import(pathToFileURL(path.resolve(playwrightModule)).href);
const [{ db }, repository, { buildApp }] = await Promise.all([
  import("../src/server/db.js"), import("../src/server/repository.js"), import("../src/server/server.js"),
]);
const fixedNow = Date.now();
const realNow = Date.now;
Date.now = () => fixedNow;
const artifacts = path.resolve("artifacts/browser"); fs.mkdirSync(artifacts, { recursive: true });
globalThis.fetch = async () => { throw new Error("Offline browser cannot call upstream"); };
const app = await buildApp();
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors: string[] = [];
const checks: Record<string, unknown>[] = [];
const snapshot = async () => JSON.stringify({
  accounts: (await db.prepare("SELECT * FROM gpt_accounts ORDER BY id").all()),
  grants: (await db.prepare("SELECT * FROM access_grants ORDER BY id").all()),
  bindings: (await db.prepare("SELECT * FROM email_bindings ORDER BY id").all()),
  events: (await db.prepare("SELECT * FROM lifecycle_events ORDER BY id").all()),
});
try {
  for (const width of [1440, 390]) {
    const definitions = [
      { name: "ban-6d23h", plan: "free", banAge: 7 * 86400000 - 3600000, domain: "icloud.com", mode: "deactivated", eligible: false, reason: "账号停用未满 7 天" },
      { name: "ban-exact-7d", plan: "plus", banAge: 7 * 86400000, domain: "icloud.com", mode: "deactivated", eligible: true, reason: "" },
      { name: "unopened-free", plan: "free", banAge: 0, domain: "icloud.com", mode: "untagged_free", eligible: true, reason: "" },
      { name: "unopened-plus", plan: "plus", banAge: 0, domain: "icloud.com", mode: "untagged_free", eligible: false, reason: "检测到 Plus/付费套餐证据，已保护不回收" },
      { name: "domain-banned", plan: "free", banAge: 20 * 86400000, domain: "example.test", mode: "deactivated", eligible: false, reason: "回收只适用于 iCloud 共享收件账号；域名邮箱和 Outlook 固定保留" },
    ];
    const fixtures = (await asyncMap(definitions, async (definition) => {
      const email = `${definition.name}-${width}@${definition.domain}`;
      const token = [Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ sub: email, email, exp: 4_000_000_000,
        "https://api.openai.com/auth": { chatgpt_plan_type: definition.plan } })).toString("base64url"), "offline-signature"].join(".");
      assert.equal((await repository.importAccounts([{ email, accessToken: token, plan: definition.plan,
        arrivedAt: new Date(fixedNow - 30 * 86400000).toISOString() }])).errors.length, 0);
      const account = (await repository.listAccounts({ search: email, limit: 10 })).results[0];
      const binding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(account.id)) as any;
      const grant = definition.banAge ? (await repository.createCustomerGrant(account.id, binding.id, { password: "offline-recycle-password" })) : null;
      if (definition.banAge) {
        (await repository.deactivateAccount(account.id, "offline-browser-ban"));
        (await db.prepare("UPDATE gpt_accounts SET deactivated_at=? WHERE id=?").run(new Date(fixedNow - definition.banAge).toISOString(), account.id));
      }
      const result = (await repository.getRecycleEligibility(account.id))!;
      assert.equal(result.modes[definition.mode as keyof typeof result.modes].eligible, definition.eligible);
      return { ...definition, email, id: account.id, grant, dto: result };
    }));
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.route("**/*", (route: any) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage(); page.on("pageerror", (error: Error) => errors.push(error.message));
    let eligibilityReads = 0, recycleWrites = 0;
    page.on("request", (request: any) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/recycle-eligibility")) eligibilityReads += 1;
      if (url.pathname.endsWith("/recycle") && request.method() === "POST") recycleWrites += 1;
    });
    await page.goto(`${origin}/admin`);
    await page.getByPlaceholder("后台口令").fill("offline-admin-not-for-deployment");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator("tr.account-table-row").first().waitFor();
    const before = (await snapshot());
    for (const fixture of fixtures) {
      const previousReads = eligibilityReads;
      await page.locator(`[data-account-id="${fixture.id}"] .detail-toggle`).click();
      await page.locator(".detail-drawer-scroll .detail-section-heading").first().waitFor();
      assert.equal(eligibilityReads, previousReads, "collapsed recycle group does not read eligibility");
      await page.locator(".detail-recycle-group summary").click();
      const group = page.locator(".detail-recycle-group");
      await group.getByText("回收代次：0 / 2", { exact: true }).waitFor();
      assert.equal(eligibilityReads, previousReads + 1);
      const mode = group.locator(`[data-recycle-mode="${fixture.mode}"]`);
      assert.equal(await mode.locator("button").isDisabled(), !fixture.eligible);
      if (fixture.reason) assert.equal(await mode.getByText(fixture.reason, { exact: true }).isVisible(), true);
      if (fixture.banAge) {
        assert.ok((await mode.textContent()).includes("时间门槛："));
        assert.equal(await page.getByRole("button", { name: "重置当前客户授权", exact: true }).isEnabled(), true,
          "a ban cannot disable link generation in the administrator UI");
      }
      assert.equal(await group.getByText("仅管理员确认后执行，达到条件不会自动回收；回收将撤销原客户链接和会话。", { exact: true }).isVisible(), true);
      assert.equal((await group.textContent()).includes("客户状态："), true);
      await group.getByRole("button", { name: "刷新资格", exact: true }).click();
      await group.getByRole("button", { name: "刷新资格", exact: true }).waitFor();
      assert.equal(eligibilityReads, previousReads + 2);
      assert.equal(recycleWrites, 0, "viewing and refreshing never recycle");
      assert.equal((await snapshot()), before, "reading eligibility does not alter business state or grants");
      if (fixture.eligible) {
        let confirmation = "";
        page.once("dialog", async (dialog: any) => { confirmation = dialog.message(); await dialog.dismiss(); });
        await mode.locator("button").click();
        assert.ok(confirmation.includes(fixture.email));
        assert.ok(confirmation.includes("回收将撤销原客户链接和会话"));
        assert.ok(confirmation.includes("达到条件不会自动回收"));
        assert.equal(recycleWrites, 0, "cancelling confirmation never posts");
        assert.equal((await snapshot()), before);
      }
      await page.locator(".detail-recycle-group summary").scrollIntoViewIfNeeded();
      const drawer = await page.locator(".detail-drawer").boundingBox();
      assert.ok(drawer && drawer.x >= -1 && drawer.x + drawer.width <= width + 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      if (fixture.name === "ban-6d23h") await page.screenshot({ path: path.join(artifacts, `recycle-eligibility-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "关闭账号详情" }).click();
    }
    const target = fixtures.find((fixture) => fixture.name === "ban-exact-7d")!;
    const protectedPlus = fixtures.find((fixture) => fixture.name === "unopened-plus")!;
    let releaseDelayed!: () => void, startedDelayed!: () => void, finishedDelayed!: () => void;
    const delayedStart = new Promise<void>((resolve) => { startedDelayed = resolve; });
    const delayedFinish = new Promise<void>((resolve) => { finishedDelayed = resolve; });
    const delayedUrl = `${origin}/api/v2/admin/accounts/${target.id}/recycle-eligibility`;
    await page.route(delayedUrl, async (route: any) => {
      startedDelayed();
      await new Promise<void>((resolve) => { releaseDelayed = resolve; });
      await route.fulfill({ json: target.dto }).catch(() => {});
      finishedDelayed();
    });
    await page.locator(`[data-account-id="${target.id}"] .detail-toggle`).click();
    await page.locator(".detail-drawer-scroll .detail-section-heading").first().waitFor();
    await page.locator(".detail-recycle-group summary").click();
    await delayedStart;
    await page.getByRole("button", { name: "关闭账号详情" }).click();
    await page.locator(`[data-account-id="${protectedPlus.id}"] .detail-toggle`).click();
    await page.locator(".detail-drawer-scroll .detail-section-heading").first().waitFor();
    await page.locator(".detail-recycle-group summary").click();
    await page.locator('[data-recycle-mode="untagged_free"]').getByText("检测到 Plus/付费套餐证据，已保护不回收", { exact: true }).waitFor();
    releaseDelayed(); await delayedFinish;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.locator('[data-recycle-mode="deactivated"] button').isDisabled(), true);
    assert.equal(await page.locator('[data-recycle-mode="untagged_free"] button').isDisabled(), true);
    assert.ok((await page.locator(".detail-drawer-header").textContent()).includes(protectedPlus.email));
    assert.equal((await snapshot()), before, "late eligibility responses do not change account or grants");
    await page.unroute(delayedUrl);
    await page.getByRole("button", { name: "关闭账号详情" }).click();
    await page.locator(`[data-account-id="${target.id}"] .detail-toggle`).click();
    await page.locator(".detail-drawer-scroll .detail-section-heading").first().waitFor();
    await page.locator(".detail-recycle-group summary").click();
    const recycle = page.locator('[data-recycle-mode="deactivated"] button');
    await recycle.waitFor();
    await page.waitForFunction(() => !(document.querySelector('[data-recycle-mode="deactivated"] button') as HTMLButtonElement)?.disabled);
    page.once("dialog", async (dialog: any) => { await dialog.accept(); });
    const [response] = await Promise.all([
      page.waitForResponse((response: any) => new URL(response.url()).pathname.endsWith("/recycle") && response.request().method() === "POST"),
      recycle.click(),
    ]);
    assert.equal(response.status(), 200); assert.equal(recycleWrites, 1);
    assert.deepEqual(response.request().postDataJSON(), { mode: "deactivated", confirmRevokeCustomerAccess: true });
    const oldGrant = (await db.prepare("SELECT active,revoke_reason FROM access_grants WHERE id=?").get(target.grant!.grantId)) as any;
    assert.equal(oldGrant.active, 0); assert.equal(oldGrant.revoke_reason, "mailbox_recycle");
    assert.equal(((await db.prepare("SELECT deactivation_locked FROM gpt_accounts WHERE id=?").get(target.id)) as any).deactivation_locked, 1);
    const row = page.locator(`[data-account-id="${target.id}"]`);
    await page.getByRole("button", { name: "关闭账号详情" }).click();
    assert.ok((await row.getAttribute("class"))!.includes("deactivated"));
    const plus = fixtures.find((fixture) => fixture.name === "unopened-plus")!;
    assert.ok((await page.locator(`[data-account-id="${plus.id}"]`).getAttribute("class"))!.includes("plus-account"));
    checks.push({ width, cases: fixtures.length, sixDays23HoursDisabled: true, exactlySevenDaysEnabled: true,
      oldUnopenedAccountsNotAutoRecycled: true, readonlyViewAndRefresh: true, cancelledConfirmationNoWrite: true,
      confirmedManualPosts: recycleWrites, grantRevokedOnlyAfterManualReclaim: true, redGreenClassesPreserved: true,
      staleEligibilityCannotCrossAccounts: true, noHorizontalOverflow: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(((await db.prepare("SELECT count(*) AS count FROM mail_read_requests").get()) as any).count, 0);
  console.log(JSON.stringify({ ok: true, checks, upstreamRequests: 0, pageErrors: errors }));
} finally { Date.now = realNow; await browser.close(); await app.close(); (await db.close()); }
