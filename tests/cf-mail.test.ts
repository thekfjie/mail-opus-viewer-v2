import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { SqliteTestDatabase as Database } from "../src/server/storage/sqlite-test.js";
import { applyMailIngestionSchema, D1MailReader, MAIL_READ_LIMITS, MailReadError } from "../src/server/cf-mail.js";

const options = { accountId: "fake-account", databaseId: "fake-database", readToken: "fake-read-token", timeIndex: "idx_raw_mails_created_at" };
function d1(rows: unknown[], rowsRead = rows.length): Response {
  return new Response(JSON.stringify({ success: true, result: [{ success: true, results: rows, meta: { rows_read: rowsRead } }] }));
}
async function database(): Promise<Database> {
  const db = new Database(":memory:");
  (await applyMailIngestionSchema(db));
  return db;
}

test("D1 exact ID reads coalesce only pending work and never persist content", async () => {
  const db = (await database());
  const marker = "BODY-UNIQUE-RAW-HTML-MARKER";
  let count = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const reader = new D1MailReader(db, { ...options, transport: async (_url, init) => {
    count += 1;
    const query = JSON.parse(String(init?.body));
    assert.match(query.sql, /WHERE id=\? LIMIT 1/);
    assert.doesNotMatch(query.sql, /COUNT|OFFSET/);
    assert.deepEqual(query.params, ["12"]);
    await barrier;
    return d1([{ id: 12, raw: marker, address: "test@example.com" }]);
  } });
  const first = reader.byId("12");
  const second = reader.byId("12");
  assert.equal(first, second);
  release();
  assert.equal((await first)?.raw, marker);
  await second;
  assert.equal(count, 1);
  await reader.byId("12");
  assert.equal(count, 2);
  assert.equal(db.serialize().includes(Buffer.from(marker)), false);
  (await db.close());
});

test("D1 persistent budgets survive restart and apply globally to separate readers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-mail-budget-"));
  const filename = path.join(directory, "budget.sqlite");
  let now = Date.parse("2026-09-07T00:00:00Z");
  let calls = 0;
  const transport: typeof fetch = async () => { calls += 1; return d1([]); };
  let db = new Database(filename);
  (await applyMailIngestionSchema(db));
  let reader = new D1MailReader(db, { ...options, now: () => now, transport });
  for (let i = 0; i < 60; i += 1) await reader.byId(String(i + 1));
  await assert.rejects(reader.byId("61"), (error: any) => error.code === "mail_read_budget_exhausted");
  (await db.close());
  db = new Database(filename);
  reader = new D1MailReader(db, { ...options, now: () => now, transport });
  await assert.rejects(reader.byId("61"), (error: any) => error.code === "mail_read_budget_exhausted");
  assert.equal(calls, 60);
  now += 60_001;
  await reader.byId("61");
  (await db.transaction(async () => {
    for (let i = 61; i < 1_000; i += 1) {
      (await db.prepare("INSERT INTO mail_read_requests(id,started_at) VALUES(?,?)").run(`seed-${i}`, now - 60_001));
    }
  })());
  await assert.rejects(reader.byId("62"), (error: any) => error.code === "mail_read_budget_exhausted");
  assert.equal(calls, 61);
  now += 86_400_001;
  await reader.byId("62");
  (await db.close());
  fs.rmSync(directory, { recursive: true });
});

test("cross-reader concurrency is one and stale process leases expire", async () => {
  const db = (await database());
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let count = 0;
  const transport: typeof fetch = async () => { count += 1; await barrier; return d1([]); };
  const first = new D1MailReader(db, { ...options, transport });
  const second = new D1MailReader(db, { ...options, transport });
  const waiting = first.byId("1");
  await assert.rejects(second.byId("2"), (error: any) => error.code === "mail_read_busy");
  assert.equal(count, 1);
  release();
  await waiting;
  await second.byId("2");
  assert.equal(count, 2);
  (await db.close());
});

test("one reader queues different IDs instead of racing its own durable lease", async () => {
  const db = (await database());
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const reader = new D1MailReader(db, { ...options, transport: async (_url, init) => {
    const query = JSON.parse(String(init?.body));
    calls.push(String(query.params[0]));
    if (calls.length === 1) await barrier;
    return d1([{ id: Number(query.params[0]), raw: "body" }]);
  } });
  const first = reader.byId("1");
  const second = reader.byId("2");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["1"]);
  release();
  assert.equal((await first)?.id, 1);
  assert.equal((await second)?.id, 2);
  assert.deepEqual(calls, ["1", "2"]);
  (await db.close());
});

test("configured readers briefly wait for a lease held by another process", async () => {
  const db = (await database());
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const first = new D1MailReader(db, { ...options, transport: async () => { await barrier; return d1([]); } });
  const second = new D1MailReader(db, { ...options, leaseWaitMs: 500, transport: async () => d1([]) });
  const active = first.byId("1");
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = second.byId("2");
  setTimeout(release, 40);
  await active;
  await waiting;
  assert.equal(((await db.prepare("SELECT COUNT(*) count FROM mail_read_requests").get()) as any).count, 2);
  (await db.close());
});

test("transient errors retry once, count failures, sanitize errors and cool down", async () => {
  const db = (await database());
  let calls = 0;
  const reader = new D1MailReader(db, { ...options, transport: async () => {
    calls += 1;
    throw new TypeError("body-and-token-must-not-persist");
  } });
  await assert.rejects(reader.byId("4"), (error: any) => error.code === "mail_d1_transport_failure");
  assert.equal(calls, 2);
  await assert.rejects(reader.byId("4"), (error: any) => error.code === "mail_read_cooling_down");
  assert.equal(calls, 2);
  assert.equal(db.serialize().includes(Buffer.from("body-and-token-must-not-persist")), false);
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM mail_read_requests").get()) as any).n, 2);
  (await db.close());
});

test("missing credentials, auth/quota and high query cost fail closed", async () => {
  for (const status of [401, 403, 429]) {
    const db = (await database());
    let calls = 0;
    const reader = new D1MailReader(db, { ...options, transport: async () => { calls += 1; return new Response("unsafe payload", { status }); } });
    await assert.rejects(reader.byId("1"), MailReadError);
    await assert.rejects(reader.byId("2"), MailReadError);
    assert.equal(calls, 1);
    (await db.close());
  }
  const db = (await database());
  let calls = 0;
  const missing = new D1MailReader(db, { ...options, readToken: "", transport: async () => { calls += 1; return d1([]); } });
  await assert.rejects(missing.byId("1"), (error: any) => error.code === "mail_d1_not_configured");
  assert.equal(calls, 0);
  const costly = new D1MailReader(db, { ...options, transport: async () => { calls += 1; return d1([], 10_001); } });
  await assert.rejects(costly.byId("1"), (error: any) => error.code === "mail_d1_query_cost_exceeded");
  await assert.rejects(costly.byId("2"), MailReadError);
  assert.equal(calls, 1);
  (await db.close());
});

test("backfill requires verified index, fixed bounded window and one page with manual continuation", async () => {
  const db = (await database());
  let now = Date.parse("2026-09-07T00:00:00Z");
  let calls = 0;
  const transport: typeof fetch = async (_url, init) => {
    calls += 1;
    const query = JSON.parse(String(init?.body));
    assert.match(query.sql, /INDEXED BY "idx_raw_mails_created_at"/);
    assert.match(query.sql, /LIMIT 100/);
    assert.doesNotMatch(query.sql, /COUNT|OFFSET/);
    return d1(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, created_at: "2026-09-07 00:00:01", raw: "private" })));
  };
  const reader = new D1MailReader(db, { ...options, transport, now: () => now });
  const window = { from: "2026-09-07T00:00:00Z", to: "2026-09-08T00:00:00Z" };
  await assert.rejects(reader.backfill({ ...window, to: "2026-09-09T00:00:00Z" }), MailReadError);
  assert.equal(calls, 0);
  const page = await reader.backfill(window);
  assert.equal(calls, 1);
  assert.equal(page.complete, false);
  assert.deepEqual(page.cursor, { id: "100", createdAt: "2026-09-07T00:00:01.000Z" });
  await assert.rejects(reader.backfill(window), (error: any) => error.code === "mail_backfill_cooling_down");
  now += MAIL_READ_LIMITS.backfillCooldownMs;
  const unverified = new D1MailReader(db, { ...options, timeIndex: "", transport, now: () => now });
  await assert.rejects(unverified.backfill(window), (error: any) => error.code === "mail_d1_time_index_unverified");
  assert.equal(calls, 1);
  (await db.close());
});

test("fixed continuation SQL uses indexed range and preserves same-second IDs", async () => {
  const db = (await database());
  (await db.exec(`CREATE TABLE raw_mails(id INTEGER PRIMARY KEY, created_at TEXT, raw TEXT);
    CREATE INDEX idx_raw_mails_created_at ON raw_mails(created_at);`));
  (await db.prepare("INSERT INTO raw_mails VALUES(?,?,?)").run(1, "2026-09-07 00:00:01", "a"));
  (await db.prepare("INSERT INTO raw_mails VALUES(?,?,?)").run(2, "2026-09-07 00:00:01", "b"));
  const sql = `SELECT id FROM raw_mails INDEXED BY idx_raw_mails_created_at
    WHERE created_at>=? AND created_at<? AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT 100`;
  const params = ["2026-09-07 00:00:00", "2026-09-08 00:00:00", "2026-09-07 00:00:01", 1];
  assert.deepEqual((await db.prepare(sql).all(...params)), [{ id: 2 }]);
  const plan = JSON.stringify((await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)));
  assert.match(plan, /SEARCH.*USING.*INDEX/);
  assert.doesNotMatch(plan, /SCAN|TEMP B-TREE/);
  (await db.close());
});

test("separate OS processes share the same atomic concurrency lease", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-mail-process-budget-"));
  const filename = path.join(directory, "budget.sqlite");
  const db = new Database(filename);
  db.pragma("journal_mode=WAL");
  (await applyMailIngestionSchema(db));
  const helper = new URL("./helpers/mail-budget-child.ts", import.meta.url);
  const first = fork(helper, [filename, "1"], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(async () => { first.kill(); (await db.close()); fs.rmSync(directory, { recursive: true }); });
  const firstExit = once(first, "exit");
  assert.deepEqual((await once(first, "message"))[0], { status: "request" });
  const second = fork(helper, [filename, "2"], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => second.kill());
  const secondExit = once(second, "exit");
  assert.deepEqual((await once(second, "message"))[0], { status: "error", code: "mail_read_busy" });
  await secondExit;
  const completion = once(first, "message");
  first.send({ action: "finish" });
  assert.deepEqual((await completion)[0], { status: "done" });
  await firstExit;
  assert.equal(((await db.prepare("SELECT COUNT(*) count FROM mail_read_requests").get()) as any).count, 1);
});

test("timeouts abort each request and oversized responses never parse or persist bodies", async () => {
  const db = (await database());
  let calls = 0;
  const reader = new D1MailReader(db, { ...options, timeoutMs: 5, transport: async (_url, init) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const failure = setTimeout(() => reject(new Error("abort was not received")), 200);
      init?.signal?.addEventListener("abort", () => { clearTimeout(failure); reject(init.signal?.reason); }, { once: true });
    });
  } });
  await assert.rejects(reader.byId("1"), (error: any) => error.code === "mail_d1_transport_failure");
  assert.equal(calls, 2);
  const large = new D1MailReader(db, { ...options, transport: async () => new Response("oversized-private-body", { headers: { "content-length": "20000000" } }) });
  await assert.rejects(large.byId("2"), (error: any) => error.code === "mail_d1_response_too_large");
  assert.equal(db.serialize().includes(Buffer.from("oversized-private-body")), false);
  (await db.close());
});
