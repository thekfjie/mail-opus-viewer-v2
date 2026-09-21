import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

test("多账号单 route 只创建一个远程批次并按 tokenHash 分别映射落库", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-payment-batch-"));
  const tokens = ["fake-batch-token-a", "fake-batch-token-b"];
  const submitted: Record<string, any>[] = [];
  let reads = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/api/extract/jobs") {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      submitted.push(JSON.parse(raw || "{}"));
      response.statusCode = 202;
      response.end(JSON.stringify({
        ok: true,
        job: {
          id: "shared-remote-batch",
          status: "queued",
          items: tokens.map((token, index) => ({ index: index + 1, tokenHash: tokenHash(token), status: "queued" })),
        },
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/extract/jobs/shared-remote-batch") {
      reads += 1;
      response.end(JSON.stringify({
        ok: true,
        job: {
          id: "shared-remote-batch",
          status: "completed",
          startedAt: "2026-09-15T01:00:00.000Z",
          finishedAt: "2026-09-15T01:00:03.000Z",
          items: [
            {
              index: 2, tokenHash: tokenHash(tokens[1]), status: "succeeded", finishedAt: "2026-09-15T01:00:03.000Z",
              result: { paymentExposure: [{
                target: "momo", status: "complete", exposed: true,
                availableMethods: ["momo_wallet"], matchedMethods: ["momo_wallet"],
                paymentMethods: [{ type: "momo_wallet", source: "oaics" }], detail: "account-b",
                promoEligible: true, promoCampaign: "plus-1-month-free", trialStatus: "ineligible", checkoutType: "oaics",
              }] },
            },
            {
              index: 1, tokenHash: tokenHash(tokens[0]), status: "succeeded", finishedAt: "2026-09-15T01:00:02.000Z",
              result: { paymentExposure: [{
                target: "momo", status: "complete", exposed: true,
                availableMethods: ["card"], matchedMethods: ["card"],
                paymentMethods: [{ type: "card", source: "checkout" }], detail: "account-a",
                promoEligible: false, promoCampaign: "plus-1-month-free", trialStatus: "ineligible", checkoutType: "oaics",
              }] },
            },
          ],
        },
      }));
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
    DATABASE_PATH: path.join(directory, "test.sqlite"),
    V2_SESSION_SECRET: "payment-batch-test-session",
    CREDENTIAL_ENCRYPTION_KEY: "payment-batch-test-encryption",
    V2_READ_ONLY: "true",
    PAYMENT_METHOD_EXTRACT_API_BASE: `http://127.0.0.1:${address.port}`,
    PAYMENT_METHOD_EXTRACT_API_KEY: "",
  });
  const [{ db }, repository, paymentExposure] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/repository.js"),
    import("../src/server/payment-exposure.js"),
  ]);
  t.after(() => db.close());

  repository.importAccounts([
    { email: "batch-a@icloud.com", accessToken: tokens[0], openaiSubject: "batch-subject-a", plan: "free" },
    { email: "batch-b@icloud.com", accessToken: tokens[1], openaiSubject: "batch-subject-b", plan: "free" },
  ]);
  const accounts = repository.listAccounts({ limit: 10 }).results;
  const byEmail = new Map(accounts.map((account) => [account.primaryEmail, account]));
  const accountA = byEmail.get("batch-a@icloud.com")!;
  const accountB = byEmail.get("batch-b@icloud.com")!;

  const started = await paymentExposure.startPaymentExposureBatch([accountA.id, accountB.id], ["vn_momo"], "one_month");
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].input, tokens.join("\n"));
  assert.equal(submitted[0].concurrency, 2);
  assert.equal(submitted[0].options.usePromo, true);
  assert.equal(submitted[0].options.promoCampaignId, "plus-1-month-free");
  assert.equal(submitted[0].options.promotionStrategy, "native");
  assert.equal(started.requestedJobs, 1);
  assert.equal(started.started, 2);
  assert.equal(new Set(started.jobAccounts.map((item) => item.jobId)).size, 2);

  const rows = db.prepare("SELECT job_id,remote_job_id,promo_mode FROM payment_exposure_jobs ORDER BY account_id").all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.remote_job_id)).size, 1);
  assert.equal(rows[0].remote_job_id, "shared-remote-batch");
  assert.deepEqual([...new Set(rows.map((row) => row.promo_mode))], ["one_month"]);

  const background = await paymentExposure.refreshPendingPaymentExposureJobs();
  assert.deepEqual(background, { checked: 2, completed: 2, failed: 0, active: 0 });
  const completed = await paymentExposure.getPaymentExposureBatchStatus(started.jobAccounts);
  assert.equal(reads, 1);
  assert.deepEqual(completed.map((job) => job.status), ["completed", "completed"]);
  const savedA = repository.listPaymentExposureChecks(accountA.id)[0];
  const savedB = repository.listPaymentExposureChecks(accountB.id)[0];
  assert.equal(savedA.detail, "account-a");
  assert.deepEqual(savedA.availableMethods, ["card"]);
  assert.equal(savedB.detail, "account-b");
  assert.deepEqual(savedB.availableMethods, ["momo_wallet"]);
  assert.equal(savedA.paymentMethods[0]?.promoMode, "none");
  assert.equal(savedA.promoMode, "none");
  assert.equal(savedA.promoEligible, false);
  assert.equal(savedA.checkoutType, "local_extractor");
  assert.equal(savedB.paymentMethods[0]?.promoMode, "one_month");

  repository.savePaymentEligibilityObservation(accountA.id, {
    target: "momo", ipCountry: "VN", billingCountry: "VN", billingCurrency: "VND",
    eligible: true, reason: "second-source", source: "local_extractor",
    availableMethods: ["apple_pay"], matchedMethods: ["apple_pay"],
    paymentMethods: [{ id: "", type: "card", provider: "", name: "", code: "", displayName: "", source: "oaics" }],
    promoMode: "one_month",
  });
  const mergedA = repository.listPaymentExposureChecks(accountA.id)[0];
  assert.deepEqual(mergedA.availableMethods, ["card", "apple_pay"]);
  assert.deepEqual(mergedA.matchedMethods, ["card", "apple_pay"]);
  assert.deepEqual(mergedA.paymentMethods.find((method) => method.type === "card" && method.promoMode === "one_month")?.sources, ["oaics"]);
  assert.equal(mergedA.paymentMethods.filter((method) => method.type === "card").length, 2);

  repository.savePaymentEligibilityObservation(accountA.id, {
    target: "momo", ipCountry: "VN", billingCountry: "VN", billingCurrency: "VND",
    eligible: true, reason: "without-promo", source: "local_extractor", promoMode: "none",
    availableMethods: ["card"], matchedMethods: ["card"],
    paymentMethods: [{ id: "", type: "card", provider: "", name: "", code: "", displayName: "", source: "checkout" }],
  });
  const comparedA = repository.listPaymentExposureChecks(accountA.id)[0];
  assert.deepEqual(comparedA.paymentMethods.filter((method) => method.type === "card").map((method) => method.promoMode).sort(), ["none", "one_month"]);
  assert.equal(comparedA.promoMode, "one_month", "1 month 证据优先级高于后续无优惠探查");

  const stale = repository.createPaymentExposureJob({
    jobId: "dispatch:stale-fixture", remoteJobId: "dispatch:stale-fixture", accountId: accountA.id,
    routeKey: "vn_momo", target: "momo", ipCountry: "VN", billingCountry: "VN", billingCurrency: "VND",
    status: "dispatching", lastError: "", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "", createdAt: "2026-09-01T00:00:00.000Z",
  });
  db.prepare("UPDATE payment_exposure_jobs SET updated_at=? WHERE job_id=?").run("2026-09-01T00:00:00.000Z", stale.jobId);
  const staleResult = await paymentExposure.refreshPendingPaymentExposureJobs();
  assert.deepEqual(staleResult, { checked: 1, completed: 0, failed: 1, active: 0 });
  assert.equal(repository.getPaymentExposureJob(accountA.id, stale.jobId)?.status, "failed");
});
