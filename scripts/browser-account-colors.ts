import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [playwrightModule, executablePath] = process.argv.slice(2);
if (!playwrightModule || !executablePath) throw new Error("Pass installed Playwright and Chromium paths; no downloads are performed");
if (process.env.ENV_FILE !== "/dev/null" || !String(process.env.DATABASE_PATH).includes("opus-v2-offline-")) {
  throw new Error("Run through scripts/test-offline.mjs with its temporary database and fake credentials");
}
const { chromium } = await import(pathToFileURL(path.resolve(playwrightModule)).href);
const { db } = await import("../src/server/db.js");
const { importAccounts, listAccounts, deactivateAccount } = await import("../src/server/repository.js");
const { buildApp } = await import("../src/server/server.js");
const artifacts = path.resolve("artifacts/browser");
fs.mkdirSync(artifacts, { recursive: true });
const fixtures = [
  { email: "color-plus@icloud.com", plan: "plus", status: "active", mark: "purple", channel: "", tone: "green", row: "plus-account" },
  { email: "color-channel@outlook.com", plan: "plus", status: "active", mark: "blue", channel: "us-paypal", tone: "green", row: "plus-account" },
  { email: "color-plus-banned@example.com", plan: "plus", status: "deactivated", mark: "green", channel: "id-gopay", tone: "red", row: "deactivated" },
  { email: "color-free-banned@icloud.com", plan: "free", status: "deactivated", mark: "purple", channel: "", tone: "red", row: "deactivated" },
  { email: "color-outlook-banned@outlook.com", plan: "free", status: "deactivated", mark: "blue", channel: "", tone: "red", row: "deactivated" },
  { email: "color-free@example.com", plan: "free", status: "active", mark: "red", channel: "", tone: "green", row: "" },
  { email: "color-conflict@example.com", plan: "plus", status: "quarantined", mark: "yellow", channel: "", tone: "yellow", row: "" },
  { email: "color-retired@example.com", plan: "plus", status: "retired", mark: "orange", channel: "", tone: "gray", row: "" },
];
const imported = importAccounts(fixtures.map((fixture, index) => ({ email: fixture.email, plan: fixture.plan,
  accessToken: [Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ sub: `offline-color-${index}`,
    email: fixture.email, exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_plan_type: fixture.plan } })).toString("base64url"), "offline-signature"].join("."),
  refreshToken: `offline-color-refresh-${index}`,
})));
assert.equal(imported.errors.length, 0);
const accounts = listAccounts({ limit: 100 }).results;
const cases = fixtures.map((fixture) => ({ ...fixture, id: accounts.find((account) => account.primaryEmail === fixture.email)!.id }));
for (const fixture of cases) {
  if (fixture.status === "deactivated") deactivateAccount(fixture.id, "offline-color-fixture");
  else db.prepare("UPDATE gpt_accounts SET lifecycle_status=?, identity_status=? WHERE id=?")
    .run(fixture.status, fixture.status === "quarantined" ? "conflict" : "confirmed", fixture.id);
  db.prepare("UPDATE gpt_accounts SET mark_color=?, billing_channel=?, group_boundary=? WHERE id=?")
    .run(fixture.mark, fixture.channel, fixture.email === "color-free@example.com" ? 1 : 0, fixture.id);
}
globalThis.fetch = async () => { throw new Error("Account color fixture cannot access upstream"); };
const app = await buildApp();
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors: string[] = [];
const checks: Record<string, unknown>[] = [];
try {
  for (const width of [1440, 800, 390]) {
    for (const theme of ["dark", "light"]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
      await context.route("**/*", (route: any) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      // tsx may annotate nested functions with its name helper when serializing
      // evaluate callbacks; this shim only exists in the synthetic browser.
      await context.addInitScript("globalThis.__name = (target) => target;");
      await context.addInitScript((value: string) => localStorage.setItem("opus-v2-admin-theme-reference", value), theme);
      const page = await context.newPage();
      page.on("pageerror", (error: Error) => errors.push(error.message));
      await page.goto(`${origin}/admin`);
      await page.getByPlaceholder("后台口令").fill("offline-admin-not-for-deployment");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.locator("tr.account-table-row").first().waitFor();
      await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
      assert.equal(await page.locator("tr.account-table-row").count(), fixtures.length);
      const inspect = async (id: string) => page.locator(`[data-account-id="${id}"]`).evaluate((element: HTMLElement) => {
        const rgb = (value: string) => {
          const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!; context.fillStyle = value; context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
        };
        const style = getComputedStyle(element);
        const led = element.querySelector(".state-cell .status-led")!;
        const mark = element.querySelector(".account-title .mark-dot")!;
        return { classes: element.className, background: rgb(style.backgroundColor), panel: rgb(style.getPropertyValue("--panel")),
          led: rgb(getComputedStyle(led).backgroundColor), ledClass: led.className, markClass: mark.className,
          mark: rgb(getComputedStyle(mark).backgroundColor), accent: style.getPropertyValue("--account-row-accent").trim(),
          shadow: innerWidth <= 860 ? style.boxShadow : getComputedStyle(element.querySelector("td")!).boxShadow,
          outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, state: element.querySelector(".state-cell strong")!.textContent,
          plan: element.querySelector(".plan-badge")!.textContent, boundary: style.borderTopWidth,
          boundaryCell: getComputedStyle(element.querySelector("td")!).borderTopWidth };
      });
      const verify = (fixture: typeof cases[number], value: Awaited<ReturnType<typeof inspect>>, selected = false) => {
        assert.ok(value.ledClass.split(" ").includes(fixture.tone), `${fixture.email} LED ${width}/${theme}`);
        assert.ok(value.markClass.split(" ").includes(fixture.mark), "manual color remains independent");
        assert.equal(value.classes.split(" ").includes("plus-account"), fixture.row === "plus-account");
        assert.equal(value.classes.split(" ").includes("deactivated"), fixture.row === "deactivated");
        if (fixture.row) {
          const channel = fixture.tone === "green" ? 1 : 0;
          const other = fixture.tone === "green" ? 0 : 1;
          assert.ok(value.led[channel] > value.led[other], "actual status LED has semantic color");
          const delta = value.background.map((part: number, index: number) => part - value.panel[index]);
          assert.ok(delta[channel] > delta[other] + 4, `actual ${fixture.tone} row survives ${width}/${theme}`);
          assert.ok(value.accent && value.shadow !== "none", "visible semantic stripe");
        } else if (!selected) assert.deepEqual(value.background, value.panel, "non-active Plus does not acquire a green row");
        if (selected) {
          assert.ok(value.classes.includes("selected-row"));
          assert.equal(value.outlineStyle, "solid");
          assert.equal(value.outlineWidth, "1px");
        }
        if (fixture.status === "deactivated") assert.equal(value.state, "永久停用");
        if (fixture.status === "quarantined") assert.equal(value.state, "凭证归属冲突");
        if (fixture.status === "retired") assert.equal(value.state, "历史回收");
      };
      for (const fixture of cases) {
        const row = page.locator(`[data-account-id="${fixture.id}"]`);
        await row.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        verify(fixture, await inspect(fixture.id));
        assert.equal(await row.locator(".plan-badge").isVisible(), true);
        assert.equal(await row.locator(".state-cell strong").isVisible(), true);
        if (fixture.row) {
          await row.locator(".account-title").hover();
          verify(fixture, await inspect(fixture.id));
          await row.locator(".account-title").click();
          verify(fixture, await inspect(fixture.id), true);
          assert.equal(await row.locator(".selection-handle").getAttribute("aria-pressed"), "true");
          await page.mouse.move(0, 0);
          verify(fixture, await inspect(fixture.id), true);
          await row.locator(".account-title").click();
        }
      }
      const boundary = await inspect(cases.find((fixture) => fixture.mark === "red")!.id);
      assert.equal(width <= 860 ? boundary.boundary : boundary.boundaryCell, "3px", "manual red group boundary remains visible");
      const channelPlan = await inspect(cases[1].id);
      assert.equal(channelPlan.plan, "美区 PP");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: path.join(artifacts, `account-colors-${width}-${theme}.png`), fullPage: true });
      const banned = page.locator(`[data-account-id="${cases[2].id}"]`);
      await banned.locator(".detail-toggle").click();
      await page.locator(".detail-drawer-scroll .detail-section-heading").first().waitFor();
      const drawer = await page.locator(".detail-drawer").boundingBox();
      assert.ok(drawer && drawer.x >= -1 && drawer.x + drawer.width <= width + 1);
      assert.equal(await page.locator(".detail-drawer-badges .badge.red").getByText("已停用", { exact: true }).isVisible(), true);
      await page.getByRole("button", { name: "关闭账号详情" }).click();
      checks.push({ width, theme, accounts: cases.length, greenPlus: 2, redBanned: 3, neutralLifecycle: 3,
        hoverAndSelection: true, manualColorsAndBoundary: true, channelBadge: true, detail: true, noHorizontalOverflow: true });
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  assert.equal((db.prepare("SELECT count(*) AS count FROM mail_read_requests").get() as any).count, 0);
  console.log(JSON.stringify({ ok: true, checks, upstreamRequests: 0, pageErrors: errors }));
} finally {
  await browser.close(); await app.close(); db.close();
}
