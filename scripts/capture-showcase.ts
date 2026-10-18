import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// This script intentionally requires the isolated wrapper; never seed a real database.
if (process.env.ENV_FILE !== "/dev/null" || process.env.OPUS_SQLITE_TEST !== "1"
  || !String(process.env.DATABASE_PATH).includes("opus-v2-offline-")) {
  throw new Error("Run through scripts/test-offline.mjs with OPUS_SQLITE_TEST=1");
}
const [playwrightModule, executablePath] = process.argv.slice(2);
if (!playwrightModule || !executablePath) throw new Error("Pass installed Playwright and Chromium paths; no downloads are performed");
const { chromium } = await import(pathToFileURL(path.resolve(playwrightModule)).href);
globalThis.fetch = async () => { throw new Error("Showcase cannot access upstream services"); };
const { db } = await import("../src/server/db.js");
const repo = await import("../src/server/repository.js");
const { buildApp } = await import("../src/server/server.js");
const output = path.resolve("docs/assets");
fs.mkdirSync(output, { recursive: true });
const checkedAt = "2026-10-17T02:30:00.000Z";
const fixtures = [
  { email: "alex.river@example.com", plan: "free", mark: "blue", offers: ["plus-1-month-50-pct-off", "go-1-month-free"] },
  { email: "morgan.cedar@icloud.com", plan: "plus", mark: "purple", offers: [] },
  { email: "jules.harbor@icloud.com", plan: "free", mark: "green", offers: ["plus-1-month-free"] },
  { email: "noah.willow@example.net", plan: "free", mark: "", offers: ["go-1-month-free"] },
  { email: "riley.stone@outlook.com", plan: "free", mark: "blue", offers: [] },
  { email: "sam.orbit@icloud.com", plan: "free", mark: "", offers: [] },
  { email: "kai.meadow@example.org", plan: "free", mark: "yellow", offers: ["plus-1-month-50-pct-off"] },
  { email: "taylor.brook@icloud.com", plan: "free", mark: "", offers: [] },
];
function token(email: string, index: number, revision = 1) {
  return [Buffer.from('{"alg":"none"}').toString("base64url"), Buffer.from(JSON.stringify({
    sub: `demo-showcase-${index}`, email, revision, exp: 4_000_000_000,
    "https://api.openai.com/auth": { chatgpt_plan_type: fixtures[index].plan },
  })).toString("base64url"), "demo-signature-not-valid"].join(".");
}
const imported = await repo.importAccounts(fixtures.map((fixture, index) => ({ ...fixture,
  accessToken: token(fixture.email, index), refreshToken: index % 3 ? `demo-refresh-${index}` : undefined,
  openaiPassword: "DEMO-password-not-for-login", totpSecret: "JBSWY3DPEHPK3PXP",
  arrivedAt: `2026-10-${String(17 - index).padStart(2, "0")}T06:15:00.000Z`,
  note: "界面演示数据 · 不对应真实账号",
})));
assert.deepEqual(imported.errors, []);
const accounts = (await repo.listAccounts({ limit: 100 })).results;
for (const [index, fixture] of fixtures.entries()) {
  const account = accounts.find(item => item.primaryEmail === fixture.email)!;
  assert.ok(account);
  await db.prepare("UPDATE gpt_accounts SET mark_color=? WHERE id=?").run(fixture.mark, account.id);
  if (index === 1) {
    await db.prepare("UPDATE gpt_accounts SET billing_channel='us-paypal' WHERE id=?").run(account.id);
    await db.prepare("INSERT INTO account_business_evidence(account_id,billing_started_at,updated_at) VALUES(?,?,?)")
      .run(account.id, "2026-10-04T08:00:00.000Z", checkedAt);
  }
  if (index === 5) await repo.deactivateAccount(account.id, "showcase-fixture");
  if (index === 0) {
    await repo.createRebind(account.id, "alex.river@example.net");
    await repo.saveAccountCredentials(account.id, { accessToken: token("alex.river@example.net", index, 2) });
    // Keep the synthetic timeline aligned with the documented screenshot dataset.
    await db.prepare("UPDATE gpt_accounts SET arrived_at=? WHERE id=?").run("2026-10-17T06:15:00.000Z", account.id);
  }
  if (index === 5 || index === 1) continue;
  const jobId = `showcase-job-${index}`;
  const eligible = Number(fixture.offers.length > 0);
  await db.prepare(`INSERT INTO promotion_jobs(id,account_id,campaign,due_at,status,created_at,updated_at)
    VALUES(?,?,?,?,'completed',?,?)`).run(jobId, account.id, fixture.offers[0] || "plus-1-month-free", checkedAt, checkedAt, checkedAt);
  await db.prepare(`INSERT INTO promotion_observations(id,job_id,account_id,campaign,eligible,result_status,
    upstream_status,evidence_json,checked_at,created_at) VALUES(?,?,?,?,?,?,200,?,?,?)`)
    .run(`showcase-observation-${index}`, jobId, account.id, fixture.offers[0] || "plus-1-month-free", eligible,
      eligible ? "eligible" : "ineligible", JSON.stringify({ campaigns: fixture.offers.map(id => ({ id })) }), checkedAt, checkedAt);
}
const app = await buildApp();
let browser: any;
const pageErrors: string[] = [];
try {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  for (const [name, viewport, theme] of [
    ["overview-dark", { width: 1680, height: 1120 }, "dark"],
    ["overview-mobile", { width: 430, height: 932 }, "light"],
  ] as const) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addInitScript((value: string) => localStorage.setItem("opus-v2-admin-theme-reference", value), theme);
    const page = await context.newPage();
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.goto(`${origin}/admin`);
    await page.getByPlaceholder("后台口令").fill("offline-admin-not-for-deployment");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator("tr.account-table-row").first().waitFor();
    await page.locator(".metric-grid").waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
    if (name === "overview-dark") {
      await page.locator(".detail-toggle").first().click();
      await page.locator(".detail-drawer-scroll .detail-section-heading").first().waitFor();
      await page.locator(".detail-payment-group > summary").click();
      await page.locator(".detail-routing-group > summary").click();
      await page.locator(".detail-credential-group > summary").click();
      await page.screenshot({ path: path.join(output, "account-detail.png"), animations: "disabled" });
    }
    await context.close();
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ screenshots: 3, syntheticAccounts: fixtures.length, pageErrors, upstreamRequests: 0 }));
} finally {
  await browser?.close();
  await app.close();
  await db.close();
}
