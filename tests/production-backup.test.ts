import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { SqliteTestDatabase as Database } from "../src/server/storage/sqlite-test.js";

async function fixture(root: string) {
  const v1 = path.join(root, "v1");
  const units = path.join(root, "units");
  fs.mkdirSync(path.join(v1, "backups", "old"), { recursive: true });
  fs.mkdirSync(path.join(units, "mail-opus-viewer.service.d"), { recursive: true });
  const body = "BODY-MUST-NEVER-ENTER-BACKUP-82734";
  const secret = "fake-business-secret-not-for-production";
  const config = [{ id: "mapping", openaiAccessToken: secret, raw: body, unknown: { html: body, legitimate: true } }];
  fs.writeFileSync(path.join(v1, "access-config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(v1, "backups", "old", "access-config.bak-2026"), JSON.stringify(config));
  fs.writeFileSync(path.join(v1, "backups", "raw-mail-cache.json"), body);
  fs.writeFileSync(path.join(v1, "mail-index-cache.json"), JSON.stringify({ version: 2, raw: body, entries: { mapping: {
    configKey: "fake-config", mails: [{ id: "12", subject: "Example", created_at: "2026-09-08T00:00:00.000Z",
      envelopeRecipients: ["test@example.com"], raw: body, raw_blob: Buffer.from(body).toString("base64"),
      text: body, html: body, attachments: [{ content: body }], preview: body, unknownCache: body }], text: body,
  } } }));
  fs.writeFileSync(path.join(v1, "mail-flag-cache.json"), JSON.stringify({ entries: { mapping: { hasPlus: false, configKey: "fake-config", updatedAt: 1, raw: body } } }));
  fs.writeFileSync(path.join(v1, "usage-audit-cache.json"), JSON.stringify({ entries: { mapping: { billingAt: 1, html: body } } }));
  for (const unit of ["mail-opus-viewer.service", "mail-opus-viewer-v2.service", "mail-opus-viewer-v2-worker.service"]) {
    fs.writeFileSync(path.join(units, unit), "[Service]\nExecStart=/bin/true\n");
  }
  fs.writeFileSync(path.join(units, "mail-opus-viewer.service.d", "override.conf"), "[Service]\nEnvironment=FAKE=true\n");
  const nginx = [path.join(root, "mail.conf"), path.join(root, "cloud.conf")];
  nginx.forEach((filename) => fs.writeFileSync(filename, "server { listen 80; }\n"));
  const environment = path.join(root, "runtime.env");
  fs.writeFileSync(environment, `FAKE_TOKEN=${secret}\n`);
  const database = path.join(root, "source.sqlite");
  const connection = new Database(database);
  connection.pragma("journal_mode=WAL");
  (await connection.exec("CREATE TABLE accounts(id INTEGER PRIMARY KEY); INSERT INTO accounts VALUES(1)"));
  const destination = path.join(root, "backup");
  const args = ["scripts/production-backup.mjs", "--destination", destination, "--database", database,
    "--v1-root", v1, "--systemd-root", units, "--nginx-file", nginx[0], "--nginx-file", nginx[1], "--env-file", environment];
  return { body, secret, v1, connection, database, destination, args };
}

test("production backup uses a read-only consistent SQLite copy and protected sanitized snapshots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-production-backup-"));
  const input = (await fixture(root));
  try {
    const sourceBefore = fs.readFileSync(path.join(input.v1, "mail-index-cache.json"));
    (await input.connection.prepare("INSERT INTO accounts VALUES(2)").run());
    const command = spawnSync(process.execPath, input.args, { encoding: "utf8" });
    assert.equal(command.status, 0, command.stderr);
    assert.equal(command.stdout.includes(input.secret), false);
    assert.equal(command.stdout.includes(input.body), false);
    const summary = JSON.parse(command.stdout);
    assert.equal(summary.accessRecords, 1);
    assert.equal(summary.indexedMails, 1);
    assert.equal(summary.legacyBackupFiles, 1);
    const manifestBytes = fs.readFileSync(path.join(input.destination, "manifest.json"));
    assert.equal(summary.manifestSha256, crypto.createHash("sha256").update(manifestBytes).digest("hex"));
    const manifest = JSON.parse(manifestBytes.toString());
    const snapshot = new Database(path.join(input.destination, "protected/v2/mail-opus-v2.sqlite"), { readonly: true });
    assert.deepEqual((await snapshot.prepare("SELECT id FROM accounts ORDER BY id").all()), [{ id: 1 }, { id: 2 }]);
    (await snapshot.close());
    for (const entry of manifest.files) {
      const bytes = fs.readFileSync(path.join(input.destination, entry.path));
      assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), entry.sha256);
      assert.equal(bytes.includes(Buffer.from(input.body)), false, entry.path);
      assert.equal(bytes.includes(Buffer.from(Buffer.from(input.body).toString("base64"))), false, entry.path);
      assert.equal(entry.path.startsWith("protected/"), true);
    }
    const walk = (directory: string) => {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(filename);
        else assert.equal(fs.statSync(filename).mode & 0o777, 0o600, filename);
      }
    };
    walk(input.destination);
    assert.deepEqual(fs.readFileSync(path.join(input.v1, "mail-index-cache.json")), sourceBefore);
    const repeated = spawnSync(process.execPath, input.args, { encoding: "utf8" });
    assert.equal(repeated.status, 1);
    assert.equal(JSON.parse(repeated.stderr).code, "DESTINATION_ALREADY_EXISTS");
    assert.equal(fs.existsSync(path.join(input.destination, "INCOMPLETE")), false);
  } finally { (await input.connection.close()); fs.rmSync(root, { recursive: true, force: true }); }
});

test("backup failures mark partial artifacts and never print source JSON or credentials", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-production-backup-failure-"));
  const input = (await fixture(root));
  try {
    fs.writeFileSync(path.join(input.v1, "access-config.json"), `${input.secret} ${input.body}`);
    const command = spawnSync(process.execPath, input.args, { encoding: "utf8" });
    assert.equal(command.status, 1);
    assert.equal(command.stderr.includes(input.secret), false);
    assert.equal(command.stderr.includes(input.body), false);
    assert.equal(fs.existsSync(path.join(input.destination, "INCOMPLETE")), true);
    assert.equal(fs.existsSync(path.join(input.destination, "manifest.json")), false);
    assert.equal(fs.statSync(path.join(input.destination, "INCOMPLETE")).mode & 0o777, 0o600);
  } finally { (await input.connection.close()); fs.rmSync(root, { recursive: true, force: true }); }
});

test("backup rejects a source snapshot with foreign key violations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-production-backup-fk-"));
  const input = (await fixture(root));
  try {
    input.connection.pragma("foreign_keys=OFF");
    (await input.connection.exec("CREATE TABLE grants(account_id INTEGER REFERENCES accounts(id)); INSERT INTO grants VALUES(999)"));
    const command = spawnSync(process.execPath, input.args, { encoding: "utf8" });
    assert.equal(command.status, 1);
    assert.equal(JSON.parse(command.stderr).code, "SQLITE_FOREIGN_KEYS_FAILED");
    assert.equal(fs.existsSync(path.join(input.destination, "INCOMPLETE")), true);
    assert.equal(fs.existsSync(path.join(input.destination, "manifest.json")), false);
  } finally { (await input.connection.close()); fs.rmSync(root, { recursive: true, force: true }); }
});
