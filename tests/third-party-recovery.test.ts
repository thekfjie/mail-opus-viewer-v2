import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("第三方待恢复账号独立入队，并在补入 AT 后转为第三方注册", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-third-party-recovery-"));
  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "third-party-recovery-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "third-party-recovery-encryption";
  process.env.PUBLIC_ORIGIN = "https://mail.example.test";
  process.env.V2_READ_ONLY = "false";
  process.env.V2_ACCOUNT_AUTHORITY = "v2";

  const [{ db }, repository] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/repository.js"),
  ]);
  t.after(() => db.close());

  const email = "third-party-pending+oai@icloud.com";
  assert.deepEqual(repository.importAccounts([{
    email,
    lifecycleStatus: "third_party_pending_recovery",
    plan: "free",
    note: "第三方注册，待 AT 恢复",
  }]), { imported: 1, created: 1, rebound: 0, errors: [] });

  const queued = repository.listAccounts({ status: "third_party_pending_recovery", limit: 10 });
  assert.equal(queued.total, 1);
  assert.equal(queued.results[0]?.primaryEmail, email);
  assert.equal(queued.results[0]?.lifecycleStatus, "third_party_pending_recovery");
  assert.throws(() => repository.provisionCurrentCustomerExport(String(queued.results[0]?.id)), /非可授权账号/);

  assert.deepEqual(repository.importAccounts([{
    email,
    lifecycleStatus: "third_party_pending_recovery",
  }]), { imported: 1, created: 0, rebound: 0, errors: [] });

  assert.deepEqual(repository.importAccounts([{
    email,
    accessToken: "restored-at",
  }]), { imported: 1, created: 0, rebound: 0, errors: [] });
  assert.equal(repository.listAccounts({ status: "third_party_pending_recovery", limit: 10 }).total, 0);
  assert.equal(repository.listAccounts({ status: "active", search: email, limit: 10 }).total, 0);
  const registered = repository.listAccounts({ status: "third_party_registered", search: email, limit: 10 }).results[0];
  assert.equal(registered?.lifecycleStatus, "third_party_registered");
  assert.equal(repository.provisionCurrentCustomerExport(String(registered?.id))?.available, true);
});
