import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyBanAccessRepair, buildBanAccessRepair, createLegacyLinkProofs } from "../scripts/repair-ban-access.js";

function fixture(t: test.TestContext, mode: "unissued" | "historical" = "unissued") {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE gpt_accounts(id TEXT PRIMARY KEY,lifecycle_status TEXT,identity_status TEXT,deactivation_locked INTEGER,
      deactivated_at TEXT,quarantine_reason TEXT,source_status TEXT,deleted_at TEXT,sold INTEGER,updated_at TEXT);
    CREATE TABLE email_bindings(id TEXT PRIMARY KEY,account_id TEXT REFERENCES gpt_accounts(id),legacy_mapping_id TEXT,
      valid_from TEXT,valid_to TEXT,receive_disabled_at TEXT,is_current INTEGER,updated_at TEXT);
    CREATE TABLE access_grants(id TEXT PRIMARY KEY,account_id TEXT REFERENCES gpt_accounts(id),binding_id TEXT REFERENCES email_bindings(id),
      scope TEXT,active INTEGER,visible_from TEXT,visible_to TEXT,revoked_at TEXT,revoke_reason TEXT,first_used_at TEXT,last_used_at TEXT,
      sale_id TEXT,public_token_hash TEXT,public_token_enc TEXT,login_identifier_hash TEXT,login_identifier_enc TEXT,
      password_hash TEXT,password_plain_enc TEXT,legacy_public_token INTEGER,updated_at TEXT);
    CREATE TABLE sales(id TEXT PRIMARY KEY,account_id TEXT,binding_id TEXT,status TEXT,ended_at TEXT,end_reason TEXT,updated_at TEXT);
    CREATE TABLE lifecycle_events(id TEXT PRIMARY KEY,account_id TEXT,event_type TEXT,occurred_at TEXT,source TEXT,payload_json TEXT,created_at TEXT);
    CREATE TABLE account_relations(id TEXT PRIMARY KEY,from_account_id TEXT,to_account_id TEXT,relation_type TEXT,status TEXT);
    INSERT INTO gpt_accounts VALUES('account','deactivated','confirmed',1,'2026-09-08T21:58:44.000Z','','current','',0,'2026-09-09T00:00:00Z');
    INSERT INTO email_bindings VALUES('binding','account','legacy-id','2026-08-31T08:47:40.000Z','','',1,'2026-08-31T09:00:00Z');
    INSERT INTO access_grants VALUES('grant','account','binding','admin_only',0,'2026-08-31T08:47:40.000Z','','','','','',NULL,
      'fake-hash','fake-encrypted-public','fake-email-hash','fake-encrypted-email','fake-password-hash','fake-encrypted-password',1,'2026-08-31T09:00:00Z');
    INSERT INTO lifecycle_events VALUES('ban-event','account','account_deactivated','2026-09-08T21:58:44.000Z','shared-mail-api-sync','{}','2026-09-09T00:00:00Z');`);
  if (mode === "historical") db.exec(`UPDATE gpt_accounts SET sold=1;
    UPDATE access_grants SET scope='historical',active=1,first_used_at='2026-09-01T00:00:00Z',sale_id='sale',visible_to='2026-09-08T21:58:44.001Z';
    INSERT INTO sales VALUES('sale','account','binding','closed','2026-09-08T21:58:44.000Z','account_deactivated','2026-09-09T00:00:00Z');`);
  const originals = [{ id: "legacy-id", mailNotBefore: "2026-08-13T14:51:21.678Z", lifecycleStatus: "active", note: "", passwordPlain: "fake" }];
  const proofs = () => createLegacyLinkProofs(db, originals, () => true);
  t.after(() => db.close());
  return { db, originals, proofs };
}

test("original V1 customer link works after ban without changing ownership, passwords or banned state", (t) => {
  const { db, proofs } = fixture(t);
  const before = db.serialize();
  const plan = buildBanAccessRepair(db, proofs());
  assert.deepEqual(db.serialize(), before);
  assert.equal(plan.counts.restoredLegacyLinks, 1);
  let journaled = false;
  applyBanAccessRepair(db, plan, () => { journaled = true; assert.equal((db.prepare("SELECT active FROM access_grants").get() as any).active, 0); });
  const g = db.prepare("SELECT * FROM access_grants").get() as any;
  assert.equal(journaled, true); assert.equal(g.active, 1); assert.equal(g.scope, "current");
  assert.equal(g.visible_from, "2026-08-31T08:47:40.000Z"); assert.equal(g.visible_to, "");
  assert.equal(g.binding_id, "binding"); assert.equal(g.password_hash, "fake-password-hash");
  assert.equal(g.public_token_enc, "fake-encrypted-public");
  assert.equal((db.prepare("SELECT deactivation_locked FROM gpt_accounts").get() as any).deactivation_locked, 1);
  assert.equal((db.prepare("SELECT deactivated_at FROM gpt_accounts").get() as any).deactivated_at, "2026-09-08T21:58:44.000Z");
  const audit = db.prepare("SELECT payload_json FROM lifecycle_events WHERE event_type='customer_ban_access_repaired'").get() as any;
  assert.doesNotMatch(audit.payload_json, /fake-|password|token|email/i);
  assert.equal(buildBanAccessRepair(db, proofs()).changes.length, 0);
});

test("automatic ban cutoff and sale closure are reversed for a still-owned binding", (t) => {
  const { db, proofs } = fixture(t, "historical");
  const plan = buildBanAccessRepair(db, proofs());
  assert.equal(plan.counts.restoredBanWindows, 1); assert.equal(plan.counts.reopenedSales, 1);
  applyBanAccessRepair(db, plan);
  assert.equal((db.prepare("SELECT visible_to FROM access_grants").get() as any).visible_to, "");
  const s = db.prepare("SELECT * FROM sales").get() as any;
  assert.equal(s.status, "active"); assert.equal(s.ended_at, ""); assert.equal(s.end_reason, "");
});

test("the independently proven binding end remains closed and cannot expose a later owner", (t) => {
  const { db, proofs } = fixture(t, "historical");
  db.exec("UPDATE email_bindings SET valid_to='2026-09-10T00:00:00Z',is_current=0");
  applyBanAccessRepair(db, buildBanAccessRepair(db, proofs()));
  const g = db.prepare("SELECT * FROM access_grants").get() as any;
  assert.equal(g.scope, "historical"); assert.equal(g.visible_to, "2026-09-10T00:00:00.000Z");
  assert.equal((db.prepare("SELECT status FROM sales").get() as any).status, "closed");
  assert.equal((db.prepare("SELECT end_reason FROM sales").get() as any).end_reason, "binding_ended");
});

test("all explicit manual reclaim evidence remains authoritative", async (t) => {
  for (const kind of ["retired", "retiredAt", "recycledToId", "relation", "manual-event", "receive-disabled", "deleted", "identity-conflict", "quarantine"]) {
    await t.test(kind, (child) => {
      const { db, originals, proofs } = fixture(child, "historical");
      if (kind === "retired") originals[0].lifecycleStatus = "retired";
      if (kind === "retiredAt") Object.assign(originals[0], { retiredAt: "2026-09-08T22:00:00Z" });
      if (kind === "recycledToId") Object.assign(originals[0], { recycledToId: "next-owner" });
      if (kind === "relation") db.exec("INSERT INTO account_relations VALUES('recycle','account','next-owner','mailbox_recycle','confirmed')");
      if (kind === "manual-event") db.exec("INSERT INTO lifecycle_events VALUES('manual','account','customer_access_revoked','2026-09-09T00:01:00Z','v2-admin','{}','2026-09-09T00:01:00Z')");
      if (kind === "receive-disabled") db.exec("UPDATE email_bindings SET receive_disabled_at='2026-09-09T00:01:00Z'");
      if (kind === "deleted") db.exec("UPDATE gpt_accounts SET deleted_at='2026-09-09T00:01:00Z'");
      if (kind === "identity-conflict") db.exec("UPDATE gpt_accounts SET identity_status='conflict'");
      if (kind === "quarantine") db.exec("UPDATE gpt_accounts SET quarantine_reason='manual-ownership-review'");
      const plan = buildBanAccessRepair(db, proofs());
      assert.equal(plan.changes.length, 0); assert.equal(plan.counts.skipped, 1);
    });
  }
});

test("unknown inactive grants, changed credentials and unissued placeholders are skipped", async (t) => {
  for (const kind of ["inactive", "password", "revoke", "placeholder", "no-proof", "source"]) await t.test(kind, (child) => {
    const { db, originals, proofs } = fixture(child);
    const verified = proofs();
    if (kind === "inactive") db.exec("UPDATE access_grants SET scope='current'");
    if (kind === "password") db.exec("UPDATE access_grants SET password_hash='rotated-password'");
    if (kind === "revoke") db.exec("UPDATE access_grants SET revoke_reason='admin_reclaimed'");
    if (kind === "placeholder") { originals[0].note = "automyai OpenAI signup pool pending"; verified[0].placeholder = true; }
    if (kind === "source") db.exec("UPDATE gpt_accounts SET source_status='recovered'");
    const plan = buildBanAccessRepair(db, kind === "no-proof" ? [] : verified);
    assert.equal(plan.changes.length, 0); assert.equal(plan.counts.skipped, 1);
  });
});

test("unknown grant limits and missing ban timestamps are never widened", (t) => {
  const { db, proofs } = fixture(t, "historical");
  db.exec("UPDATE gpt_accounts SET deactivated_at='';DELETE FROM lifecycle_events;UPDATE access_grants SET visible_to='2026-09-07T00:00:00Z'");
  const plan = buildBanAccessRepair(db, proofs());
  applyBanAccessRepair(db, plan);
  const g = db.prepare("SELECT visible_to FROM access_grants").get() as any;
  assert.equal(Date.parse(g.visible_to), Date.parse("2026-09-07T00:00:00Z"));
  assert.equal((db.prepare("SELECT status FROM sales").get() as any).status, "closed");
});

test("CAS rejects a new revoke, changed binding, customer password or outgoing recycle relation", async (t) => {
  for (const kind of ["password", "binding", "manual-event", "relation"]) await t.test(kind, (child) => {
    const { db, proofs } = fixture(child);
    const plan = buildBanAccessRepair(db, proofs());
    if (kind === "password") db.exec("UPDATE access_grants SET password_hash='new-password'");
    if (kind === "binding") db.exec("UPDATE email_bindings SET valid_to='2026-09-01T00:00:00Z'");
    if (kind === "manual-event") db.exec("INSERT INTO lifecycle_events VALUES('manual','account','customer_access_revoked','2026-09-09T00:01:00Z','v2-admin','{}','2026-09-09T00:01:00Z')");
    if (kind === "relation") db.exec("INSERT INTO account_relations VALUES('recycle','account','new-owner','mailbox_recycle','confirmed')");
    assert.throws(() => applyBanAccessRepair(db, plan), /ban_repair_(compare_and_swap_failed|events_changed|relations_changed)/);
    assert.equal((db.prepare("SELECT active FROM access_grants").get() as any).active, 0);
  });
});

test("audit failure aborts before writes and automatic source timestamps support prior ban records", (t) => {
  const { db, proofs } = fixture(t, "historical");
  db.exec("UPDATE gpt_accounts SET deactivated_at='2026-09-08T21:58:47.000Z'");
  const plan = buildBanAccessRepair(db, proofs());
  assert.equal(plan.counts.reopenedSales, 1);
  assert.throws(() => applyBanAccessRepair(db, plan, () => { throw new Error("fake-audit-disk-full"); }), /fake-audit-disk-full/);
  assert.equal((db.prepare("SELECT status FROM sales").get() as any).status, "closed");
});

test("explicit later restoration permits the requested legacy link while keeping the restored binding start", (t) => {
  const { db, originals, proofs } = fixture(t);
  Object.assign(originals[0], { recycledToId: "orphan-old-recycle", mailRestoredAt: "2026-08-31T08:47:40Z",
    restoredFromLifecycleStatus: "retired", restoredFromRetiredAt: "2026-08-14T07:11:02Z", restoredFromMailNotAfter: "2026-08-14T07:11:02Z" });
  const proof = proofs();
  assert.equal(proof[0].manualReclaimed, false);
  assert.equal(proof[0].restoredAt, "2026-08-31T08:47:40.000Z");
  const plan = buildBanAccessRepair(db, proof);
  assert.equal(plan.counts.restoredLegacyLinks, 1);
  applyBanAccessRepair(db, plan);
  assert.equal((db.prepare("SELECT visible_from FROM access_grants").get() as any).visible_from, "2026-08-31T08:47:40.000Z");
});

test("stale recycle pointers alone or an extant next owner never prove restoration", async (t) => {
  for (const kind of ["no-restore", "next-owner", "before-reclaim", "old-binding", "new-relation"]) await t.test(kind, (child) => {
    const { db, originals, proofs } = fixture(child);
    Object.assign(originals[0], { recycledToId: "next-owner", mailRestoredAt: "2026-08-31T08:47:40Z",
      restoredFromLifecycleStatus: "retired", restoredFromRetiredAt: "2026-08-14T07:11:02Z" });
    if (kind === "no-restore") Object.assign(originals[0], { mailRestoredAt: "" });
    if (kind === "next-owner") originals.push({ ...originals[0], id: "next-owner" });
    if (kind === "before-reclaim") Object.assign(originals[0], { mailRestoredAt: "2026-08-01T00:00:00Z" });
    if (kind === "old-binding") db.exec("UPDATE email_bindings SET valid_from='2026-08-13T00:00:00Z'");
    if (kind === "new-relation") db.exec("INSERT INTO account_relations VALUES('recycle','account','next-owner','mailbox_recycle','confirmed')");
    assert.equal(buildBanAccessRepair(db, proofs()).changes.length, 0);
  });
});

test("unbanned legacy links are included only in explicit complete-access repair", (t) => {
  const {db,originals}=fixture(t);
  db.exec("UPDATE gpt_accounts SET lifecycle_status='active',deactivation_locked=0,deactivated_at=''");
  const proofs=createLegacyLinkProofs(db,originals,()=>true,true);
  assert.equal(createLegacyLinkProofs(db,originals,()=>true).length,0);
  assert.equal(buildBanAccessRepair(db,proofs).changes.length,0);
  const plan=buildBanAccessRepair(db,proofs,{includeUnbanned:true});
  assert.equal(plan.counts.restoredLegacyLinks,1);
  applyBanAccessRepair(db,plan);
  assert.deepEqual(db.prepare("SELECT scope,active,public_token_enc,password_hash FROM access_grants").get(),
    {scope:'current',active:1,public_token_enc:'fake-encrypted-public',password_hash:'fake-password-hash'});
  assert.equal((db.prepare("SELECT deactivation_locked FROM gpt_accounts").get() as any).deactivation_locked,0);
  assert.equal(buildBanAccessRepair(db,proofs,{includeUnbanned:true}).changes.length,0);
});

test("a restored account needs explicit acknowledgment of an earlier deletion; reclaim and revoke always win", async(t)=>{
  for(const kind of ['valid','not-authorized','no-restoration','restoration-before-deletion','revoked','reclaimed','later-delete']) await t.test(kind,child=>{
    const {db,originals}=fixture(child);
    db.exec("UPDATE gpt_accounts SET lifecycle_status='active',deactivation_locked=0,deactivated_at=''");
    db.prepare("INSERT INTO lifecycle_events VALUES('delete','account','account_deleted','2026-09-03T05:14:29Z','v2-admin','{}','2026-09-03T05:14:29Z')").run();
    if(kind!=='no-restoration') db.prepare("INSERT INTO lifecycle_events VALUES('restore','account','account_restored',?,'operator-correction','{}','2026-09-03T06:21:47Z')")
      .run(kind==='restoration-before-deletion'?'2026-09-03T04:00:00Z':'2026-09-03T06:21:47Z');
    if(kind==='revoked')db.exec("INSERT INTO lifecycle_events VALUES('revoke','account','customer_access_revoked','2026-09-03T07:00:00Z','v2-admin','{}','2026-09-03T07:00:00Z')");
    if(kind==='reclaimed')db.exec("INSERT INTO account_relations VALUES('reclaim','account','other','mailbox_recycle','confirmed')");
    if(kind==='later-delete')db.exec("INSERT INTO lifecycle_events VALUES('delete-again','account','account_deleted','2026-09-03T07:00:00Z','v2-admin','{}','2026-09-03T07:00:00Z')");
    const proofs=createLegacyLinkProofs(db,originals,()=>true,true);
    const plan=buildBanAccessRepair(db,proofs,{includeUnbanned:true,restoreAfterDeletion:kind==='not-authorized'?[]:['account']});
    assert.equal(plan.changes.length,kind==='valid'?1:0);
    if(kind==='valid'){
      db.exec("INSERT INTO lifecycle_events VALUES('late-revoke','account','customer_access_revoked','2026-09-03T08:00:00Z','v2-admin','{}','2026-09-03T08:00:00Z')");
      assert.throws(()=>applyBanAccessRepair(db,plan));
      assert.equal((db.prepare('SELECT active FROM access_grants').get() as any).active,0);
    }
  });
});
