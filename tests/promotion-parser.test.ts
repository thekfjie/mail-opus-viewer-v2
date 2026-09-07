import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

process.env.DATABASE_PATH = path.join(os.tmpdir(), `mail-opus-promotion-${crypto.randomUUID()}.sqlite`);
process.env.PROJECT_ROOT = process.cwd();
process.env.PAYMENT_EXPOSURE_PROMOTION_PROXY_JP = "http://127.0.0.1:7903";
const [{ db }, { encryptSecret }, { parsePromotionResponse, queuePromotionChecks, scheduleDuePromotionChecks }, repository, { observeCredentialVersion, invalidateCredentialVersion }] = await Promise.all([
  import("../src/server/db.js"),
  import("../src/server/crypto.js"),
  import("../src/server/promotion.js"),
  import("../src/server/repository.js"),
  import("../src/server/credential-versions.js"),
]);

const success = (campaigns: unknown) => ({ ok: true, status: 200, data: { accounts: { TARGET: { eligible_promo_campaigns: campaigns } } } });

test("offline coupon campaigns are treated as unavailable rather than retryable", () => {
  const bridgeSource = fs.readFileSync(path.resolve("scripts/promo-check-bridge.py"), "utf8");
  assert.match(bridgeSource, /INELIGIBLE_STATES\s*=\s*\{[^}]*"offline"/);
  assert.match(bridgeSource, /for campaign in candidates:/);
  assert.doesNotMatch(bridgeSource, /ThreadPoolExecutor/);
  const parsed = parsePromotionResponse({ ...success({}), couponChecks: [
    { campaign: "plus-1-month-free", status: 200, state: "offline", eligible: false },
  ] }, "TARGET");
  assert.equal(parsed.resultStatus, "ineligible");
});

test("promotion parser accepts object, string, array, and metadata campaign shapes", () => {
  for (const value of [
    { plus: { id: "plus-1-month-free" } },
    { plus: "plus-1-month-free" },
    ["plus-1-month-free"],
    [{ metadata: { plan_name: "ChatGPT Plus", duration: { period: "month", num_periods: 1 } } }],
  ]) assert.equal(parsePromotionResponse(success(value), "TARGET").eligible, true);
});

test("promotion parser returns the complete campaign catalog including Go offers", () => {
  const parsed = parsePromotionResponse(success({
    plus: { id: "plus-2-months-50-pct-off" },
    go: { id: "go-3-months-50-pct-off", metadata: { plan_name: "ChatGPT Go", duration: { period: "month", num_periods: 3 } } },
    free: "go-1-month-free",
  }), "TARGET");
  assert.equal(parsed.resultStatus, "eligible");
  assert.deepEqual(parsed.campaigns.map((campaign) => campaign.id).sort(), [
    "go-1-month-free",
    "go-3-months-50-pct-off",
    "plus-2-months-50-pct-off",
  ]);
});

test("promotion parser accepts future campaign IDs without a whitelist", () => {
  const parsed = parsePromotionResponse(success({
    "team-6-months-30-pct-off": { metadata: { plan_name: "ChatGPT Team", duration: { period: "month", num_periods: 6 } } },
    experimental: { id: "edu-12-months-special-2027" },
  }), "TARGET");
  assert.deepEqual(parsed.campaigns.map((campaign) => campaign.id).sort(), [
    "edu-12-months-special-2027",
    "team-6-months-30-pct-off",
  ]);
});

test("promotion parser does not treat an empty catalog as authoritative without coupon checks", () => {
  assert.equal(parsePromotionResponse(success({}), "TARGET").resultStatus, "unknown_retryable");
  assert.equal(parsePromotionResponse({ ...success({}), couponChecks: [
    { campaign: "plus-1-month-free", status: 200, state: "ineligible", eligible: false },
  ] }, "TARGET").resultStatus, "ineligible");
  assert.equal(parsePromotionResponse({ ok: true, status: 200, data: { accounts: { TARGET: {} } } }, "TARGET").resultStatus, "unknown_retryable");
  assert.equal(parsePromotionResponse({ ok: true, status: 200, data: { accounts: { OTHER: { eligible_promo_campaigns: {} } } } }, "TARGET").resultStatus, "unknown_retryable");
});

test("coupon eligibility overrides an empty account catalog", () => {
  const parsed = parsePromotionResponse({ ...success({}), couponChecks: [
    { campaign: "plus-1-month-free", status: 200, state: "eligible", eligible: true },
    { campaign: "go-1-month-free", status: 200, state: "eligible", eligible: true },
  ] }, "TARGET");
  assert.equal(parsed.resultStatus, "eligible");
  assert.deepEqual(parsed.campaigns.map((item) => item.id).sort(), ["go-1-month-free", "plus-1-month-free"]);
});

test("an inconclusive coupon check cannot create a false negative", () => {
  const parsed = parsePromotionResponse({ ...success({}), couponChecks: [
    { campaign: "plus-1-month-free", status: 403, state: "", eligible: null, errorClass: "coupon_http" },
  ] }, "TARGET");
  assert.equal(parsed.resultStatus, "unknown_retryable");
});

test("promotion parser never falls back to the first row of a multi-account response", () => {
  const payload = { ok: true, status: 200, data: { accounts: {
    OTHER: { eligible_promo_campaigns: { plus: "plus-1-month-free" } },
    TARGET: { eligible_promo_campaigns: {} },
  } } };
  assert.equal(parsePromotionResponse(payload, "TARGET").resultStatus, "unknown_retryable");
});

test("promotion parser classifies upstream and credential failures", () => {
  assert.equal(parsePromotionResponse({ ok: false, status: 429, error: "rate limited" }, "TARGET").resultStatus, "unknown_retryable");
  assert.equal(parsePromotionResponse({ ok: false, status: 401, error: "invalid_token" }, "TARGET").resultStatus, "credential_invalid");
  assert.equal(parsePromotionResponse({ ok: false, status: 401, error: {
    message: "Encountered invalidated oauth token for user", code: "token_revoked",
  } }, "TARGET").resultStatus, "credential_invalid");
  assert.equal(parsePromotionResponse({ ok: false, status: 403, error: "edge/CF blocked HTML" }, "TARGET").resultStatus, "unknown_retryable");
});

test("automatic promotion scheduling excludes invalid and conflicting credential versions", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");
  const firstSeen = new Date(now.getTime() - 13 * 60 * 60_000).toISOString();
  db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, arrived_at, created_at, updated_at)
    VALUES('invalid-schedule-account', 'active', ?, ?, ?)`).run(firstSeen, firstSeen, firstSeen);
  db.prepare(`INSERT INTO credential_versions(
    id, account_id, access_token_enc, token_fingerprint, first_seen_at, last_seen_at,
    validity_status, source, created_at, updated_at
  ) VALUES('invalid-schedule-version', 'invalid-schedule-account', ?, 'fingerprint', ?, ?, 'invalid', 'test', ?, ?)`).run(
    encryptSecret("fixture-access-token"), firstSeen, firstSeen, firstSeen, firstSeen,
  );
  db.prepare(`INSERT INTO account_current_credentials(account_id, credential_version_id, selected_at, selection_reason)
    VALUES('invalid-schedule-account', 'invalid-schedule-version', ?, 'test')`).run(firstSeen);
  assert.deepEqual(scheduleDuePromotionChecks(now), { queued: 0 });
  db.prepare("UPDATE credential_versions SET validity_status='alive' WHERE id='invalid-schedule-version'").run();
  assert.deepEqual(scheduleDuePromotionChecks(now), { queued: 1 });

  const job = db.prepare("SELECT id FROM promotion_jobs WHERE account_id='invalid-schedule-account'").get() as any;
  db.prepare("UPDATE promotion_jobs SET status='completed' WHERE id=?").run(job.id);
  db.prepare(`INSERT INTO promotion_observations(
    id, job_id, account_id, credential_version_id, campaign, eligible, result_status,
    upstream_status, evidence_json, response_hash, checked_at, expires_at, created_at
  ) VALUES('one-shot-observation', ?, 'invalid-schedule-account', 'invalid-schedule-version',
    'eligible-promo-catalog', 0, 'ineligible', 200, '{"campaigns":[]}', 'hash', ?, '', ?)`)
    .run(job.id, now.toISOString(), now.toISOString());
  assert.deepEqual(scheduleDuePromotionChecks(new Date(now.getTime() + 30 * 24 * 60 * 60_000)), { queued: 0 });

  const manual = queuePromotionChecks(["invalid-schedule-account"]);
  assert.equal(manual.queued, 1);
  assert.equal(manual.failed, 0);
});

test("Plus 和停用账号不会进入手动、自动或后台优惠检测", () => {
  const now = new Date("2026-09-04T00:00:00.000Z");
  const firstSeen = new Date(now.getTime() - 13 * 60 * 60_000).toISOString();
  for (const [id, plan, lifecycle, locked] of [
    ["promo-plus-account", "plus", "active", 0],
    ["promo-deactivated-account", "free", "deactivated", 1],
  ] as const) {
    db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, deactivation_locked, plan, arrived_at, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(id, lifecycle, locked, plan, firstSeen, firstSeen, firstSeen);
    db.prepare(`INSERT INTO credential_versions(id, account_id, access_token_enc, token_fingerprint, first_seen_at,
      last_seen_at, validity_status, source, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, 'alive', 'test', ?, ?)`)
      .run(`${id}-version`, id, encryptSecret("fixture-access-token"), `${id}-fingerprint`, firstSeen, firstSeen, firstSeen, firstSeen);
    db.prepare(`INSERT INTO account_current_credentials(account_id, credential_version_id, selected_at, selection_reason)
      VALUES(?, ?, ?, 'test')`).run(id, `${id}-version`, firstSeen);
  }
  const manual = queuePromotionChecks(["promo-plus-account", "promo-deactivated-account"]);
  assert.equal(manual.queued, 0);
  assert.equal(manual.skipped, 2);
  assert.equal(manual.failed, 0);
  assert.deepEqual(scheduleDuePromotionChecks(now), { queued: 0 });
});

test("已保存但被 OpenAI 撤销的 AT 明确显示失效且仍保留原文", () => {
  repository.importAccounts([{ email: "stored-invalid-at@example.com", arrivedAt: "2026-09-04T01:00:00.000Z", plan: "free" }]);
  const account = repository.listAccounts({ search: "stored-invalid-at@example.com", limit: 10 }).results[0];
  const observed = observeCredentialVersion({
    accountId: account.id,
    accessToken: "fixture-stored-invalid-access-token",
    source: "legacy-v1",
    observedAt: "2026-09-04T01:01:00.000Z",
    validityStatus: "alive",
  });
  invalidateCredentialVersion(observed.credentialVersionId, "2026-09-04T01:02:00.000Z");
  const result = repository.listAccounts({ search: "stored-invalid-at@example.com", limit: 10 }).results[0];
  assert.equal(result.hasAccessToken, false);
  assert.equal(result.hasStoredAccessToken, true);
  assert.equal(result.credentialState, "invalid_at");
  assert.equal(result.credentialStateLabel, "AT 已保存但已失效");
  assert.equal(repository.revealCredentials(account.id)?.accessToken, "fixture-stored-invalid-access-token");
});

test("凭证失效检查不会覆盖上一次权威优惠结果", () => {
  repository.importAccounts([{ email: "promo-then-revoked@example.com", arrivedAt: "2026-09-04T02:00:00.000Z", plan: "free" }]);
  const account = repository.listAccounts({ search: "promo-then-revoked@example.com", limit: 10 }).results[0];
  const insertJob = db.prepare(`INSERT INTO promotion_jobs(id, account_id, campaign, region, check_kind, due_at, status, created_at, updated_at)
    VALUES(?, ?, 'eligible-promo-catalog', 'JP', 'manual', ?, ?, ?, ?)`);
  const insertObservation = db.prepare(`INSERT INTO promotion_observations(
    id, job_id, account_id, campaign, eligible, result_status, upstream_status,
    evidence_json, response_hash, checked_at, expires_at, created_at
  ) VALUES(?, ?, ?, 'eligible-promo-catalog', ?, ?, ?, ?, ?, ?, '', ?)`);
  const eligibleAt = "2026-09-04T02:01:00.000Z";
  const revokedAt = "2026-09-04T02:02:00.000Z";
  insertJob.run("promo-before-revoked-job", account.id, eligibleAt, "completed", eligibleAt, eligibleAt);
  insertObservation.run("promo-before-revoked-observation", "promo-before-revoked-job", account.id, 1, "eligible", 200,
    JSON.stringify({ campaigns: [{ id: "plus-1-month-free" }] }), "eligible-hash", eligibleAt, eligibleAt);
  insertJob.run("promo-revoked-job", account.id, revokedAt, "credential_invalid", revokedAt, revokedAt);
  insertObservation.run("promo-revoked-observation", "promo-revoked-job", account.id, null, "credential_invalid", 401,
    JSON.stringify({ detail: "token_revoked" }), "revoked-hash", revokedAt, revokedAt);

  const result = repository.listAccounts({ search: "promo-then-revoked@example.com", limit: 10 }).results[0];
  assert.equal(result.promoEligible, true);
  assert.equal(result.trialStatus, "eligible");
  assert.deepEqual(result.promoCampaigns, ["plus-1-month-free"]);
  assert.equal(repository.getAccountDetail(account.id)?.promotion?.status, "eligible");
});

test("latest ineligible result is globally marked suspicious when an older observation was eligible", () => {
  repository.importAccounts([{ email: "promotion-history@example.com", arrivedAt: "2026-09-03T01:00:00.000Z", plan: "free" }]);
  const account = repository.listAccounts({ search: "promotion-history@example.com", limit: 10 }).results[0];
  assert.ok(account);
  const insertJob = db.prepare(`INSERT INTO promotion_jobs(id, account_id, campaign, region, check_kind, due_at, status, created_at, updated_at)
    VALUES(?, ?, 'eligible-promo-catalog', 'JP', 'manual', ?, 'completed', ?, ?)`);
  const insertObservation = db.prepare(`INSERT INTO promotion_observations(
    id, job_id, account_id, campaign, eligible, result_status, upstream_status,
    evidence_json, response_hash, checked_at, expires_at, created_at
  ) VALUES(?, ?, ?, 'eligible-promo-catalog', ?, ?, 200, ?, ?, ?, '', ?)`);
  const oldAt = "2026-09-03T01:10:00.000Z";
  const newAt = "2026-09-03T01:20:00.000Z";
  insertJob.run("history-eligible-job", account.id, oldAt, oldAt, oldAt);
  insertObservation.run("history-eligible-observation", "history-eligible-job", account.id, 1, "eligible",
    JSON.stringify({ campaigns: [{ id: "plus-1-month-free" }] }), "old-hash", oldAt, oldAt);
  insertJob.run("history-ineligible-job", account.id, newAt, newAt, newAt);
  insertObservation.run("history-ineligible-observation", "history-ineligible-job", account.id, 0, "ineligible",
    JSON.stringify({ campaigns: [] }), "new-hash", newAt, newAt);

  const result = repository.listAccounts({ search: "promotion-history@example.com", limit: 10 }).results[0];
  assert.equal(result.promoEligible, false);
  assert.equal(result.promoSuspicious, true);
  assert.deepEqual(result.historicalPromoCampaigns, ["plus-1-month-free"]);
  assert.equal(result.promotionCheckStatus, "completed");
});


test("manual suspicion annotates an authoritative no-promo result without rewriting observations", () => {
  const existing = repository.listAccounts({ search: "promotion-history@example.com", limit: 10 }).results[0];
  assert.ok(existing);
  repository.setPromotionSuspicion(existing.id, true);
  const marked = repository.listAccounts({ search: "promotion-history@example.com", limit: 10 }).results[0];
  assert.equal(marked.promoEligible, false);
  assert.equal(marked.promoSuspicious, true);
  assert.equal(marked.promoSuspiciousOverride, true);
  repository.setPromotionSuspicion(existing.id, false);
  const cleared = repository.listAccounts({ search: "promotion-history@example.com", limit: 10 }).results[0];
  assert.equal(cleared.promoSuspiciousOverride, false);
  assert.equal(cleared.promoSuspicious, true, "historical eligible evidence still keeps the automatic suspicion");
});
