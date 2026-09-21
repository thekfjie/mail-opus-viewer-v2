import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

test("compatibility import waits for a concurrent WAL writer instead of failing with BUSY_SNAPSHOT", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-write-contention-"));
  const databasePath = path.join(directory, "test.sqlite");
  Object.assign(process.env, {
    PROJECT_ROOT: directory,
    DATABASE_PATH: databasePath,
    ENV_FILE: "/dev/null",
    V2_SESSION_SECRET: "fake-contention-session",
    CREDENTIAL_ENCRYPTION_KEY: "fake-contention-encryption",
    VIEWER_ADMIN_PASSWORD: "fake-admin-password",
    IMPORT_API_KEY: "fake-import-key",
    PUBLIC_ORIGIN: "https://mail.example.test",
    V2_READ_ONLY: "false",
    SQLITE_BUSY_TIMEOUT_MS: "5000",
  });

  const [{ db }, compatibility] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/compatibility-state.js"),
  ]);
  db.exec("CREATE TABLE contention_fixture(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");

  const ready = new Int32Array(new SharedArrayBuffer(4));
  const require = createRequire(import.meta.url);
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const Database = require(workerData.betterSqlitePath);
    const signal = new Int32Array(workerData.signal);
    const other = new Database(workerData.databasePath);
    other.pragma("journal_mode = WAL");
    other.pragma("busy_timeout = 5000");
    other.exec("BEGIN IMMEDIATE");
    other.prepare("INSERT INTO contention_fixture(value) VALUES(?)").run("worker-held-write");
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    Atomics.wait(signal, 0, 1, 300);
    other.exec("COMMIT");
    other.close();
    parentPort.postMessage("committed");
  `, {
    eval: true,
    workerData: {
      betterSqlitePath: require.resolve("better-sqlite3"),
      databasePath,
      signal: ready.buffer,
    },
  });
  t.after(async () => {
    await worker.terminate();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(Atomics.wait(ready, 0, 0, 5000), "ok");
  const startedAt = Date.now();
  const imported = compatibility.upsertCompatibilityAccount({
    email: "contention@icloud.com",
    accessToken: "fake-contention-token",
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(imported.ok, true);
  assert.equal(imported.created, true);
  assert.ok(elapsedMs >= 200, `expected import to wait for writer, elapsed=${elapsedMs}ms`);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM contention_fixture").get() as any).count, 1);
  assert.equal(await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  }), "committed");
});
