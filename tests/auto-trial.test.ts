import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("旧 payment_exposure 自动任务入口已停用，优惠定时任务由 promotion 队列负责", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-auto-trial-disabled-"));
  Object.assign(process.env, {
    PROJECT_ROOT: directory,
    DATABASE_PATH: path.join(directory, "test.sqlite"),
    V2_SESSION_SECRET: "auto-trial-disabled-session",
    CREDENTIAL_ENCRYPTION_KEY: "auto-trial-disabled-encryption",
  });
  const paymentExposure = await import("../src/server/payment-exposure.js");
  const { db } = await import("../src/server/db.js");
  t.after(() => db.close());
  assert.deepEqual(await paymentExposure.runAutomaticTrialChecks(), {
    enabled: false, candidates: 0, started: 0, failed: 0, skipped: 0, errors: [],
  });
  assert.deepEqual(await paymentExposure.refreshAutomaticTrialJobs(), { checked: 0, completed: 0, failed: 0 });
});
