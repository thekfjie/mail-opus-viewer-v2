import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("所有支付资格统一请求本机无优惠观察且只保存管理员选择的方式", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-eligibility-"));
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    requests.push({ url: String(request.url || ""), body: JSON.parse(raw || "{}") });
    response.setHeader("content-type", "application/json");
    response.statusCode = 202;
    response.end(JSON.stringify({ ok: true, job: {
      id: "ext-ideal-local-fixture", status: "completed",
      startedAt: "2026-09-14T02:00:00.000Z", finishedAt: "2026-09-14T02:00:01.000Z",
      items: [{ index: 1, status: "succeeded", finishedAt: "2026-09-14T02:00:01.000Z", result: {
        paymentExposure: [{ target: "ideal", status: "complete", exposed: true, detail: "已暴露 ideal；methods=card,ideal" }],
      } }],
    } }));
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
    PAYMENT_METHOD_EXTRACT_API_BASE: `http://127.0.0.1:${address.port}`,
    PAYMENT_METHOD_EXTRACT_API_KEY: "",
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
  const routes = paymentExposure.listPaymentExposureRoutes();
  assert.deepEqual(routes.map((route) => route.target), ["ideal", "gcash", "upi", "gopay", "kakao", "naver", "momo"]);
  assert.equal(routes.every((route) => route.configured && route.addressDisplay === "本机提炼服务"), true);
  await assert.rejects(() => paymentExposure.startPaymentExposureBatch([account.id]), /必须先选择一个具体 method/);
  await assert.rejects(() => paymentExposure.startPaymentExposureBatch([account.id], ["nl_ideal", "vn_momo"]), /必须先选择一个具体 method/);
  await assert.rejects(() => paymentExposure.startPaymentExposureBatch(Array.from({ length: 25 }, (_, index) => `account-${index}`), ["vn_momo"]), /最多选择 24 个账号/);
  const result = await paymentExposure.startPaymentExposureCheck(account.id, "nl_ideal");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/extract/jobs");
  assert.equal(requests[0].body.method, "payment_exposure");
  assert.equal(requests[0].body.input, "fake-access-token-for-test");
  const options = requests[0].body.options as Record<string, unknown>;
  assert.equal(options.usePromo, false);
  assert.equal(Object.prototype.hasOwnProperty.call(options, "proxy"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(options, "promoCampaign"), false);
  assert.deepEqual(options.paymentExposureTargets, [{
    target: "ideal", ipCountry: "NL", billingCountry: "NL", billingCurrency: "EUR", expectedMethod: "ideal",
  }]);
  assert.equal(result.status, "completed");
  assert.equal(result.items[0].paymentExposure.length, 1);
  assert.equal(result.items[0].paymentExposure[0].target, "ideal");
  assert.equal(result.items[0].paymentExposure[0].exposed, true);
  assert.equal(JSON.stringify(result).includes("fake-access-token-for-test"), false);

  const saved = repository.listPaymentExposureChecks(account.id).filter((item) => item.checkoutType === "local_extractor");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].target, "ideal");
  assert.deepEqual(saved[0].availableMethods, ["ideal"]);
  assert.equal(saved.some((item) => ["gcash", "gopay", "upi", "kakao", "naver", "momo"].includes(item.target)), false);
});
