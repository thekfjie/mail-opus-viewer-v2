import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("MoMo 通过统一的本机无优惠 method 观察并只保存 MoMo 结果", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-momo-local-"));
  const submitted: Record<string, unknown>[] = [];
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
        job: { id: "ext-momo-local-fixture", status: "queued", items: [{ index: 1, status: "queued" }] },
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/extract/jobs/ext-momo-local-fixture") {
      reads += 1;
      response.end(JSON.stringify({
        ok: true,
        job: {
          id: "ext-momo-local-fixture",
          status: "completed",
          startedAt: "2026-09-14T01:00:00.000Z",
          finishedAt: "2026-09-14T01:00:02.000Z",
          items: [{
            index: 1,
            status: "succeeded",
            extractionStatus: "check_complete",
            decision: "check_complete",
            finishedAt: "2026-09-14T01:00:02.000Z",
            result: { decision: "check_complete", paymentExposure: [{
              target: "momo", status: "complete", exposed: true, availableMethods: ["card", "momo_wallet"], matchedMethods: ["momo_wallet"], paymentMethods: [{ type: "momo_wallet", displayName: "MoMo Wallet", source: "checkout" }], detail: "已暴露 momo；methods=card,momo_wallet",
              observedAt: "2026-09-14T01:00:02.000Z",
            }] },
          }],
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
    V2_SESSION_SECRET: "momo-local-test-session",
    CREDENTIAL_ENCRYPTION_KEY: "momo-local-test-encryption",
    V2_READ_ONLY: "true",
    PAYMENT_ELIGIBILITY_API_URL: "",
    PAYMENT_METHOD_EXTRACT_API_BASE: `http://127.0.0.1:${address.port}`,
    PAYMENT_METHOD_EXTRACT_API_KEY: "",
  });

  const [{ db }, repository, paymentExposure] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/repository.js"),
    import("../src/server/payment-exposure.js"),
  ]);
  t.after(async () => (await db.close()));

  (await repository.importAccounts([{
    email: "momo-local@icloud.com",
    accessToken: "fake-momo-access-token-for-test",
    openaiSubject: "momo-local-subject",
    plan: "free",
  }]));
  const account = (await repository.listAccounts({ limit: 5 })).results[0];
  const route = paymentExposure.listPaymentExposureRoutes().find((item) => item.key === "vn_momo");
  assert.ok(route?.configured);

  const started = await paymentExposure.startPaymentExposureCheck(account.id, "vn_momo");
  assert.equal(started.status, "queued");
  assert.equal(started.items[0].stage, "payment_method_exposure");
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].method, "payment_exposure");
  assert.equal(submitted[0].input, "fake-momo-access-token-for-test");
  const options = submitted[0].options as Record<string, unknown>;
  assert.equal(options.usePromo, false);
  assert.equal(options.paymentStatusAutoRefresh, false);
  assert.equal(options.paymentExposureCheck, true);
  assert.deepEqual(options.paymentExposureTargets, [{
    target: "momo", ipCountry: "VN", billingCountry: "VN", billingCurrency: "VND", expectedMethod: "momo",
  }]);
  assert.equal(Object.prototype.hasOwnProperty.call(options, "proxy"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(options, "promoCampaign"), false);

  const completed = await paymentExposure.getPaymentExposureCheckStatus(account.id, started.jobId);
  assert.equal(reads, 1);
  assert.equal(completed.status, "completed");
  assert.equal(completed.items[0].decision, "eligible");
  assert.equal(completed.items[0].paymentExposure[0].target, "momo");
  assert.equal(completed.items[0].paymentExposure[0].checkoutType, "local_extractor");
  assert.equal(JSON.stringify(completed).includes("fake-momo-access-token-for-test"), false);

  const saved = (await repository.listPaymentExposureChecks(account.id)).filter((item) => item.checkoutType === "local_extractor");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].target, "momo");
  assert.deepEqual(saved[0].availableMethods, ["card", "momo_wallet"]);
  assert.deepEqual(saved[0].matchedMethods, ["momo_wallet"]);
  assert.equal(saved[0].paymentMethods[0].displayName, "MoMo Wallet");
});
