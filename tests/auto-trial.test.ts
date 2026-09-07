import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("自动试用检测在 AT 发现 12 小时后触发并按 AT 去重", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-auto-trial-"));
  const requests: any[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/extract/jobs") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      requests.push(JSON.parse(body));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ job: { id: `auto-job-${requests.length}`, status: "queued" } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  Object.assign(process.env, {
    PROJECT_ROOT: directory,
    V1_ENV_FILE: path.join(directory, "missing-v1.env"),
    DATABASE_PATH: path.join(directory, "test.sqlite"),
    V2_SESSION_SECRET: "auto-trial-session",
    CREDENTIAL_ENCRYPTION_KEY: "auto-trial-encryption",
    V2_READ_ONLY: "true",
    V2_AUTO_TRIAL_ENABLED: "true",
    V2_AUTO_TRIAL_DELAY_MS: String(12 * 60 * 60 * 1000),
    V2_AUTO_TRIAL_RETRY_MS: String(60 * 60 * 1000),
    V2_AUTO_TRIAL_BATCH_SIZE: "5",
    V2_AUTO_TRIAL_ROUTE: "nl_ideal",
    AUTOMYAI_EXTRACT_API_BASE: `http://127.0.0.1:${address.port}`,
    PAYMENT_EXPOSURE_PROXY_NL: "http://checkout-nl.test:7909",
    PAYMENT_EXPOSURE_PROMOTION_PROXY_JP: "http://promotion-jp.test:7903",
    PAYMENT_EXPOSURE_PROMO_CAMPAIGN_ID: "plus-1-month-free",
  });

  const [{ db }, repository, paymentExposure] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/repository.js"),
    import("../src/server/payment-exposure.js"),
  ]);
  t.after(() => db.close());

  const imported = repository.importAccounts([{
    email: "trial-check@icloud.com",
    accessToken: "at-first",
    openaiSubject: "trial-check-subject",
    plan: "free",
  }]);
  assert.equal(imported.created, 1);
  const account = repository.listAccounts({ limit: 5 }).results[0];
  assert.ok(account);
  assert.equal(repository.listAutomaticTrialCandidates(5).length, 0);

  const oldSeen = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE credentials SET access_token_first_seen_at=? WHERE account_id=?").run(oldSeen, account.id);
  const due = repository.listAutomaticTrialCandidates(5);
  assert.equal(due.length, 1);
  assert.equal(due[0].routeKey, "nl_ideal");
  assert.equal(due[0].dueAt, new Date(Date.parse(oldSeen) + 12 * 60 * 60 * 1000).toISOString());

  const started = await paymentExposure.runAutomaticTrialChecks();
  assert.deepEqual(started, { enabled: true, candidates: 1, started: 1, failed: 0, skipped: 0, errors: [] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "payment_exposure");
  assert.equal(requests[0].options.promoCampaignId, "plus-1-month-free");
  assert.equal(requests[0].options.promotionProxy, "http://promotion-jp.test:7903");
  assert.equal(requests[0].options.promotionProxyRegion, "JP");
  assert.equal(requests[0].options.countryPromotionProxies.JP, "http://promotion-jp.test:7903");
  assert.equal(requests[0].options.paymentExposureTargets[0].promotionProxy, "http://promotion-jp.test:7903");
  const autoJob = db.prepare("SELECT job_kind, access_token_fingerprint, scheduled_at, status FROM payment_exposure_jobs").get() as any;
  assert.equal(autoJob.job_kind, "auto_trial");
  assert.equal(autoJob.scheduled_at, due[0].dueAt);
  assert.equal(repository.listAutomaticTrialCandidates(5).length, 0);

  repository.importAccounts([{
    email: "trial-check@icloud.com",
    accessToken: "at-second",
    openaiSubject: "trial-check-subject",
  }]);
  const refreshed = db.prepare("SELECT access_token_fingerprint, access_token_first_seen_at FROM credentials WHERE account_id=?").get(account.id) as any;
  assert.notEqual(refreshed.access_token_fingerprint, due[0].accessTokenFingerprint);
  assert.ok(Date.parse(refreshed.access_token_first_seen_at) > Date.parse(oldSeen));
  assert.equal(repository.listAutomaticTrialCandidates(5).length, 0);
  db.prepare("UPDATE credentials SET access_token_first_seen_at=? WHERE account_id=?").run(oldSeen, account.id);
  assert.equal(repository.listAutomaticTrialCandidates(5).length, 1);

  const manual = await paymentExposure.startTrialCheck(account.id);
  assert.equal(manual.jobKind, "manual_trial");
  assert.equal(db.prepare("SELECT access_token_fingerprint FROM payment_exposure_jobs WHERE job_id=?").get(manual.jobId).access_token_fingerprint, refreshed.access_token_fingerprint);
  assert.equal(repository.listAutomaticTrialCandidates(5).length, 0);
  db.prepare("UPDATE payment_exposure_jobs SET status='completed' WHERE job_id=?").run(manual.jobId);
  assert.equal(repository.listAutomaticTrialCandidates(5).length, 1);
});
