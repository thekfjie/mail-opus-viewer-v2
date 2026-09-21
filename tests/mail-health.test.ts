import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("administrator mail health exposes local aggregates, exact rolling budgets and no secrets or upstream calls", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-mail-health-"));
  Object.assign(process.env, {
    PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "health.sqlite"), ENV_FILE: "/dev/null",
    V2_SESSION_SECRET: "fake-health-session", CREDENTIAL_ENCRYPTION_KEY: "fake-health-encryption",
    VIEWER_ADMIN_PASSWORD: "fake-health-admin", V2_READ_ONLY: "false", V2_MAIL_WEBHOOK_SECRET: "fake-health-hook",
    V2_CF_ACCOUNT_ID: "fake-health-account", V2_CF_D1_DATABASE_ID: "fake-health-database", V2_CF_D1_READ_TOKEN: "fake-health-token",
    V2_CF_D1_TIME_INDEX: "idx_raw_mails_created_at",
  });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests += 1; throw new Error("upstream forbidden"); });
  const [{ buildApp }, { db }, { signSession }, { mailHealth }, { MAIL_READ_LIMITS }, { config }] = await Promise.all([
    import("../src/server/server.js"), import("../src/server/db.js"), import("../src/server/crypto.js"),
    import("../src/server/mail-health.js"), import("../src/server/cf-mail.js"), import("../src/server/config.js"),
  ]);
  const app = await buildApp();
  t.after(async () => { await app.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const endpoint = "/api/v2/admin/mail-health";
  assert.equal((await app.inject(endpoint)).statusCode, 401);
  assert.equal((await app.inject({ url: endpoint, headers: { cookie: "mail_opus_v2_admin=" + signSession("customer", "fake-customer") } })).statusCode, 401);
  const headers = { cookie: "mail_opus_v2_admin=" + signSession("admin", "administrator") };
  assert.equal((await app.inject({ url: endpoint, headers: { ...headers, origin: "https://evil.example" } })).statusCode, 403);
  const now = Date.parse("2026-09-08T08:00:00Z");
  const event = db.prepare(`INSERT INTO mail_ingestion_state(provider,provider_message_id,status,attempts,error_code,discovered_at,updated_at)
    VALUES('shared-mail-api',?,?,?,?,?,?)`);
  event.run("sensitive-provider-id-one", "processed", 0, "", "2026-09-08T07:00:00Z", "2026-09-08T07:00:01Z");
  event.run("sensitive-provider-id-two", "pending_time", 0, "", "2026-09-08T07:01:00Z", "2026-09-08T07:01:00Z");
  event.run("sensitive-provider-id-three", "pending_parse", 1, "sensitive-untrusted-error", "2026-09-08T07:02:00Z", "2026-09-08T07:02:00Z");
  event.run("sensitive-provider-id-four", "pending_time", 3, "sensitive-untrusted-error", "2026-09-08T07:03:00Z", "2026-09-08T07:03:00Z");
  const ledger = db.prepare("INSERT INTO mail_read_requests(id,started_at,rows_read,outcome) VALUES(?,?,?,?)");
  ledger.run("read-minute", now - 59_999, 2, "ok");
  ledger.run("read-minute-boundary", now - 60_000, 3, "mail_d1_interrupted");
  ledger.run("read-day", now - 86_399_999, 7, "ok");
  ledger.run("read-day-boundary", now - 86_400_000, 100, "ok");
  db.prepare("UPDATE mail_read_control SET blocked_reason=?,lease_until=?,backfill_at=? WHERE id=1")
    .run("sensitive-untrusted-error", now + 10_000, now - 1000);
  db.prepare(`INSERT INTO mail_messages(id,provider,provider_message_id,subject,category,received_at,indexed_at)
    VALUES('orphan','test','sensitive-mail-id','OpenAI - Access Deactivated','deactivation','2026-09-08T07:00:00Z','2026-09-08T07:00:00Z')`).run();
  db.prepare(`INSERT INTO pending_reviews(id,review_type,candidate_email_hash,reason,evidence_json,created_at,updated_at)
    VALUES('orphan-review','mail_ownership_ambiguous','sensitive-hash','deactivation_owner_unresolved','{}','2026-09-08T07:00:00Z','2026-09-08T07:00:00Z')`).run();
  const beforeHealth = db.serialize();
  const snapshot = mailHealth(now);
  assert.deepEqual(snapshot.notices, { total: 1, unassigned: 1, pendingReviews: 1 });
  assert.deepEqual(db.serialize(), beforeHealth, "health reads never repair, revoke or read upstream");
  assert.deepEqual(snapshot.ingestion, { total: 4, processed: 1, pending: 2, failed: 1, retrying: 1 });
  assert.deepEqual(snapshot.d1.limits, MAIL_READ_LIMITS);
  assert.equal(snapshot.d1.minuteRequests, 1);
  assert.equal(snapshot.d1.dayRequests, 3);
  assert.equal(snapshot.d1.dayRowsRead, 12);
  assert.equal(snapshot.d1.activeRequest, true);
  assert.equal(snapshot.d1.blockedReason, "other");
  assert.equal(snapshot.d1.backfillAvailableAt, new Date(now - 1000 + MAIL_READ_LIMITS.backfillCooldownMs).toISOString());
  assert.equal(snapshot.webhook.lastEventAt, "2026-09-08T07:03:00.000Z");
  assert.equal(snapshot.webhook.lastProcessedAt, "2026-09-08T07:00:01.000Z");
  assert.equal(snapshot.webhook.configured, true);
  assert.equal(snapshot.d1.configured, true);
  assert.equal(snapshot.background.redisConnected, false);
  const response = await app.inject({ url: endpoint, headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json().storage, { mode: "lightweight-index", bodyRead: "upstream-by-id" });
  assert.doesNotMatch(response.body, /sensitive-|fake-health-|provider_message_id|blocked_reason|raw MIME|parsedHtml|Bearer/);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM mail_read_requests").get() as any).n, 4);
  const saved = { hook: config.mailWebhookSecret, token: config.cfD1ReadToken, index: config.cfD1TimeIndex };
  config.mailWebhookSecret = ""; config.cfD1ReadToken = ""; config.cfD1TimeIndex = "";
  const missing = mailHealth(now);
  assert.equal(missing.webhook.configured, false);
  assert.equal(missing.d1.configured, false);
  assert.equal(missing.d1.manualBackfillReady, false);
  config.mailWebhookSecret = saved.hook; config.cfD1ReadToken = saved.token; config.cfD1TimeIndex = saved.index;
  assert.equal(requests, 0);
});
