import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("同一秒内仍按毫秒保持新账号在上，状态变化不参与排序", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-order-"));
  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "order-test-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "order-test-encryption";
  process.env.V2_READ_ONLY = "false";

  const [{ db }, repository] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/repository.js"),
  ]);
  t.after(() => db.close());

  repository.importAccounts([
    { email: "older@example.com", arrivedAt: "2026-08-29T06:14:41.058Z", plan: "free" },
    { email: "newer@example.com", arrivedAt: "2026-08-29T06:14:41.681Z", plan: "plus" },
  ]);

  const exact = repository.listAccounts({ search: " NEWER@example.com ", limit: 10 });
  assert.equal(exact.total, 1);
  assert.equal(exact.results[0]?.primaryEmail, "newer@example.com");

  const newer = repository.listAccounts({ search: "newer", limit: 10 }).results[0];
  assert.ok(newer);
  repository.deactivateAccount(newer.id, "排序回归测试");

  const rows = repository.listAccounts({ limit: 10 }).results;
  assert.deepEqual(rows.map((item) => item.primaryEmail), ["newer@example.com", "older@example.com"]);
  assert.equal(rows[0].lifecycleStatus, "deactivated");

  const todayDeactivations = repository.listAccounts({ workbench: "deactivations", deactivationWindow: "today", limit: 10 });
  assert.equal(todayDeactivations.total, 1);
  assert.equal(todayDeactivations.results[0]?.primaryEmail, "newer@example.com");
});

test("北京时间封禁窗口使用自然日边界", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-deactivation-window-"));
  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "window-test-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "window-test-encryption";
  process.env.V2_READ_ONLY = "false";

  const repository = await import(`../src/server/repository.js?window=${Date.now()}`);
  assert.deepEqual(repository.beijingDeactivationWindow("today", Date.parse("2026-09-02T15:59:59Z")), {
    start: "2026-09-01T16:00:00.000Z",
    end: "2026-09-02T16:00:00.000Z",
  });
  assert.deepEqual(repository.beijingDeactivationWindow("3d", Date.parse("2026-09-02T16:00:00Z")), {
    start: "2026-08-31T16:00:00.000Z",
    end: "2026-09-03T16:00:00.000Z",
  });
});
