import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InProcessTaskMutex, type TaskMutex } from "../src/server/infrastructure/task-mutex.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("task mutex rejects overlapping work, allows other keys and never replays a completed result", async () => {
  const mutex: TaskMutex = new InProcessTaskMutex();
  const held = barrier();
  let calls = 0;
  const first = mutex.runExclusive("worker:native-sync", async () => {
    calls += 1;
    await held.promise;
    return calls;
  });
  assert.deepEqual(await mutex.runExclusive("worker:native-sync", () => { calls += 1; }), { acquired: false });
  assert.equal(calls, 1);
  assert.deepEqual(await mutex.runExclusive("oauth:fake-job", () => "independent"), { acquired: true, value: "independent" });
  held.release();
  assert.deepEqual(await first, { acquired: true, value: 1 });
  assert.deepEqual(await mutex.runExclusive("worker:native-sync", () => ++calls), { acquired: true, value: 2 });
});

test("task mutex releases on synchronous throws and asynchronous rejection", async () => {
  const mutex = new InProcessTaskMutex();
  const failure = new Error("fake-task-failure");
  await assert.rejects(mutex.runExclusive("test", () => { throw failure; }), (error) => error === failure);
  await assert.rejects(mutex.runExclusive("test", async () => { throw failure; }), (error) => error === failure);
  assert.deepEqual(await mutex.runExclusive("test", () => "recovered"), { acquired: true, value: "recovered" });
});

test("worker accepts injected admission control and preserves skip and recovery behavior offline", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-worker-mutex-"));
  process.env.PROJECT_ROOT = directory;
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.ENV_FILE = "/dev/null";
  process.env.V2_SESSION_SECRET = "fake-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "fake-encryption";
  const [{ createWorker }, { db }] = await Promise.all([import("../src/server/worker.js"), import("../src/server/db.js")]);
  t.after(async () => { (await db.close()); fs.rmSync(directory, { recursive: true, force: true }); });
  const calls: string[] = [];
  const held = barrier();
  let currentTime = Date.now();
  const dependencies = {
    now: () => currentTime,
    outlook: async () => { calls.push("outlook"); return { mailboxes: 0, fetched: 0, inserted: 0, errors: 0 }; },
    sub2api: async () => { calls.push("sub2api"); return {} as any; },
    pendingMail: async () => { calls.push("pendingMail"); await held.promise; return { processed: 0, errors: 0 }; },
    schedule: () => { calls.push("schedule"); return { queued: 0 }; },
    promotions: async () => { calls.push("promotions"); return { checked: 0, eligible: 0, ineligible: 0, retryable: 0, invalid: 0 }; },
    paymentExposure: async () => { calls.push("paymentExposure"); return { checked: 0, completed: 0, failed: 0, active: 0 }; },
  };
  const rejectAll: TaskMutex = { runExclusive: async () => ({ acquired: false }) };
  const rejectedWorker = createWorker({ ...dependencies, taskMutex: rejectAll });
  assert.deepEqual(await rejectedWorker.runOnce(), { skipped: true, reason: "already_running" });
  assert.deepEqual(calls, []);
  assert.equal((await db.prepare("SELECT 1 FROM worker_heartbeats").get()), undefined);

  const taskMutex = new InProcessTaskMutex();
  const firstWorker = createWorker({ ...dependencies, taskMutex });
  const secondWorker = createWorker({ ...dependencies, taskMutex });
  const firstRun = firstWorker.runOnce();
  assert.deepEqual(await firstWorker.runOnce(), { skipped: true, reason: "already_running" });
  assert.deepEqual(await secondWorker.runOnce(), { skipped: true, reason: "already_running" });
  assert.deepEqual(calls, ["pendingMail"]);
  held.release();
  await firstRun;
  assert.deepEqual(calls, ["pendingMail", "sub2api", "schedule", "promotions", "paymentExposure"]);
  currentTime += 60_000;
  await secondWorker.runOnce();
  assert.equal(calls.filter((key) => key === "pendingMail").length, 2);

  const failingWorker = createWorker({ ...dependencies, taskMutex, pendingMail: async () => { throw new Error("fake-task-failure"); } });
  currentTime += 60_000;
  const failed = await failingWorker.runOnce();
  assert.deepEqual(failed.pendingMail, { error: "task_failed" });
  currentTime += 60_000;
  const recovered = await firstWorker.runOnce();
  assert.deepEqual(recovered.pendingMail, { processed: 0, errors: 0 });
});
