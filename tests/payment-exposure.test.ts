import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("支付方式检查按 OpenAI subject hash 批量匹配并安全 upsert", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-exposure-"));
  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "exposure-test-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "exposure-test-encryption";
  process.env.V2_READ_ONLY = "true";

  const [{ db }, repository] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/repository.js"),
  ]);
  t.after(() => db.close());

  const subjectHash = crypto.createHash("sha256").update("openai-exposure-subject").digest("base64url");
  const imported = repository.importAccounts([{
    email: "exposure+oai@icloud.com",
    accessToken: "exposure-at",
    openaiSubject: "openai-exposure-subject",
    plan: "free",
  }]);
  assert.deepEqual(imported, { imported: 1, created: 1, rebound: 0, errors: [] });

  const checks = [
    { target: "ideal", ipCountry: "NL", billingCountry: "NL", billingCurrency: "EUR", expectedMethod: "ideal", availableMethods: ["card", "ideal"], matchedMethods: ["ideal"], paymentMethods: [{ type: "card", displayName: "Card", source: "stripe" }, { id: "cpmt_1togstc6h1nxgoi3wuvey2cj", type: "custom", provider: "stripe", name: "Custom card", code: "cpmt_1togstc6h1nxgoi3wuvey2cj", displayName: "Custom card", source: "stripe" }], trialStatus: "observed", exposed: true, status: "complete" },
    { target: "paypal", ipCountry: "DE", billingCountry: "DE", billingCurrency: "EUR", expectedMethod: "paypal", availableMethods: ["card"], matchedMethods: [], exposed: false, status: "complete" },
    { target: "gcash", ipCountry: "PH", billingCountry: "PH", billingCurrency: "PHP", expectedMethod: "gcash", availableMethods: ["card", "gcash"], matchedMethods: ["gcash"], exposed: true, status: "complete" },
  ];
  assert.deepEqual(repository.ingestPaymentExposureChecks(checks.map((check) => ({ ...check, openaiSubjectHash: subjectHash, promoEligible: null }))), {
    accepted: 3,
    updated: 0,
    errors: [],
  });

  const account = repository.listAccounts({ limit: 10 }).results[0];
  assert.equal(account.paymentExposureStatus, "exposed");
  assert.equal(account.paymentExposureCount, 3);
  assert.equal(account.paymentExposureExposedCount, 2);
  assert.equal(account.paymentExposureUnknownCount, 0);

  const changed = repository.ingestPaymentExposureChecks([{
    ...checks[0], openaiSubjectHash: subjectHash, exposed: false, matchedMethods: [], promoEligible: false,
  }]);
  assert.deepEqual(changed, { accepted: 1, updated: 1, errors: [] });

  const detail = repository.getAccountDetail(account.id);
  assert.ok(detail);
  assert.equal(detail.paymentExposureChecks.length, 3);
  assert.equal(detail.paymentExposureChecks.find((check) => check.target === "ideal")?.exposed, false);
  assert.equal(detail.paymentExposureChecks.find((check) => check.target === "ideal")?.paymentMethods[1]?.id, "cpmt_1togstc6h1nxgoi3wuvey2cj");
  assert.equal(detail.paymentExposureChecks.find((check) => check.target === "ideal")?.trialStatus, "observed");
});
