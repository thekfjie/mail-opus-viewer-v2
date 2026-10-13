import assert from "node:assert/strict";
import test from "node:test";
import { SqliteTestDatabase as Database } from "../src/server/storage/sqlite-test.js";
import { hasActiveTrialOnlyCorrection } from "../src/server/plus-plan-state.js";

test("零元试用纠错持续压制旧投影，直到更晚的付费邮件出现", async () => {
  const database = new Database(":memory:");
  (await database.exec(`CREATE TABLE lifecycle_events (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`));
  (await database.prepare("INSERT INTO lifecycle_events VALUES('correction','account','plus_trial_only_corrected',?,?)")
    .run("2026-08-01T10:00:00.000Z", "2026-09-13T10:00:00.000Z"));
  assert.equal((await hasActiveTrialOnlyCorrection(database, "account")), true);
  (await database.prepare("INSERT INTO lifecycle_events VALUES('paid','account','plus_activated_by_mail',?,?)")
    .run("2026-08-02T10:00:00.000Z", "2026-09-14T10:00:00.000Z"));
  assert.equal((await hasActiveTrialOnlyCorrection(database, "account")), false);
  (await database.close());
});
