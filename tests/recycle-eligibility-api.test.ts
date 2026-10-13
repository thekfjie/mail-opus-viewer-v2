import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("recycle qualification reads and worker cycles never reclaim; explicit admin API enforces eligibility", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opus-recycle-api-"));
  Object.assign(process.env, { PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "db.sqlite"), ENV_FILE: "/dev/null",
    V2_SESSION_SECRET: "offline-recycle-api-session", CREDENTIAL_ENCRYPTION_KEY: "offline-recycle-api-key", V2_READ_ONLY: "false",
    VIEWER_ADMIN_PASSWORD: "offline-admin-password", V2_AUTO_TRIAL_ENABLED: "false", V2_OUTLOOK_MAIL_SYNC_ENABLED: "false" });
  let network = 0;
  t.mock.method(globalThis, "fetch", async () => { network++; throw new Error("offline_no_network"); });
  const [{ db }, repository, transitions, { buildApp }, { signSession }, { createWorker }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/repository.js"), import("../src/server/account-transitions.js"),
    import("../src/server/server.js"), import("../src/server/crypto.js"), import("../src/server/worker.js"),
  ]);
  const app = await buildApp();
  t.after(async () => { await app.close(); (await db.close()); fs.rmSync(directory, { recursive: true, force: true }); });
  const email = "recycle-qualification@icloud.com";
  const token = [Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ sub: "offline-recycle-sub", email,
    "https://api.openai.com/auth": { chatgpt_plan_type: "free" } })).toString("base64url"), "offline-signature"].join(".");
  assert.equal((await repository.importAccounts([{ email, accessToken: token }])).errors.length, 0);
  const owner = (await repository.listAccounts({ search: email })).results[0];
  const binding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(owner.id)) as any;
  const grant = (await repository.createCustomerGrant(owner.id, binding.id, { password: "offline-customer-password" }));
  (await transitions.freezeAccountTransition(owner.id, "fixture_ban", "test", new Date(Date.now() - 6 * 86_400_000).toISOString()));
  const headers = { cookie: `mail_opus_v2_admin=${signSession("admin", "administrator")}` };
  const url = `/api/v2/admin/accounts/${owner.id}/recycle-eligibility`;
  const writeUrl = `/api/v2/admin/accounts/${owner.id}/recycle`;
  const originalGrant = (await db.prepare("SELECT * FROM access_grants WHERE id=?").get(grant.grantId));
  const originalEvents = ((await db.prepare("SELECT COUNT(*) n FROM lifecycle_events").get()) as any).n;
  assert.equal((await app.inject(url)).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/v2/admin/accounts/missing/recycle-eligibility", headers })).statusCode, 404);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
    const qualification = response.json();
    assert.equal(qualification.modes.deactivated.eligible, false);
    assert.equal(qualification.modes.deactivated.trigger, "admin_only");
    assert.ok(!response.body.includes(token) && !response.body.includes("offline-customer-password"));
  }
  assert.deepEqual((await db.prepare("SELECT * FROM access_grants WHERE id=?").get(grant.grantId)), originalGrant);
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM lifecycle_events").get()) as any).n, originalEvents);
  for (const payload of [{ mode: "deactivated", confirmRevokeCustomerAccess: true }, { email: "cannot-bypass@icloud.com", confirmRevokeCustomerAccess: true }]) {
    assert.equal((await app.inject({ method: "POST", url: writeUrl, headers, payload })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "POST", url: writeUrl, payload: { mode: "deactivated" } })).statusCode, 401);
  const foreign = await app.inject({ method: "POST", url: writeUrl, headers: { ...headers, origin: "https://foreign.example.test" }, payload: { mode: "deactivated" } });
  assert.ok([400, 403].includes(foreign.statusCode));
  assert.deepEqual((await db.prepare("SELECT * FROM access_grants WHERE id=?").get(grant.grantId)), originalGrant);

  (await db.prepare("UPDATE gpt_accounts SET deactivated_at=? WHERE id=?").run(new Date(Date.now() - 8 * 86_400_000).toISOString(), owner.id));
  assert.equal((await app.inject({ url, headers })).json().modes.deactivated.eligible, true);
  for (const confirmation of [undefined, false, "true"]) {
    assert.equal((await app.inject({ method: "POST", url: writeUrl, headers,
      payload: { mode: "deactivated", confirmRevokeCustomerAccess: confirmation } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/mappings/recycle", headers,
      payload: { ids: [owner.id], mode: "deactivated", confirmRevokeCustomerAccess: confirmation } })).statusCode, 400);
  }
  // The old registration caller has admin credentials but no human confirmation.
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/mappings/recycle", headers,
    payload: { ids: [owner.id], mode: "alias_rotate" } })).statusCode, 400);

  // V1's OpenAI registration retry caller rotates a pending automatic alias
  // without a separate customer-revoke confirmation. V2 may preserve that
  // contract only when no customer grant is active.
  const pendingEmail = "pending-alias-compat@icloud.com";
  assert.equal((await repository.importAccounts([{ email: pendingEmail }])).errors.length, 0);
  const pending = (await repository.listAccounts({ search: pendingEmail })).results[0];
  (await db.prepare("UPDATE gpt_accounts SET note='automyai OpenAI signup pool pending' WHERE id=?").run(pending.id));
  (await db.prepare("INSERT INTO account_origins(account_id,source_type,source_id,is_auto,first_seen_at) VALUES(?,'test','compat-pending',1,?)")
    .run(pending.id, new Date().toISOString()));
  const rotatedPending = await app.inject({ method: "POST", url: "/api/admin/mappings/recycle", headers,
    payload: { ids: [pending.id], mode: "alias_rotate" } });
  assert.equal(rotatedPending.statusCode, 200);
  assert.equal(rotatedPending.json().ok, true);
  assert.equal(rotatedPending.json().recycled, 1);

  for (const mode of ["", false, 0, "unknown"]) {
    for (const target of [writeUrl, "/api/admin/mappings/recycle"]) {
      assert.equal((await app.inject({ method: "POST", url: target, headers,
        payload: { ids: [owner.id], mode, confirmRevokeCustomerAccess: true } })).statusCode, 400);
    }
  }
  const recycleRelationsBeforeWorker = ((await db.prepare("SELECT COUNT(*) n FROM account_relations WHERE relation_type='mailbox_recycle'").get()) as any).n;
  const worker = createWorker({ sub2api: async () => ({ total: 0, active: 0, matched: 0, created: 0, rebinds: 0, conflicts: 0, skipped: 0 }),
    pendingMail: async () => ({ processed: 0, errors: 0 }) });
  await worker.runOnce();
  assert.deepEqual((await db.prepare("SELECT * FROM access_grants WHERE id=?").get(grant.grantId)), originalGrant);
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM account_relations WHERE relation_type='mailbox_recycle'").get()) as any).n, recycleRelationsBeforeWorker);
  assert.equal((await app.inject(`/api/preset?m=${encodeURIComponent(grant.publicToken)}`)).statusCode, 200);
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { email, password: grant.password } });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
  const applied = await app.inject({ method: "POST", url: writeUrl, headers, payload: { mode: "deactivated", confirmRevokeCustomerAccess: true } });
  assert.equal(applied.statusCode, 200);
  assert.equal((await app.inject(`/api/preset?m=${encodeURIComponent(grant.publicToken)}`)).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/session", headers: { cookie } })).statusCode, 401);
  assert.equal((await app.inject({ url, headers })).json().modes.deactivated.eligible, false);
  assert.equal((await app.inject({ method: "POST", url: writeUrl, headers, payload: { mode: "deactivated", confirmRevokeCustomerAccess: true } })).statusCode, 400);
  assert.equal(((await db.prepare("SELECT deactivation_locked FROM gpt_accounts WHERE id=?").get(owner.id)) as any).deactivation_locked, 1);
  for (const routeMode of ["custom", "compat"] as const) {
    const address = `${routeMode}-recycle@icloud.com`;
    assert.equal((await repository.importAccounts([{ email: address }])).errors.length, 0);
    const account = (await repository.listAccounts({ search: address })).results[0];
    (await db.prepare("INSERT INTO account_business_evidence(account_id,recycle_generation,updated_at) VALUES(?,1,?)")
      .run(account.id, new Date().toISOString()));
    (await transitions.freezeAccountTransition(account.id, "fixture_ban", "test", new Date(Date.now() - 8 * 86_400_000).toISOString()));
    const response = await app.inject({ method: "POST", headers,
      url: routeMode === "custom" ? `/api/v2/admin/accounts/${account.id}/recycle` : "/api/admin/mappings/recycle",
      payload: routeMode === "custom" ? { email: "custom-replacement@icloud.com", confirmRevokeCustomerAccess: true }
        : { ids: [account.id], mode: "deactivated", confirmRevokeCustomerAccess: true } });
    assert.equal(response.statusCode, 200);
    const audit = JSON.parse(((await db.prepare("SELECT evidence_json FROM account_relations WHERE from_account_id=? AND relation_type='mailbox_recycle'").get(account.id)) as any).evidence_json);
    assert.equal(audit.mode, "deactivated");
    assert.equal(audit.eligibility.trigger, "admin_only");
    assert.equal(audit.eligibility.account.deactivationLocked, true);
    const replacementId = ((await db.prepare("SELECT to_account_id FROM account_relations WHERE from_account_id=? AND relation_type='mailbox_recycle'").get(account.id)) as any).to_account_id;
    (await transitions.freezeAccountTransition(replacementId, "fixture_ban", "test", new Date(Date.now() - 8 * 86_400_000).toISOString()));
    const replacementQualification = (await app.inject({ url: `/api/v2/admin/accounts/${replacementId}/recycle-eligibility`, headers })).json();
    assert.equal(replacementQualification.generation, 2);
    assert.equal(replacementQualification.modes.deactivated.eligible, false);
  }
  assert.equal(network, 0);
});
