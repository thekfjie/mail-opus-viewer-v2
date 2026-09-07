import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("支付资格只请求一次接口且只保存管理员选择的字段", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-eligibility-"));
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    requests.push({ url: String(request.url || ""), body: JSON.parse(raw || "{}") });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      token_ok: true,
      eligible: true,
      promo_id: "plus-1-month-free",
      ideal_eligible: true,
      ideal_eligible_reason: "eligible",
      gcash_eligible: true,
      gopay_eligible: true,
      upi_eligible: true,
      kakao_eligible: true,
      naver_eligible: true,
      gcash_pm_eligible: null,
      gcash_pm_eligible_reason: "not-requested",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  Object.assign(process.env, {
    PROJECT_ROOT: directory,
    DATABASE_PATH: path.join(directory, "test.sqlite"),
    V2_SESSION_SECRET: "eligibility-test-session",
    CREDENTIAL_ENCRYPTION_KEY: "eligibility-test-encryption",
    V2_READ_ONLY: "true",
    PAYMENT_ELIGIBILITY_API_URL: `http://127.0.0.1:${address.port}/api/v1/check`,
    PAYMENT_ELIGIBILITY_API_TOKEN: "",
  });

  const [{ db }, repository, paymentExposure] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/repository.js"),
    import("../src/server/payment-exposure.js"),
  ]);
  t.after(() => db.close());

  repository.importAccounts([{
    email: "eligibility@icloud.com",
    accessToken: "fake-access-token-for-test",
    openaiSubject: "eligibility-subject",
    plan: "free",
  }]);
  const account = repository.listAccounts({ limit: 5 }).results[0];
  const result = await paymentExposure.startPaymentExposureCheck(account.id, "nl_ideal");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/v1/check");
  assert.equal(requests[0].body.token, "fake-access-token-for-test");
  assert.equal(requests[0].body.check_gcash_pm, false);
  assert.equal(JSON.stringify(requests[0].body).includes("checkout"), false);
  assert.equal(result.status, "completed");
  assert.equal(result.items[0].paymentExposure.length, 1);
  assert.equal(result.items[0].paymentExposure[0].target, "ideal");
  assert.equal(result.items[0].paymentExposure[0].exposed, true);
  assert.equal(JSON.stringify(result).includes("fake-access-token-for-test"), false);

  const saved = repository.listPaymentExposureChecks(account.id).filter((item) => item.checkoutType === "eligibility_api");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].target, "ideal");
  assert.deepEqual(saved[0].availableMethods, ["ideal"]);
  assert.equal(saved.some((item) => ["gcash", "gopay", "upi", "kakao", "naver"].includes(item.target)), false);
});
