import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { applyMailIngestionSchema, D1MailReader, MAIL_READ_LIMITS } from "../src/server/cf-mail.js";
import { verifyD1Index } from "../scripts/verify-d1-index.js";

const options = { accountId: "fake-account", databaseId: "fake-database", readToken: "fake-read-token", timeIndex: "idx_raw_mails_created_at" };
const definition = "CREATE INDEX idx_raw_mails_created_at ON raw_mails(created_at)";
const detail = "SEARCH raw_mails USING INDEX idx_raw_mails_created_at (created_at>? AND created_at<?)";
const response = (rows: unknown[], rowsRead = 0) => new Response(JSON.stringify({ success: true, result: [{ success: true, results: rows, meta: { rows_read: rowsRead } }] }));
function database(): Database.Database {
  const db = new Database(":memory:");
  applyMailIngestionSchema(db);
  return db;
}

test("time-index verification uses two budgeted fixed read-only queries and the exact backfill plan", async () => {
  const db = database();
  const upstream = new Database(":memory:");
  upstream.exec(`CREATE TABLE raw_mails(id INTEGER PRIMARY KEY, source TEXT, address TEXT, raw TEXT, raw_blob BLOB, created_at TEXT); ${definition};`);
  upstream.prepare("INSERT INTO raw_mails(id,created_at,raw) VALUES(1,?,?)").run("2026-09-08 00:00:01", "DO-NOT-PERSIST-MAIL-BODY");
  const queries: { sql: string; params: unknown[] }[] = [];
  const reader = new D1MailReader(db, { ...options, transport: async (_url, init) => {
    const query = JSON.parse(String(init?.body));
    queries.push(query);
    if (queries.length === 1) {
      assert.equal(query.sql, "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='raw_mails' AND name=? LIMIT 1");
      assert.deepEqual(query.params, [options.timeIndex]);
      return response(upstream.prepare(query.sql).all(...query.params), 1);
    }
    if (queries.length === 2) {
      assert.match(query.sql, /^EXPLAIN QUERY PLAN SELECT/);
      assert.match(query.sql, /INDEXED BY "idx_raw_mails_created_at"/);
      assert.match(query.sql, /LIMIT 100$/);
      assert.doesNotMatch(query.sql, /COUNT|OFFSET|PRAGMA/);
      return response(upstream.prepare(query.sql).all(...query.params));
    }
    assert.equal(query.sql, queries[1].sql.replace("EXPLAIN QUERY PLAN ", ""));
    return response(upstream.prepare(query.sql).all(...query.params), 1);
  } });
  try {
    assert.deepEqual(await reader.verifyTimeIndex(), { verified: true });
    assert.deepEqual(db.prepare("SELECT COUNT(*) requests, SUM(rows_read) rowsRead FROM mail_read_requests").get(), { requests: 2, rowsRead: 1 });
    assert.equal((db.prepare("SELECT backfill_at FROM mail_read_control").get() as any).backfill_at, 0);
    assert.equal((await reader.backfill({ from: "2026-09-08T00:00:00Z", to: "2026-09-08T00:01:00Z" })).rows.length, 1);
    assert.equal(db.serialize().includes(Buffer.from("DO-NOT-PERSIST-MAIL-BODY")), false);
  } finally { upstream.close(); db.close(); }
});

test("time-index verification rejects absent, partial, expression and non-leading time indexes before EXPLAIN", async () => {
  const definitions: (string | null)[] = [null, "", "CREATE INDEX idx_raw_mails_created_at ON raw_mails(created_at) WHERE created_at IS NOT NULL",
    "CREATE INDEX idx_raw_mails_created_at ON raw_mails(substr(created_at,1,10))",
    "CREATE INDEX idx_raw_mails_created_at ON raw_mails(id, created_at)",
    "CREATE INDEX idx_raw_mails_created_at ON raw_mails(created_at COLLATE NOCASE)",
    "CREATE INDEX idx_raw_mails_created_at ON other_table(created_at)",
    "CREATE INDEX another_index ON raw_mails(created_at)", `${definition}; SELECT raw FROM raw_mails;`];
  for (const sql of definitions) {
    const db = database();
    let calls = 0;
    const reader = new D1MailReader(db, { ...options, transport: async () => { calls += 1; return response(sql === null ? [] : [{ sql }], 1); } });
    try {
      await assert.rejects(reader.verifyTimeIndex(), (error: any) => error.code === "mail_d1_time_index_unverified");
      assert.equal(calls, 1);
    } finally { db.close(); }
  }
});

test("time-index verification accepts quoted ordinary columns but rejects scan, sort and unrecognized plans", async () => {
  for (const plan of [[{ detail }], [{ detail: "SCAN raw_mails USING INDEX idx_raw_mails_created_at" }],
    [{ detail }, { detail: "USE TEMP B-TREE FOR RIGHT PART OF ORDER BY" }], [], [{ detail: "SEARCH raw_mails USING INTEGER PRIMARY KEY (rowid>?)" }],
    [{ detail: "SEARCH raw_mails USING INDEX wrong_index (created_at>?)" }], [{ detail: "SEARCH raw_mails USING INDEX idx_raw_mails_created_at (id>?)" }]]) {
    const db = database();
    let calls = 0;
    const reader = new D1MailReader(db, { ...options, transport: async () => {
      calls += 1;
      return response(calls === 1 ? [{ sql: 'CREATE INDEX IF NOT EXISTS "idx_raw_mails_created_at" ON [raw_mails] (`created_at` ASC, "id" ASC);' }] : plan);
    } });
    try {
      if (plan.length === 1 && plan[0].detail === detail) assert.deepEqual(await reader.verifyTimeIndex(), { verified: true });
      else await assert.rejects(reader.verifyTimeIndex(), (error: any) => error.code === "mail_d1_time_index_plan_unverified");
      assert.equal(calls, 2);
    } finally { db.close(); }
  }
});

test("time-index verification rejects identifier injection with zero requests and shares exhausted budgets", async () => {
  const db = database();
  let calls = 0;
  const transport: typeof fetch = async () => { calls += 1; return response([{ sql: definition }]); };
  try {
    for (const timeIndex of ["", 'idx"; SELECT raw FROM raw_mails;', "sqlite_master.raw_mails", "a".repeat(65)]) {
      await assert.rejects(new D1MailReader(db, { ...options, timeIndex, transport }).verifyTimeIndex(),
        (error: any) => error.code === "mail_d1_time_index_unverified");
    }
    db.prepare("INSERT INTO mail_read_requests(id,started_at,rows_read,outcome) VALUES('exhausted',?,?,'ok')")
      .run(Date.now(), MAIL_READ_LIMITS.maxRowsReadPerDay);
    await assert.rejects(new D1MailReader(db, { ...options, transport }).verifyTimeIndex(),
      (error: any) => error.code === "mail_read_budget_exhausted");
    assert.equal(calls, 0);
  } finally { db.close(); }
});

test("time-index verification accounts for retries and never records provider errors or credentials", async () => {
  const db = database();
  let calls = 0;
  const reader = new D1MailReader(db, { ...options, transport: async () => {
    calls += 1;
    if (calls === 1) return new Response("PRIVATE-PROVIDER-ERROR", { status: 500 });
    return response(calls === 2 ? [{ sql: definition }] : [{ detail }], calls === 2 ? 1 : 0);
  } });
  try {
    assert.deepEqual(await reader.verifyTimeIndex(), { verified: true });
    assert.equal(calls, 3);
    assert.deepEqual(db.prepare("SELECT COUNT(*) requests, SUM(rows_read) rowsRead FROM mail_read_requests").get(), { requests: 3, rowsRead: 1 });
    assert.equal(db.serialize().includes(Buffer.from(options.readToken)), false);
    assert.equal(db.serialize().includes(Buffer.from("PRIVATE-PROVIDER-ERROR")), false);
  } finally { db.close(); }
});

test("index verification script requires protected explicit matching configuration and changes only existing budget tables", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opus-v2-index-verify-"));
  const filename = path.join(directory, "candidate.sqlite");
  const envFile = path.join(directory, "candidate.env");
  const environment = `DATABASE_PATH=${filename}\nV2_CF_ACCOUNT_ID=${options.accountId}\nV2_CF_D1_DATABASE_ID=${options.databaseId}\nV2_CF_D1_READ_TOKEN=${options.readToken}\nV2_CF_D1_TIME_INDEX=${options.timeIndex}\n`;
  const db = new Database(filename);
  applyMailIngestionSchema(db);
  fs.writeFileSync(envFile, environment, { mode: 0o600 });
  let calls = 0;
  const transport: typeof fetch = async () => { calls += 1; return response(calls % 2 ? [{ sql: definition }] : [{ detail }], calls % 2); };
  try {
    const args = ["--database", filename, "--env", envFile];
    assert.deepEqual(await verifyD1Index(args, transport), { verified: true, requests: 2, rowsRead: 1 });
    assert.equal(fs.readFileSync(envFile, "utf8"), environment);
    assert.equal(db.serialize().includes(Buffer.from(options.readToken)), false);
    fs.chmodSync(envFile, 0o644);
    assert.deepEqual(await verifyD1Index(args, transport), { verified: false, requests: 0, rowsRead: 0, error: "index_verification_failed" });
    fs.chmodSync(envFile, 0o600);
    fs.writeFileSync(envFile, environment.replace(filename, filename + ".missing"));
    assert.equal((await verifyD1Index(args, transport)).verified, false);
    assert.equal((await verifyD1Index(["--env", envFile], transport)).verified, false);
    assert.equal(calls, 2);
    assert.equal(fs.existsSync(filename + ".missing"), false);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
