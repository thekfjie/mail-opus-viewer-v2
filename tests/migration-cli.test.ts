import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import test from "node:test";

test("migration CLI requires an explicit valid snapshot and writes only the new target", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-migration-cli-"));
  const snapshot = path.join(directory, "source");
  fs.mkdirSync(snapshot);
  const source = path.join(snapshot, "access-config.json");
  const target = path.join(directory, "staging.sqlite");
  const invoke = (database: string) => spawnSync(process.execPath, ["--import", "tsx", "src/server/migrate-v1.ts", "--snapshot", snapshot], {
    encoding: "utf8", env: { ...process.env, DATABASE_PATH: database, ENV_FILE: "/dev/null" },
  });
  try {
    fs.writeFileSync(source, "invalid-json");
    assert.notEqual(invoke(target).status, 0);
    assert.equal(fs.existsSync(target), false);
    const records = JSON.stringify([{ id: "offline-cli-mapping", email: "offline-cli@icloud.com", createdAt: "2026-08-01T00:00:00Z" }]);
    fs.writeFileSync(source, records);
    assert.notEqual(invoke(path.join(snapshot, "forbidden.sqlite")).status, 0);
    assert.equal(fs.existsSync(path.join(snapshot, "forbidden.sqlite")), false);
    const imported = invoke(target);
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);
    assert.equal(fs.readFileSync(source, "utf8"), records);
    const db = new Database(target, { readonly: true });
    assert.equal((db.prepare("SELECT COUNT(*) n FROM gpt_accounts").get() as any).n, 1);
    db.close();
    const before = fs.readFileSync(target);
    assert.notEqual(invoke(target).status, 0);
    assert.deepEqual(fs.readFileSync(target), before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
