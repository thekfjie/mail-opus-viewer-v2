import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("批次级收件覆盖基础地址、三个别名、隔离、幂等和手动回收截止", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-batch-regression-"));
  const databasePath = path.join(directory, "scenario.sqlite");
  try {
    const run = spawnSync(path.resolve("node_modules/.bin/tsx"), ["scripts/validate-mailbox-batch-copy.ts"], {
      cwd: path.resolve("."), encoding: "utf8",
      env: { ...process.env, BATCH_VALIDATION_DATABASE_PATH: databasePath, ENV_FILE: "/dev/null" },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.ok, true);
    assert.deepEqual(result.normalization, { sameBatchAddresses: 5, normalizedBatchCount: 1, differentBatchCount: 1 });
    assert.deepEqual(result.cases.base, { inserted: true, claims: 3, visibleToBatchChildren: 3 });
    assert.deepEqual(result.cases.aliases, { delivered: 3, claimsPerMessage: 3, visibleToBatchChildren: 3 });
    assert.deepEqual(result.cases.unclear, { inserted: true, claims: 0, customerVisible: false });
    assert.deepEqual(result.cases.separateBatch, { inserted: true, ownBatchVisible: true, firstBatchVisible: false });
    assert.deepEqual(result.cases.duplicate, { secondInsert: false, storedRows: 1, claims: 0 });
    assert.deepEqual(result.cases.manualRecycle, { oldGrantRevoked: true, survivingChildrenSeeNewMail: 2,
      replacementSeesPreRecycleMail: false, replacementSeesPostRecycleMail: true, separateBatchVisible: false });
    assert.equal(result.integrity, "ok");
    assert.equal(result.foreignKeyViolations, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
