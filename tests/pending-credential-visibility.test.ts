import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("V2 does not project task placeholders as accounts and keeps actionable missing AT", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-pending-credentials-"));
  const configFile = path.join(directory, "access-config.json");
  const backupsDirectory = path.join(directory, "backups");
  fs.mkdirSync(backupsDirectory, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify([
    {
      id: "signup-pending",
      email: "signup+oai@icloud.com",
      note: "automyai OpenAI signup pool pending",
      autoFlag: true,
      createdAt: "2026-08-29T03:00:00.000Z",
    },
    {
      id: "rebind-pending",
      email: "rebind@ai-mail.tech",
      note: "automyai OpenAI email rebind target pending",
      rebindTargetPending: true,
      domainMailbox: true,
      createdAt: "2026-08-29T02:00:00.000Z",
    },
    {
      id: "completed-missing-at",
      email: "completed+oai@icloud.com",
      note: "automyai OpenAI X completed",
      autoFlag: true,
      createdAt: "2026-08-29T01:00:00.000Z",
    },
  ]));

  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.V1_CONFIG_FILE = configFile;
  process.env.V1_BACKUPS_DIR = backupsDirectory;
  process.env.V1_MAIL_INDEX_FILE = path.join(directory, "missing-mail-index.json");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "pending-credential-test-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "pending-credential-test-encryption";
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
  const normal = repository.listAccounts({ pending: "exclude", limit: 20 }).results;
  assert.deepEqual(normal.map((item) => item.primaryEmail), ["completed+oai@icloud.com"]);
  assert.equal(normal[0].credentialState, "completed_missing_at");
  assert.equal(normal[0].internalPending, false);

  const pending = repository.listAccounts({ pending: "true", limit: 20 }).results;
  assert.deepEqual(pending, []);
});
