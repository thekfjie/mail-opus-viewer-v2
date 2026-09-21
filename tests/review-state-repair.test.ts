import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyRepair, buildRepair, type ReviewedStatePlan } from "../scripts/repair-reviewed-state.js";

const incidentAt = "2026-09-08T18:20:18.750Z";
const baselineAt = "2026-09-08T18:16:48.000Z";
const plan: ReviewedStatePlan = { accountIds: ["reviewed-account"],
  incident: { from: "2026-09-08T18:20:18.000Z", to: "2026-09-08T18:20:19.000Z" } };

function fixture(t: test.TestContext, originalQuarantine = false) {
  const baseline = new Database(":memory:");
  baseline.exec(`
    CREATE TABLE gpt_accounts(id TEXT PRIMARY KEY,lifecycle_status TEXT,identity_status TEXT,deactivation_locked INTEGER,
      deactivated_at TEXT,quarantined_at TEXT,quarantine_reason TEXT,sold INTEGER,note TEXT,deleted_at TEXT,updated_at TEXT);
    CREATE TABLE email_bindings(id TEXT PRIMARY KEY,account_id TEXT REFERENCES gpt_accounts(id),email_enc TEXT,
      valid_from TEXT,valid_to TEXT,is_current INTEGER,updated_at TEXT);
    CREATE TABLE sales(id TEXT PRIMARY KEY,account_id TEXT REFERENCES gpt_accounts(id),binding_id TEXT,
      status TEXT,started_at TEXT,ended_at TEXT,end_reason TEXT,updated_at TEXT);
    CREATE TABLE access_grants(id TEXT PRIMARY KEY,account_id TEXT REFERENCES gpt_accounts(id),binding_id TEXT REFERENCES email_bindings(id),
      sale_id TEXT REFERENCES sales(id),scope TEXT,active INTEGER,visible_from TEXT,visible_to TEXT,public_token_hash TEXT,
      login_identifier_hash TEXT,password_hash TEXT,password_plain_enc TEXT,first_used_at TEXT,last_used_at TEXT,
      revoked_at TEXT,revoke_reason TEXT,updated_at TEXT);
    CREATE TABLE lifecycle_events(id TEXT PRIMARY KEY,account_id TEXT REFERENCES gpt_accounts(id),event_type TEXT,
      occurred_at TEXT,source TEXT,payload_json TEXT,created_at TEXT);
  `);
  baseline.prepare("INSERT INTO gpt_accounts VALUES('reviewed-account',?,'confirmed',0,'',?,?,1,'original-note','',?)")
    .run(originalQuarantine ? "quarantined" : "active", originalQuarantine ? "2026-08-30T11:24:19.804Z" : "",
      originalQuarantine ? "已售GPT身份在未停用状态下出现后续改绑" : "", baselineAt);
  baseline.prepare("INSERT INTO email_bindings VALUES('binding','reviewed-account','fake-encrypted-address','2026-08-09T00:00:00Z','2026-08-14T00:00:00Z',0,?)").run(baselineAt);
  baseline.prepare("INSERT INTO sales VALUES('sale','reviewed-account','binding','closed','2026-08-09T00:00:00Z','2026-08-14T00:00:00Z','sold_identity_rebound',?)").run(baselineAt);
  baseline.prepare(`INSERT INTO access_grants VALUES('grant','reviewed-account','binding','sale','historical',1,
    '2026-08-09T00:00:00Z','2026-08-14T00:00:00Z','fake-public-hash','fake-login-hash','fake-password-hash',
    'fake-encrypted-password','2026-08-09T12:00:00Z','2026-08-09T13:00:00Z','','',?)`).run(baselineAt);
  const database = new Database(baseline.serialize());
  database.prepare(`UPDATE gpt_accounts SET lifecycle_status='quarantined',identity_status='conflict',
    quarantine_reason='相同邮箱出现了不同OpenAI身份',quarantined_at=CASE WHEN quarantined_at='' THEN ? ELSE quarantined_at END,updated_at=?`).run(incidentAt, incidentAt);
  database.prepare("UPDATE access_grants SET active=0,revoked_at=?,revoke_reason='identity_conflict',updated_at=?").run(incidentAt, incidentAt);
  t.after(() => { database.close(); baseline.close(); });
  return { database, baseline };
}

test("review repair restores only the false identity overlay and exact historical grant", (t) => {
  const { database, baseline } = fixture(t);
  const before = database.serialize();
  const reviewed = buildRepair(database, baseline, plan);
  assert.deepEqual(database.serialize(), before, "building a repair is read-only");
  assert.deepEqual(reviewed.counts, { reviewedAccounts: 1, restoredAccounts: 1, restoredGrants: 1, restoredSales: 0, skippedAccounts: 0, skippedGrants: 0 });
  applyRepair(database, baseline, plan, reviewed);
  const account = database.prepare("SELECT * FROM gpt_accounts").get() as any;
  const grant = database.prepare("SELECT * FROM access_grants").get() as any;
  assert.equal(account.identity_status, "confirmed");
  assert.equal(account.lifecycle_status, "active");
  assert.equal(account.sold, 1);
  assert.equal(grant.active, 1);
  assert.equal(grant.scope, "historical");
  assert.equal(grant.visible_to, "2026-08-14T00:00:00Z");
  assert.equal(grant.revoked_at, "");
  const event = database.prepare("SELECT payload_json FROM lifecycle_events").get() as any;
  assert.deepEqual(JSON.parse(event.payload_json), { rule: "same_credential_identity_aliases", preservedBusinessState: true,
    restoredHistoricalGrants: 1, restoredCurrentGrants: 0, restoredSales: 0 });
  assert.doesNotMatch(event.payload_json, /fake-|password|email|token/i);
  assert.equal(buildRepair(database, baseline, plan).counts.restoredAccounts, 0, "repeated repair cannot reactivate anything else");
});

test("review repair restores an exactly matched current grant and sale closed by the false identity overlay", (t) => {
  const { database, baseline } = fixture(t);
  for (const handle of [baseline, database]) {
    handle.prepare("UPDATE email_bindings SET is_current=1,valid_to='' WHERE id='binding'").run();
    handle.prepare("UPDATE access_grants SET scope='current',visible_to='' WHERE id='grant'").run();
  }
  baseline.prepare("UPDATE sales SET status='active',ended_at='',end_reason='',updated_at=? WHERE id='sale'").run(baselineAt);
  database.prepare("UPDATE sales SET status='closed',ended_at=?,end_reason='identity_conflict',updated_at=? WHERE id='sale'").run(incidentAt, incidentAt);
  const reviewed = buildRepair(database, baseline, plan);
  assert.deepEqual(reviewed.counts, { reviewedAccounts: 1, restoredAccounts: 1, restoredGrants: 1, restoredSales: 1, skippedAccounts: 0, skippedGrants: 0 });
  applyRepair(database, baseline, plan, reviewed);
  assert.deepEqual(database.prepare("SELECT active,revoked_at,revoke_reason,scope,visible_to FROM access_grants WHERE id='grant'").get(), {
    active: 1, revoked_at: "", revoke_reason: "", scope: "current", visible_to: "",
  });
  assert.deepEqual(database.prepare("SELECT status,ended_at,end_reason FROM sales WHERE id='sale'").get(), {
    status: "active", ended_at: "", end_reason: "",
  });
});

test("repair restores an original sold-rebind quarantine instead of making inventory available", (t) => {
  const { database, baseline } = fixture(t, true);
  applyRepair(database, baseline, plan);
  const account = database.prepare("SELECT * FROM gpt_accounts").get() as any;
  assert.equal(account.lifecycle_status, "quarantined");
  assert.equal(account.quarantine_reason, "已售GPT身份在未停用状态下出现后续改绑");
  assert.equal(account.quarantined_at, "2026-08-30T11:24:19.804Z");
  assert.equal(account.sold, 1);
  assert.equal((database.prepare("SELECT status FROM sales").get() as any).status, "closed");
});

test("a post-baseline ban keeps its earliest timestamp, locked state and restricted grant", (t) => {
  const { database, baseline } = fixture(t);
  database.prepare(`UPDATE gpt_accounts SET lifecycle_status='deactivated',deactivation_locked=1,
    deactivated_at='2026-09-07T08:00:00Z',updated_at='2026-09-09T00:00:00Z'`).run();
  database.prepare("UPDATE access_grants SET visible_to='2026-08-10T00:00:00Z',updated_at='2026-09-09T00:00:00Z'").run();
  const reviewed = buildRepair(database, baseline, plan);
  assert.equal(reviewed.counts.restoredAccounts, 1);
  assert.equal(reviewed.counts.restoredGrants, 0);
  applyRepair(database, baseline, plan, reviewed);
  const account = database.prepare("SELECT * FROM gpt_accounts").get() as any;
  assert.equal(account.identity_status, "confirmed");
  assert.equal(account.lifecycle_status, "deactivated");
  assert.equal(account.deactivation_locked, 1);
  assert.equal(account.deactivated_at, "2026-09-07T08:00:00Z");
  assert.equal((database.prepare("SELECT active FROM access_grants").get() as any).active, 0);
});

test("a later confirmed ban preserves the customer grant while retaining its lock", (t) => {
  const { database, baseline } = fixture(t);
  database.prepare(`UPDATE gpt_accounts SET lifecycle_status='deactivated',deactivation_locked=1,
    deactivated_at='2026-09-09T08:00:00.000Z',updated_at='2026-09-09T08:00:00.000Z'`).run();
  database.prepare(`INSERT INTO lifecycle_events(id,account_id,event_type,occurred_at,source,payload_json,created_at)
    VALUES('ban-event','reviewed-account','account_deactivated','2026-09-09T08:00:00.000Z','shared-mail-api-sync',?,?)`)
    .run(JSON.stringify({ customerAccessPreserved: true }), '2026-09-09T08:00:00.000Z');
  const reviewed = buildRepair(database, baseline, plan);
  assert.equal(reviewed.counts.restoredGrants, 1);
  applyRepair(database, baseline, plan, reviewed);
  assert.deepEqual(database.prepare("SELECT lifecycle_status,deactivation_locked,identity_status FROM gpt_accounts").get(),
    { lifecycle_status: "deactivated", deactivation_locked: 1, identity_status: "confirmed" });
  assert.equal((database.prepare("SELECT active FROM access_grants").get() as any).active, 1);
});

test("newer terminal states and business edits survive identity-only repair", async (t) => {
  for (const status of ["retired", "deleted"]) await t.test(status, (child) => {
    const { database, baseline } = fixture(child);
    database.prepare("UPDATE gpt_accounts SET lifecycle_status=?,deleted_at=?,note='new-business-note',updated_at='2026-09-09T00:00:00Z'")
      .run(status, status === "deleted" ? "2026-09-09T00:00:00Z" : "");
    applyRepair(database, baseline, plan);
    const account = database.prepare("SELECT * FROM gpt_accounts").get() as any;
    assert.equal(account.lifecycle_status, status);
    assert.equal(account.note, "new-business-note");
    assert.equal((database.prepare("SELECT active FROM access_grants").get() as any).active, 0);
  });
});

test("changed passwords, boundaries, sales, bindings or newer revocations prevent grant restoration", async (t) => {
  const changes = [
    "UPDATE access_grants SET password_hash='new-password-hash'",
    "UPDATE access_grants SET visible_to='2026-08-11T00:00:00Z'",
    "UPDATE access_grants SET scope='current'",
    "UPDATE access_grants SET visible_to=''",
    "UPDATE access_grants SET updated_at='2026-09-09T00:00:00Z'",
    "UPDATE access_grants SET revoked_at='2026-09-09T00:00:00Z',updated_at='2026-09-09T00:00:00Z'",
    "UPDATE access_grants SET revoke_reason='admin_revoked'",
    "UPDATE sales SET end_reason='customer_refunded'",
    "UPDATE email_bindings SET valid_to='2026-08-10T00:00:00Z'",
  ];
  for (const [index, sql] of changes.entries()) await t.test(String(index), (child) => {
    const { database, baseline } = fixture(child);
    database.exec(sql);
    assert.equal(buildRepair(database, baseline, plan).counts.restoredGrants, 0);
    applyRepair(database, baseline, plan);
    assert.equal((database.prepare("SELECT active FROM access_grants").get() as any).active, 0);
  });
});

test("compare-and-swap rejects concurrent changes before any account or grant write", async (t) => {
  for (const target of ["account", "grant", "baseline"]) await t.test(target, (child) => {
    const { database, baseline } = fixture(child);
    const reviewed = buildRepair(database, baseline, plan);
    if (target === "account") database.exec("UPDATE gpt_accounts SET note='concurrent-business-edit'");
    if (target === "grant") database.exec("UPDATE access_grants SET password_hash='concurrent-password'");
    if (target === "baseline") baseline.exec("UPDATE access_grants SET visible_to='2026-08-12T00:00:00Z'");
    assert.throws(() => applyRepair(database, baseline, plan, reviewed), /repair_compare_and_swap_failed/);
    assert.equal((database.prepare("SELECT identity_status FROM gpt_accounts").get() as any).identity_status, "conflict");
    assert.equal((database.prepare("SELECT active FROM access_grants").get() as any).active, 0);
    assert.equal((database.prepare("SELECT COUNT(*) n FROM lifecycle_events").get() as any).n, 0);
  });
});

test("repair requires a bounded reviewed incident and refuses a regressed ban lock", (t) => {
  const { database, baseline } = fixture(t);
  assert.throws(() => buildRepair(database, baseline, { ...plan, accountIds: ["reviewed-account", "reviewed-account"] }), /repair_invalid_review_plan/);
  assert.throws(() => buildRepair(database, baseline, { ...plan, incident: { ...plan.incident, to: "2026-09-09T00:00:00Z" } }), /repair_invalid_review_plan/);
  baseline.exec("UPDATE gpt_accounts SET deactivation_locked=1,deactivated_at='2026-08-13T00:00:00Z'");
  assert.throws(() => applyRepair(database, baseline, plan), /repair_deactivation_lock_regressed/);
  assert.equal((database.prepare("SELECT active FROM access_grants").get() as any).active, 0);
});
