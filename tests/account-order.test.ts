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

  const exact = repository.listAccounts({ search: " NEWER@EXAMPLE.COM ", limit: 10 });
  assert.equal(exact.total, 1);
  assert.equal(exact.results[0]?.primaryEmail, "newer@example.com");

  const newer = repository.listAccounts({ search: "newer", limit: 10 }).results[0];
  assert.ok(newer);
  repository.deactivateAccount(newer.id, "排序回归测试");

  const rows = repository.listAccounts({ limit: 10 }).results;
  assert.deepEqual(rows.map((item) => item.primaryEmail), ["newer@example.com", "older@example.com"]);
  assert.equal(rows[0].lifecycleStatus, "deactivated");
});
