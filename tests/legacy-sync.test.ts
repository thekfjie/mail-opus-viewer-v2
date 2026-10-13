import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("V1 影子同步保留账号标记、账号状态和支付检查结果", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-legacy-sync-"));
  const configFile = path.join(directory, "access-config.json");
  const mailIndexFile = path.join(directory, "mail-index-cache.json");
  const outboxFile = path.join(directory, "v1-change-outbox.jsonl");
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
    id: "indexed-deactivation",
    email: "indexed-deactivation@example.com",
    domainMailbox: true,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  }, {
    id: "direction-old",
    email: "directional@icloud.com",
    rebindNextId: "direction-new",
    rebindNextEmail: "directional@kfjie.me",
    rebindChangedAt: "2026-08-28T00:00:00.000Z",
    openaiOAuth: { accessToken: "old-at-must-not-flow-forward" },
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  }, {
    id: "direction-new",
    email: "directional@kfjie.me",
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
    rebindPreviousEmail: "restore-current@kfjie.me",
    rebindChangedAt: "2026-08-31T05:00:00.000Z",
    associationMethod: "openai-email-rebind-restore",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-31T05:00:00.000Z",
  }, {
    id: "restore-domain",
    email: "restore-current@kfjie.me",
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
    email: "transient@kfjie.me",
    domainMailbox: true,
    rebindTargetPending: true,
    note: "automyai OpenAI email rebind target pending",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  }]));
  fs.writeFileSync(mailIndexFile, JSON.stringify({ version: 2, entries: {
    "indexed-deactivation": {
      mails: [{
        id: "indexed-deactivation-mail",
        address: "indexed-deactivation@example.com",
        from: "OpenAI <trustandsafety@tm.openai.com>",
        to: "indexed-deactivation@example.com",
        subject: "OpenAI - Access Deactivated [C-indexed]",
        created_at_utc: "2026-09-06T19:07:39.000Z",
        folder: "inbox",
        envelopeRecipients: ["indexed-deactivation@example.com"],
      }],
    },
    "legacy-sync-unreviewed": {
      mails: [{
        id: "misassociated-deactivation-mail",
        address: "somebody-else@example.com",
        from: "OpenAI <trustandsafety@tm.openai.com>",
        to: "somebody-else@example.com",
        subject: "OpenAI - Access Deactivated [C-misassociated]",
        created_at_utc: "2026-09-06T20:00:00.000Z",
        folder: "inbox",
      }],
    },
  }}));

  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.V1_CONFIG_FILE = configFile;
  process.env.V1_BACKUPS_DIR = backupsDirectory;
  process.env.V1_MAIL_INDEX_FILE = mailIndexFile;
  process.env.V1_CHANGE_OUTBOX_FILE = outboxFile;
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "legacy-sync-test-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "legacy-sync-test-encryption";
  process.env.V2_READ_ONLY = "true";
  process.env.V2_ACCOUNT_AUTHORITY = "v1";
  process.env.ROUTING_PRIMARY_EMAIL = "relay@example.net";
  process.env.ROUTING_LEGACY_EMAILS = "legacy-relay@example.net,archive-relay@example.net";
  process.env.ROUTING_EMAILS = "relay@routing.example.net";

  const [{ db }, repository, { syncFromV1 }, { consumeV1Outbox }] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/repository.js"),
    import("../src/server/legacy-import.js"),
    import("../src/server/sync-outbox.js"),
  ]);
  t.after(async () => (await db.close()));

  const imported = (await repository.importAccounts([{
    email: "sync-account@icloud.com",
    plan: "plus",
  }]));
  assert.equal(imported.created, 1);
  const accountBefore = (await repository.listAccounts({ search: "sync-account", limit: 10 })).results[0];
  assert.ok(accountBefore);
  (await db.exec(`CREATE TABLE promo_eligibility_checks (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES gpt_accounts(id), access_token_fingerprint TEXT NOT NULL DEFAULT '',
    check_kind TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL, eligible INTEGER NOT NULL DEFAULT -1,
    campaign TEXT NOT NULL DEFAULT 'plus-1-month-free', evidence TEXT NOT NULL DEFAULT '', method TEXT NOT NULL DEFAULT 'check_promo',
    endpoint TEXT NOT NULL DEFAULT '/api/tools/chatgpt-promo-check', upstream_status INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', scheduled_at TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`));
  (await db.prepare(`INSERT INTO promo_eligibility_checks(
    id, account_id, access_token_fingerprint, check_kind, status, eligible, campaign, evidence,
    upstream_status, duration_ms, checked_at, created_at
  ) VALUES(?, ?, ?, 'manual', 'eligible', 1, 'plus-1-month-free', 'fixture eligible_promo_campaigns', 200, 321, ?, ?)`)
    .run("promo-sync-check", accountBefore.id, "fixture-fingerprint", new Date().toISOString(), new Date().toISOString()));
  const subjectHash = "legacy-sync-subject-hash";
  const exposure = (await repository.ingestPaymentExposureChecks([{
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
  }]));
  assert.deepEqual(exposure, { accepted: 1, updated: 0, errors: [] });
  const sync = (await syncFromV1({ legacyAuthoritative: true }));
  assert.equal(sync.paymentExposureRestoredCount, 1);
  assert.equal(sync.promoEligibilityRestoredCount, 1);
  assert.equal(sync.routingCount, 4);
  const accountAfter = (await repository.listAccounts({ search: "sync-account", limit: 10 })).results[0];
  assert.ok(accountAfter);
  assert.equal(accountAfter.plan, "plus");
  assert.equal(accountAfter.accountStateLabel, "Plus 已停用");
  assert.equal(accountAfter.deactivationLocked, true);
  assert.equal(accountAfter.markColor, "purple");
  assert.equal(accountAfter.groupBoundary, false);
  assert.equal(accountAfter.billingChannel, "stripe");
  assert.equal(accountAfter.suspectedUnused, true);
  assert.equal(accountAfter.hidePromotion, true);
  const indexedDeactivation = (await repository.listAccounts({ search: "indexed-deactivation", limit: 10 })).results[0];
  assert.ok(indexedDeactivation);
  assert.equal(indexedDeactivation.accountStateLabel, "Free 已停用");
  assert.equal(indexedDeactivation.deactivationLocked, true);
  assert.equal(indexedDeactivation.deactivatedAt, "2026-09-06T19:07:39.000Z");
  const unreviewed = (await repository.listAccounts({ search: "unreviewed-free", limit: 10 })).results[0];
  assert.ok(unreviewed);
  assert.equal(unreviewed.plan, "free");
  assert.equal(unreviewed.deactivationLocked, false);
  assert.equal(unreviewed.hasAccessToken, false);
  assert.equal(unreviewed.hasRefreshToken, false);
  assert.equal(unreviewed.suspectedUnused, false);
  (await db.prepare(`UPDATE gpt_accounts SET lifecycle_status='quarantined', identity_status='conflict',
    quarantined_at=?, quarantine_reason='secondary projection conflict' WHERE id=?`).run(new Date().toISOString(), unreviewed.id));
  (await db.prepare(`INSERT INTO pending_reviews(id, review_type, account_id, candidate_email_hash, reason, created_at, updated_at)
    VALUES('secondary-review', 'sub2api_rebind', ?, 'candidate', 'secondary projection conflict', ?, ?)`).run(
    unreviewed.id, new Date().toISOString(), new Date().toISOString(),
  ));
  (await syncFromV1({ legacyAuthoritative: true }));
  const v1Restored = (await db.prepare(`SELECT lifecycle_status, identity_status, quarantined_at, quarantine_reason
    FROM gpt_accounts WHERE id=?`).get(unreviewed.id)) as any;
  assert.deepEqual(v1Restored, { lifecycle_status: "active", identity_status: "unknown", quarantined_at: "", quarantine_reason: "" });
  assert.equal(((await db.prepare("SELECT count(*) count FROM pending_reviews WHERE status='pending'").get()) as any).count, 0);
  const directional = (await repository.listAccounts({ search: "directional", limit: 10 })).results[0];
  assert.ok(directional);
  assert.equal(directional.primaryEmail, "directional@kfjie.me");
  assert.equal(directional.hasAccessToken, true);
  assert.equal((await repository.revealCredentials(directional.id))?.accessToken, "new-at-owned-by-new-email");
  const withoutCurrentCredential = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const previousCurrent = withoutCurrentCredential.find((item: any) => item.id === "direction-new");
  previousCurrent.rebindNextId = "direction-newer";
  previousCurrent.rebindNextEmail = "directional@ai-mail.tech";
  previousCurrent.rebindChangedAt = "2026-08-29T00:00:00.000Z";
  withoutCurrentCredential.push({
    id: "direction-newer",
    email: "directional@ai-mail.tech",
    domainMailbox: true,
    bindingVerified: true,
    rebindPreviousId: "direction-new",
    rebindPreviousEmail: "directional@kfjie.me",
    rebindChangedAt: "2026-08-29T01:00:00.000Z",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:01:00.000Z",
  });
  fs.writeFileSync(configFile, JSON.stringify(withoutCurrentCredential));
  (await syncFromV1({ legacyAuthoritative: true }));
  const directionalMissing = (await repository.listAccounts({ search: "directional", limit: 10 })).results[0];
  assert.ok(directionalMissing);
  assert.equal(directionalMissing.primaryEmail, "directional@ai-mail.tech");
  assert.equal(directionalMissing.hasAccessToken, false);
  // Manual read/copy returns the newest retained AT even when it is invalid;
  // automated checks still require an alive current credential.
  assert.equal((await repository.revealCredentials(directionalMissing.id))?.accessToken, "new-at-owned-by-new-email");
  assert.equal((await repository.getPaymentExposureCredentials(directionalMissing.id)), null);
  assert.equal(((await db.prepare(`SELECT cv.validity_status FROM account_current_credentials cc
    JOIN credential_versions cv ON cv.id=cc.credential_version_id WHERE cc.account_id=?`).get(directionalMissing.id)) as any).validity_status, "invalid");
  const sharedCredential = JSON.parse(fs.readFileSync(configFile, "utf8"));
  sharedCredential.find((item: any) => item.id === "direction-newer").openaiOAuth = { accessToken: "new-at-owned-by-new-email" };
  fs.writeFileSync(configFile, JSON.stringify(sharedCredential));
  (await syncFromV1({ legacyAuthoritative: true }));
  const directionalShared = (await repository.listAccounts({ search: "directional", limit: 10 })).results[0];
  assert.ok(directionalShared);
  assert.equal(directionalShared.hasAccessToken, true);
  assert.equal((await repository.revealCredentials(directionalShared.id))?.accessToken, "new-at-owned-by-new-email");
  assert.equal(((await db.prepare("SELECT count(*) count FROM credential_versions WHERE account_id=?").get(directionalShared.id)) as any).count, 1);
  const restored = (await repository.listAccounts({ search: "restore-current", limit: 10 })).results[0];
  assert.ok(restored);
  assert.equal(restored.primaryEmail, "restore-current@icloud.com");
  assert.equal((await repository.listAccounts({ search: "transient", limit: 10 })).total, 0);
  const detail = (await repository.getAccountDetail(accountAfter.id));
  assert.ok(detail);
  assert.equal(detail.paymentExposureChecks[0]?.paymentMethods[0]?.id, "cpmt_1togstc6h1nxgoi3wuvey2cj");
  assert.equal(detail.paymentExposureChecks[0]?.trialStatus, "observed");
  const promoAfterFirstSync = (await db.prepare("SELECT account_id, campaign, status FROM promo_eligibility_checks WHERE id='promo-sync-check'").get()) as any;
  assert.equal(promoAfterFirstSync.account_id, accountAfter.id);
  assert.equal(promoAfterFirstSync.campaign, "plus-1-month-free");
  assert.equal(promoAfterFirstSync.status, "eligible");
  (await repository.createPaymentExposureJob({
    jobId: "exposure-sync-job", accountId: accountAfter.id, routeKey: "nl_ideal", target: "ideal", ipCountry: "NL",
    billingCountry: "NL", billingCurrency: "EUR", status: "running", lastError: "", startedAt: new Date().toISOString(),
    finishedAt: "", createdAt: new Date().toISOString(),
  }));
  const secondSync = (await syncFromV1({ legacyAuthoritative: true }));
  assert.equal(secondSync.paymentExposureRestoredCount, 1);
  assert.equal(secondSync.promoEligibilityRestoredCount, 1);
  assert.equal((await repository.getPaymentExposureJob(accountAfter.id, "exposure-sync-job"))?.status, "running");

  const event = (id: string) => JSON.stringify({
    eventId: id, aggregateType: "mapping_collection", aggregateId: "access-config", aggregateVersion: 1,
    eventType: "mapping_collection_changed", occurredAt: "2026-09-02T00:00:00.000Z",
    payload: { sourceRevision: id, changedIds: [id], deletedIds: [], count: 1 },
  });
  const first = `${event("outbox-1")}\n`;
  const second = `${event("outbox-2")}\n`;
  fs.writeFileSync(outboxFile, `${first}${second.slice(0, 20)}`);
  assert.deepEqual((await consumeV1Outbox()), { consumed: 1, cursor: Buffer.byteLength(first), reset: false });
  fs.appendFileSync(outboxFile, second.slice(20));
  assert.deepEqual((await consumeV1Outbox()), { consumed: 1, cursor: Buffer.byteLength(first + second), reset: false });
  assert.equal((await consumeV1Outbox()).consumed, 0);
  fs.writeFileSync(outboxFile, `${event("x")}\n`);
  const replay = (await consumeV1Outbox());
  assert.equal(replay.reset, true);
  assert.equal(replay.consumed, 1);
  assert.equal(((await db.prepare("SELECT count(*) count FROM change_outbox WHERE source_system='v1'").get()) as any).count, 3);
});
