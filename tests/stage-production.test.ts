import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SqliteTestDatabase as Database } from "../src/server/storage/sqlite-test.js";
import test from "node:test";

test("production staging preserves V2 identities, imports snapshots and removes content from SQLite free pages", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-stage-production-"));
  const snapshot = path.join(directory, "snapshot");
  const source = path.join(directory, "source.sqlite");
  const target = path.join(directory, "staging.sqlite");
  fs.mkdirSync(snapshot);
  const canary = "BODY-CANARY-STAGING-NEVER-PERSIST";
  const env = { ...process.env, ENV_FILE: "/dev/null", DATABASE_PATH: source, V2_SESSION_SECRET: "fake-stage-session", CREDENTIAL_ENCRYPTION_KEY: "fake-stage-encryption" };
  const seeded = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const { db } = await import('./src/server/db.ts');
    const { encryptSecret } = await import('./src/server/crypto.ts');
    const now = '2026-08-01T00:00:00.000Z';
    db.prepare("INSERT INTO gpt_accounts(id,arrived_at,created_at,updated_at) VALUES('existing-v2-account',?,?,?)").run(now,now,now);
    db.prepare("INSERT INTO account_passwords(account_id,password_enc,updated_at) VALUES('existing-v2-account',?,?)").run(encryptSecret('fake-existing-password'),now);
    db.prepare("INSERT INTO raw_import_records(source_key,source_type,source_path,source_record_id,source_hash,payload_json,imported_at) VALUES('old','v1','snapshot','old','fake-hash',?,?)")
      .run(JSON.stringify({ raw: ${JSON.stringify(canary)} }),now);
    db.prepare("INSERT INTO mail_messages(id,provider,provider_message_id,metadata_json,indexed_at) VALUES('old-mail','shared-mail-api','9',?,?)")
      .run(JSON.stringify({ source:'v1-mail-index',html:${JSON.stringify(canary)} }),now);
    db.exec('CREATE TABLE removed_payload(value TEXT)');
    db.prepare('INSERT INTO removed_payload VALUES(?)').run(${JSON.stringify(canary)}.repeat(1000));
    db.exec('DROP TABLE removed_payload');
    db.pragma('wal_checkpoint(TRUNCATE)'); db.pragma('journal_mode = DELETE'); db.close();
  `], { encoding: "utf8", env });
  const invoke = (database: string, overrides: Record<string, string> = {}) => spawnSync(process.execPath,
    ["--import", "tsx", "scripts/stage-production.ts", "--snapshot", snapshot, "--source-db", source, "--target-db", database],
    { encoding: "utf8", env: { ...env, DATABASE_PATH: path.join(directory, "must-not-open.sqlite"), ...overrides } });
  try {
    assert.equal(seeded.status, 0, seeded.stderr);
    const snapshotText = JSON.stringify([{ id: "new-snapshot-account", email: "snapshot@icloud.com", createdAt: "2026-08-01T00:00:00.000Z", raw: canary }]);
    fs.writeFileSync(path.join(snapshot, "access-config.json"), snapshotText);
    const sourceBefore = fs.readFileSync(source);
    const staged = invoke(target);
    assert.equal(staged.status, 0, staged.stderr || staged.stdout);
    const report = JSON.parse(staged.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.counts.sourceAccounts, 1);
    assert.equal(report.counts.targetAccounts, 2);
    assert.equal(report.counts.missingSourceAccounts, 0);
    assert.ok(report.counts.credentialsChecked > 0);
    assert.equal(report.checks.noFreePages, true);
    assert.equal(staged.stdout.includes("fake-existing-password"), false);
    assert.equal(fs.readFileSync(target).includes(Buffer.from(canary)), false);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(source), sourceBefore);
    assert.equal(fs.readFileSync(path.join(snapshot, "access-config.json"), "utf8"), snapshotText);
    assert.equal(fs.existsSync(path.join(directory, "must-not-open.sqlite")), false);
    const db = new Database(target, { readonly: true });
    assert.ok((await db.prepare("SELECT id FROM gpt_accounts WHERE id='existing-v2-account'").get()));
    assert.equal(((await db.prepare("SELECT metadata_json FROM mail_messages WHERE id='old-mail'").get()) as any).metadata_json, '{"source":"v1-mail-index"}');
    (await db.close());
    const beforeRepeat = fs.readFileSync(target);
    assert.notEqual(invoke(target).status, 0);
    assert.deepEqual(fs.readFileSync(target), beforeRepeat);
    assert.notEqual(invoke(path.join(snapshot, "forbidden.sqlite")).status, 0);
    assert.equal(fs.existsSync(path.join(snapshot, "forbidden.sqlite")), false);
    const wrongKey = invoke(path.join(directory, "wrong-key.sqlite"), { CREDENTIAL_ENCRYPTION_KEY: "wrong-fake-encryption" });
    assert.equal(wrongKey.status, 2, wrongKey.stderr || wrongKey.stdout);
    assert.equal(JSON.parse(wrongKey.stdout).checks.credentialsDecryptable, false);
    assert.equal(wrongKey.stdout.includes("fake-existing-password"), false);
    assert.deepEqual(fs.readFileSync(source), sourceBefore);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
