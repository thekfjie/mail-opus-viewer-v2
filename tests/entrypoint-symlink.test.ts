import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import test, { type TestContext } from "node:test";

const repository = fileURLToPath(new URL("../", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");

async function waitFor<T>(child: ChildProcessWithoutNullStreams, inspect: () => T | undefined, output: () => string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `entrypoint exited before readiness: ${output()}`);
    assert.equal(child.signalCode, null, `entrypoint was signalled before readiness: ${output()}`);
    const result = inspect();
    if (result !== undefined) return result;
    await delay(50);
  }
  assert.fail(`entrypoint did not become ready: ${output()}`);
}

function launch(t: TestContext, entrypoint: "server" | "worker") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `opus-symlink-${entrypoint}-`));
  const release = path.join(directory, "current");
  const database = path.join(directory, "test.sqlite");
  const networkAttempt = path.join(directory, "network-attempt");
  const preload = path.join(directory, "offline-preload.mjs");
  fs.symlinkSync(repository, release, "dir");
  fs.writeFileSync(preload, `import fs from "node:fs";
import path from "node:path";
if (fs.realpathSync(process.argv[1]) === path.resolve(process.argv[1])) throw new Error("symlink entrypoint required");
globalThis.fetch = async () => {
  fs.writeFileSync(${JSON.stringify(networkAttempt)}, "attempted");
  throw new Error("external network forbidden");
};
`);
  const child = spawn(process.execPath, ["--import", tsxLoader, "--import", pathToFileURL(preload).href,
    path.join(release, "src/server", `${entrypoint}.ts`)], {
    cwd: directory,
    stdio: "pipe",
    env: {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      HOME: directory,
      TMPDIR: directory,
      NODE_ENV: "production",
      ENV_FILE: "/dev/null",
      PROJECT_ROOT: directory,
      DATABASE_PATH: database,
      PORT: "0",
      V2_SESSION_SECRET: "fake-symlink-session",
      CREDENTIAL_ENCRYPTION_KEY: "fake-symlink-encryption",
      VIEWER_ADMIN_PASSWORD: "fake-symlink-admin",
      V2_READ_ONLY: "true",
      V2_AUTO_TRIAL_ENABLED: "false",
      V2_OUTLOOK_MAIL_SYNC_ENABLED: "false",
      V2_SYNC_INTERVAL_MS: "10000",
    },
  });
  let stdout = "", stderr = "", spawnError = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65_536); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65_536); });
  child.on("error", (error) => { spawnError = error.message; });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  t.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      let force: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<void>((resolve) => {
          force = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
        })]);
      } finally { if (force) clearTimeout(force); }
      await closed;
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  return { child, database, networkAttempt, stdout: () => stdout, output: () => [stdout, stderr, spawnError].join("\n") };
}

test("server entrypoint through release symlink listens and serves independent health", { timeout: 20_000 }, async (t) => {
  const running = launch(t, "server");
  const origin = await waitFor(running.child, () => running.stdout().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], running.output);
  const response = await fetch(`${origin}/health`, { redirect: "error", signal: AbortSignal.timeout(3_000) });
  assert.equal(response.status, 200);
  const health = await response.json() as any;
  assert.equal(health.independent, true);
  assert.equal(health.commandWriter, "v2");
  await delay(150);
  assert.equal(running.child.exitCode, null, running.output());
  assert.equal(fs.existsSync(running.networkAttempt), false);
});

test("worker entrypoint through release symlink writes a read-only heartbeat and stays running", { timeout: 20_000 }, async (t) => {
  const running = launch(t, "worker");
  const heartbeat = await waitFor(running.child, () => {
    if (!fs.existsSync(running.database)) return undefined;
    const database = new Database(running.database, { readonly: true, fileMustExist: true, timeout: 100 });
    try {
      database.pragma("query_only = ON");
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_heartbeats'").get()) return undefined;
      return database.prepare("SELECT process_id,status,detail_json FROM worker_heartbeats WHERE worker_name='native-sync-worker'").get() as any;
    } finally { database.close(); }
  }, running.output);
  assert.equal(heartbeat.process_id, running.child.pid);
  assert.equal(heartbeat.status, "ok");
  const detail = JSON.parse(heartbeat.detail_json);
  assert.deepEqual(detail.tasks, { skipped: true, reason: "read_only" });
  assert.deepEqual(detail.sharedMail, { skipped: true, reason: "event_or_admin_trigger_only" });
  await delay(150);
  assert.equal(running.child.exitCode, null, running.output());
  assert.equal(fs.existsSync(running.networkAttempt), false);
});
