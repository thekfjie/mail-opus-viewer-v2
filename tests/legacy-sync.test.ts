import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("V1 影子同步保留账号标记、账号状态和支付检查结果", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-legacy-sync-"));
  const configFile = path.join(directory, "access-config.json");
  const backupsDirectory = path.join(directory, "backups");
  const sharedIdentityToken = `x.${Buffer.from(JSON.stringify({ sub: "restore-shared-identity" })).toString("base64url")}.x`;
  fs.mkdirSync(backupsDirectory, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify([{
    id: "legacy-sync-1",
    email: "sync-account@icloud.com",
    hasPlus: true,
    // Early V1 snapshots only retained the Ban status text. The projection
    // must restore the immutable deactivation state from that evidence.
    statusMessage: "GPT 已被 Ban，邮箱账号已注销；此链接仅保留注销前邮件。",
    retiredAt: "2026-08-20T00:00:00.000Z",
    domainMailbox: false,
    markColor: "purple",
    groupBoundary: false,
    suspectedUnused: true,
    billingChannel: "stripe",
    hidePromotion: true,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  }, {
    id: "legacy-sync-unreviewed",
    email: "unreviewed-free@icloud.com",
    domainMailbox: false,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  }, {
    id: "direction-old",
    email: "directional@icloud.com",
    rebindNextId: "direction-new",
    rebindNextEmail: "directional@example.net",
    rebindChangedAt: "2026-08-28T00:00:00.000Z",
    openaiOAuth: { accessToken: "old-at-must-not-flow-forward" },
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  }, {
    id: "direction-new",
    email: "directional@example.net",
    domainMailbox: true,
    rebindPreviousId: "direction-old",
    rebindPreviousEmail: "directional@icloud.com",
    rebindChangedAt: "2026-08-28T00:00:00.000Z",
    openaiOAuth: { accessToken: "new-at-owned-by-new-email" },
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:01:00.000Z",
  }, {
    id: "restore-icloud",
    email: "restore-current@icloud.com",
    openaiOAuth: { accessToken: sharedIdentityToken },
    rebindPreviousId: "restore-domain",
    rebindPreviousEmail: "restore-current@example.net",
    rebindChangedAt: "2026-08-31T05:00:00.000Z",
    associationMethod: "openai-email-rebind-restore",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-31T05:00:00.000Z",
  }, {
    id: "restore-domain",
    email: "restore-current@example.net",
    domainMailbox: true,
    openaiOAuth: { accessToken: sharedIdentityToken },
    rebindNextId: "restore-icloud",
    rebindNextEmail: "restore-current@icloud.com",
    rebindChangedAt: "2026-08-31T05:00:00.000Z",
    associationMethod: "openai-email-rebind-restore",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-31T05:00:00.000Z",
  }, {
    id: "transient-target",
    email: "transient@example.net",
    domainMailbox: true,
    rebindTargetPending: true,
    note: "automyai OpenAI email rebind target pending",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  }]));

  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.V1_CONFIG_FILE = configFile;
  process.env.V1_BACKUPS_DIR = backupsDirectory;
  process.env.V1_MAIL_INDEX_FILE = path.join(directory, "missing-mail-index.json");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "legacy-sync-test-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "legacy-sync-test-encryption";
  process.env.V2_READ_ONLY = "true";
  process.env.ROUTING_PRIMARY_EMAIL = "relay@example.net";
  process.env.ROUTING_LEGACY_EMAILS = "legacy-relay@example.net,archive-relay@example.net";
  process.env.ROUTING_EMAILS = "relay@routing.example.net";

  const [{ db }, repository, { syncFromV1 }] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/repository.js"),
    import("../src/server/legacy-import.js"),
  ]);
  t.after(() => db.close());

  const imported = repository.importAccounts([{
    email: "sync-account@icloud.com",
    plan: "plus",
  }]);
  assert.equal(imported.created, 1);
  const accountBefore = repository.listAccounts({ search: "sync-account", limit: 10 }).results[0];
  assert.ok(accountBefore);
  db.exec(`CREATE TABLE promo_eligibility_checks (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES gpt_accounts(id), access_token_fingerprint TEXT NOT NULL DEFAULT '',
    check_kind TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL, eligible INTEGER NOT NULL DEFAULT -1,
    campaign TEXT NOT NULL DEFAULT 'plus-1-month-free', evidence TEXT NOT NULL DEFAULT '', method TEXT NOT NULL DEFAULT 'check_promo',
    endpoint TEXT NOT NULL DEFAULT '/api/tools/chatgpt-promo-check', upstream_status INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', scheduled_at TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  db.prepare(`INSERT INTO promo_eligibility_checks(
    id, account_id, access_token_fingerprint, check_kind, status, eligible, campaign, evidence,
    upstream_status, duration_ms, checked_at, created_at
  ) VALUES(?, ?, ?, 'manual', 'eligible', 1, 'plus-1-month-free', 'fixture eligible_promo_campaigns', 200, 321, ?, ?)`)
    .run("promo-sync-check", accountBefore.id, "fixture-fingerprint", new Date().toISOString(), new Date().toISOString());
  const subjectHash = "legacy-sync-subject-hash";
  const exposure = repository.ingestPaymentExposureChecks([{
    email: "sync-account@icloud.com",
    openaiSubjectHash: subjectHash,
    target: "ideal",
    ipCountry: "NL",
    billingCountry: "NL",
    billingCurrency: "EUR",
    expectedMethod: "ideal",
    availableMethods: ["card", "link"],
    matchedMethods: ["ideal"],
    paymentMethods: [{ id: "cpmt_1togstc6h1nxgoi3wuvey2cj", type: "custom", provider: "stripe", displayName: "Custom card" }],
    trialStatus: "observed",
    exposed: true,
    status: "complete",
  }]);
  assert.deepEqual(exposure, { accepted: 1, updated: 0, errors: [] });
  const sync = syncFromV1();
  assert.equal(sync.paymentExposureRestoredCount, 1);
  assert.equal(sync.promoEligibilityRestoredCount, 1);
  assert.equal(sync.routingCount, 4);
  const accountAfter = repository.listAccounts({ search: "sync-account", limit: 10 }).results[0];
  assert.ok(accountAfter);
  assert.equal(accountAfter.plan, "plus");
  assert.equal(accountAfter.accountStateLabel, "Plus 已停用");
  assert.equal(accountAfter.deactivationLocked, true);
  assert.equal(accountAfter.markColor, "purple");
  assert.equal(accountAfter.groupBoundary, false);
  assert.equal(accountAfter.billingChannel, "stripe");
  assert.equal(accountAfter.suspectedUnused, true);
  assert.equal(accountAfter.hidePromotion, true);
  const unreviewed = repository.listAccounts({ search: "unreviewed-free", limit: 10 }).results[0];
  assert.ok(unreviewed);
  assert.equal(unreviewed.plan, "free");
  assert.equal(unreviewed.hasAccessToken, false);
  assert.equal(unreviewed.hasRefreshToken, false);
  assert.equal(unreviewed.suspectedUnused, false);
  const directional = repository.listAccounts({ search: "directional", limit: 10 }).results[0];
  assert.ok(directional);
  assert.equal(directional.primaryEmail, "directional@example.net");
  assert.equal(directional.hasAccessToken, true);
  assert.equal(repository.revealCredentials(directional.id)?.accessToken, "new-at-owned-by-new-email");
  const restored = repository.listAccounts({ search: "restore-current", limit: 10 }).results[0];
  assert.ok(restored);
  assert.equal(restored.primaryEmail, "restore-current@icloud.com");
  assert.equal(repository.listAccounts({ search: "transient", limit: 10 }).total, 0);
  const detail = repository.getAccountDetail(accountAfter.id);
  assert.ok(detail);
  assert.equal(detail.paymentExposureChecks[0]?.paymentMethods[0]?.id, "cpmt_1togstc6h1nxgoi3wuvey2cj");
  assert.equal(detail.paymentExposureChecks[0]?.trialStatus, "observed");
  const promoAfterFirstSync = db.prepare("SELECT account_id, campaign, status FROM promo_eligibility_checks WHERE id='promo-sync-check'").get() as any;
  assert.equal(promoAfterFirstSync.account_id, accountAfter.id);
  assert.equal(promoAfterFirstSync.campaign, "plus-1-month-free");
  assert.equal(promoAfterFirstSync.status, "eligible");
  repository.createPaymentExposureJob({
    jobId: "exposure-sync-job", accountId: accountAfter.id, routeKey: "nl_ideal", target: "ideal", ipCountry: "NL",
    billingCountry: "NL", billingCurrency: "EUR", status: "running", lastError: "", startedAt: new Date().toISOString(),
    finishedAt: "", createdAt: new Date().toISOString(),
  });
  const secondSync = syncFromV1();
  assert.equal(secondSync.paymentExposureRestoredCount, 1);
  assert.equal(secondSync.promoEligibilityRestoredCount, 1);
  assert.equal(repository.getPaymentExposureJob(accountAfter.id, "exposure-sync-job")?.status, "running");
});
