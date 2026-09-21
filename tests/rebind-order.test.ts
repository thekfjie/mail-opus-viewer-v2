import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("取得新 AT 的域名换绑目标按完成时间排序，预创建占位不入账号库", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-rebind-order-"));
  const configFile = path.join(directory, "access-config.json");
  const backupsDirectory = path.join(directory, "backups");
  fs.mkdirSync(backupsDirectory, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify([
    {
      id: "source-1",
      email: "scree_yonder.0j@icloud.com",
      lifecycleStatus: "retired",
      rebindNextId: "target-1",
      rebindNextEmail: "scree_yonder.0j@ai-mail.tech",
      rebindChangedAt: "2026-08-29T14:00:00.000Z",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-29T14:00:01.000Z",
    },
    {
      id: "target-1",
      email: "scree_yonder.0j@ai-mail.tech",
      domainMailbox: true,
      rebindPreviousId: "source-1",
      rebindPreviousEmail: "scree_yonder.0j@icloud.com",
      rebindChangedAt: "2026-08-29T14:00:00.000Z",
      openaiOAuth: { accessToken: "fresh-target-at" },
      createdAt: "2026-08-24T21:08:10.006Z",
      updatedAt: "2026-08-29T14:00:02.000Z",
    },
    {
      id: "other-1",
      email: "other@ai-mail.tech",
      domainMailbox: true,
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:00:00.000Z",
    },
  ]));

  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.V1_CONFIG_FILE = configFile;
  process.env.V1_BACKUPS_DIR = backupsDirectory;
  process.env.V1_MAIL_INDEX_FILE = path.join(directory, "missing-mail-index.json");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "rebind-order-test-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "rebind-order-test-encryption";
  process.env.V2_READ_ONLY = "true";
  process.env.ROUTING_PRIMARY_EMAIL = "routing@example.invalid";
  process.env.ROUTING_LEGACY_EMAILS = "";
  process.env.ROUTING_EMAILS = "";

  const [{ db }, repository, { syncFromV1 }] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/repository.js"),
    import("../src/server/legacy-import.js"),
  ]);
  t.after(() => db.close());

  syncFromV1();
  const domainRows = repository.listAccounts({ provider: "domain", limit: 10 }).results;
  assert.deepEqual(domainRows.slice(0, 2).map((item) => item.primaryEmail), [
    "scree_yonder.0j@ai-mail.tech",
    "other@ai-mail.tech",
  ]);
  assert.equal(domainRows[0].arrivedAt, "2026-08-29T14:00:00.000Z");
  assert.equal(repository.revealCredentials(domainRows[0].id)?.accessToken, "fresh-target-at");
});
