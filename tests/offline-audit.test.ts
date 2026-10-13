import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SqliteTestDatabase as Database } from "../src/server/storage/sqlite-test.js";

test("snapshot audit never opens the configured runtime database or changes the snapshot", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-audit-readonly-"));
  const filename = path.join(directory, "snapshot.sqlite");
  const forbidden = path.join(directory, "must-not-open.sqlite");
  Object.assign(process.env, { DATABASE_PATH: filename, ENV_FILE: "/dev/null" });
  const { db } = await import("../src/server/db.js");
  (await db.close());
  const digest = () => crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  try {
    const before = digest();
    const audited = spawnSync(process.execPath, ["--import", "tsx", "scripts/audit-production.ts", "--database", filename], {
      encoding: "utf8", env: { ...process.env, DATABASE_PATH: forbidden },
    });
    assert.equal(audited.status, 0, audited.stderr || audited.stdout);
    assert.equal(JSON.parse(audited.stdout).checks.indexOnlySchema, true);
    assert.equal(digest(), before);
    assert.equal(fs.existsSync(forbidden), false);
    const source = new Database(filename);
    (await source.exec("ALTER TABLE mail_messages ADD COLUMN raw_mime TEXT"));
    (await source.close());
    const rejected = spawnSync(process.execPath, ["--import", "tsx", "scripts/audit-production.ts", "--database", filename], {
      encoding: "utf8", env: { ...process.env, DATABASE_PATH: forbidden },
    });
    assert.equal(rejected.status, 2);
    assert.deepEqual(JSON.parse(rejected.stdout).forbiddenColumns, ["mail_messages.raw_mime"]);
    assert.equal(fs.existsSync(forbidden), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
