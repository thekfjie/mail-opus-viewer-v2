import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_PATH = path.join(os.tmpdir(), `mail-opus-check-routes-${crypto.randomUUID()}.sqlite`);
process.env.PROJECT_ROOT = process.cwd();
process.env.PAYMENT_EXPOSURE_PROMOTION_PROXY_JP = "http://env-user:env-pass@jp-env.test:7903";
process.env.PAYMENT_ELIGIBILITY_API_URL = "https://eligibility-default.test/api/v1/check";

const [{ db }, routes] = await Promise.all([
  import("../src/server/db.js"),
  import("../src/server/check-routes.js"),
]);

test("检测出口长期加密保存、管理员完整显示并可回退环境配置", () => {
  const initial = routes.checkRouteSummary("promotion_jp");
  assert.equal(initial.source, "environment");
  assert.equal(initial.addressDisplay, "JP 路由 · http://env-user:env-pass@jp-env.test:7903");

  const saved = routes.saveCheckRouteProxy("promotion_jp", "socks5://saved-user:saved-pass@jp-saved.test:1080");
  assert.equal(saved.source, "saved");
  assert.equal(saved.addressDisplay, "JP 路由 · socks5://saved-user:saved-pass@jp-saved.test:1080");
  assert.equal(routes.effectiveCheckProxy("promotion_jp"), "socks5://saved-user:saved-pass@jp-saved.test:1080");
  const stored = db.prepare("SELECT value FROM settings WHERE key='check_route_proxy_v1:promotion_jp'").get() as any;
  assert.match(String(stored.value), /^v1\./);
  assert.equal(String(stored.value).includes("saved-pass"), false);

  const cleared = routes.clearCheckRouteProxy("promotion_jp");
  assert.equal(cleared.source, "environment");
  assert.equal(routes.effectiveCheckProxy("promotion_jp"), "http://env-user:env-pass@jp-env.test:7903");
});

test("支付资格接口地址和令牌加密长期保存", () => {
  assert.deepEqual(routes.paymentEligibilityApiSummary(), {
    configured: true,
    source: "environment",
    endpoint: "https://eligibility-default.test/api/v1/check",
    hasApiToken: false,
  });

  const saved = routes.savePaymentEligibilityApi("https://saved.test/api/v1/check?tenant=opus", "api-secret-value", true);
  assert.equal(saved.source, "saved");
  assert.equal(saved.endpoint, "https://saved.test/api/v1/check?tenant=opus");
  assert.equal(saved.hasApiToken, true);
  assert.deepEqual(routes.effectivePaymentEligibilityApi(), {
    endpoint: "https://saved.test/api/v1/check?tenant=opus",
    apiToken: "api-secret-value",
  });
  const stored = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'payment_eligibility_%' ORDER BY key").all() as any[];
  assert.equal(stored.length, 2);
  assert.equal(stored.every((row) => String(row.value).startsWith("v1.")), true);
  assert.equal(stored.some((row) => String(row.value).includes("api-secret-value")), false);

  const cleared = routes.clearPaymentEligibilityApi();
  assert.equal(cleared.source, "environment");
  assert.equal(cleared.endpoint, "https://eligibility-default.test/api/v1/check");
  assert.equal(cleared.hasApiToken, false);
});
