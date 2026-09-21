import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

type StagingReport = { ok: boolean; checks: Record<string, boolean>; counts: Record<string, number> };
const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;
const mailMetadataKeys = new Set(["source", "method", "receivedTimeVerified", "legacyAddress", "rebindNotification"]);
const bodyKey = /^(raw|rawmime|raw_mime|raw_blob|body|bodytext|bodyhtml|body_text|body_html|html|mime|attachments?|attachment_data|parsedtext|parsedhtml|parsed_text|parsed_html)$/i;

function containsMailContent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsMailContent);
  return Object.entries(value).some(([key, entry]) => bodyKey.test(key) || containsMailContent(entry));
}

function audit(database: Database.Database, sourceIds: Set<string>, decryptSecret: (value: string) => string): StagingReport {
  const count = (sql: string) => Number((database.prepare(sql).get() as any)?.n || 0);
  const targetIds = new Set((database.prepare("SELECT id FROM gpt_accounts").all() as any[]).map((row) => String(row.id)));
  const counts: Record<string, number> = {
    sourceAccounts: sourceIds.size, targetAccounts: targetIds.size,
    missingSourceAccounts: [...sourceIds].filter((id) => !targetIds.has(id)).length,
    lockedAccounts: count("SELECT COUNT(*) n FROM gpt_accounts WHERE deactivation_locked=1"),
    mailMessages: count("SELECT COUNT(*) n FROM mail_messages"),
    mailClaims: count("SELECT COUNT(*) n FROM mail_ownership_claims"),
    credentialsChecked: 0, invalidCredentials: 0, invalidMailMetadata: 0, forbiddenMailColumns: 0, unsafeJsonValues: 0,
  };
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[];
  for (const { name } of tables) {
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as any[];
    for (const column of columns) {
      if (String(name).startsWith("mail_") && bodyKey.test(column.name)) counts.forbiddenMailColumns += 1;
      if (String(column.name).endsWith("_enc")) {
        for (const row of database.prepare(`SELECT ${quoteIdentifier(column.name)} value FROM ${quoteIdentifier(name)} WHERE ${quoteIdentifier(column.name)}!=''`).iterate() as Iterable<any>) {
          counts.credentialsChecked += 1;
          try { if (!String(row.value).startsWith("v1.") || !decryptSecret(String(row.value))) counts.invalidCredentials += 1; }
          catch { counts.invalidCredentials += 1; }
        }
      }
      if (String(column.name).endsWith("_json")) {
        for (const row of database.prepare(`SELECT ${quoteIdentifier(column.name)} value FROM ${quoteIdentifier(name)}`).iterate() as Iterable<any>) {
          try { if (containsMailContent(JSON.parse(String(row.value || "{}")))) counts.unsafeJsonValues += 1; }
          catch { counts.unsafeJsonValues += 1; }
        }
      }
    }
  }
  for (const row of database.prepare("SELECT metadata_json FROM mail_messages").iterate() as Iterable<any>) {
    try {
      const metadata = JSON.parse(row.metadata_json);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || Buffer.byteLength(row.metadata_json) > 2048
        || Object.entries(metadata).some(([key, value]) => !mailMetadataKeys.has(key)
          || !["string", "number", "boolean"].includes(typeof value))) counts.invalidMailMetadata += 1;
    } catch { counts.invalidMailMetadata += 1; }
  }
  const checks = {
    integrity: database.pragma("integrity_check", { simple: true }) === "ok",
    foreignKeys: (database.pragma("foreign_key_check") as unknown[]).length === 0,
    originalAccountIdsPreserved: counts.missingSourceAccounts === 0,
    credentialsDecryptable: counts.invalidCredentials === 0,
    revokedOrDeletedGrantsInactive: count(`SELECT COUNT(*) n FROM access_grants g JOIN gpt_accounts a ON a.id=g.account_id
      WHERE g.active=1 AND g.scope!='admin_only' AND (g.revoked_at!='' OR g.revoke_reason!='' OR a.deleted_at!='')`) === 0,
    endedSalesClosed: count("SELECT COUNT(*) n FROM sales WHERE status='active' AND (ended_at!='' OR end_reason!='')") === 0,
    ambiguousMailHidden: count(`SELECT COUNT(*) n FROM mail_ownership_claims c WHERE c.visible_to_customer=1
      AND EXISTS(SELECT 1 FROM mail_ownership_claims other WHERE other.message_id=c.message_id AND other.account_id<>c.account_id)`) === 0,
    importEnvelopesCleared: count("SELECT COUNT(*) n FROM raw_import_records WHERE payload_json!='{}'") === 0,
    mailMetadataLightweight: counts.invalidMailMetadata === 0,
    indexOnlySchema: counts.forbiddenMailColumns === 0,
    jsonContainsNoMailContent: counts.unsafeJsonValues === 0,
    noFreePages: Number(database.pragma("freelist_count", { simple: true })) === 0,
  };
  return { ok: Object.values(checks).every(Boolean), checks, counts };
}

export async function stageProduction(args = process.argv.slice(2)): Promise<StagingReport> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!["--snapshot", "--source-db", "--target-db"].includes(name) || !value || options.has(name)) throw new Error("invalid_arguments");
    options.set(name, value);
  }
  if (options.size !== 3 || !process.env.ENV_FILE || !fs.existsSync(process.env.ENV_FILE)) throw new Error("explicit_snapshot_database_and_environment_required");
  const snapshot = fs.realpathSync(options.get("--snapshot")!);
  const source = fs.realpathSync(options.get("--source-db")!);
  const requestedTarget = path.resolve(options.get("--target-db")!);
  const target = path.join(fs.realpathSync(path.dirname(requestedTarget)), path.basename(requestedTarget));
  if (!fs.statSync(snapshot).isDirectory() || !fs.statSync(source).isFile() || fs.existsSync(target)
    || target === source || target === snapshot || target.startsWith(snapshot + path.sep)
    || fs.existsSync(`${target}-wal`) || fs.existsSync(`${target}-shm`)) throw new Error("unsafe_staging_target");
  if (fs.existsSync(`${source}-wal`) && fs.statSync(`${source}-wal`).size > 0) throw new Error("source_must_be_a_complete_database_backup");
  const records = JSON.parse(fs.readFileSync(path.join(snapshot, "access-config.json"), "utf8"));
  if (!Array.isArray(records)) throw new Error("snapshot_accounts_must_be_array");
  const previousUmask = process.umask(0o077);
  const compact = `${target}.compact-${crypto.randomUUID()}`;
  let opened: Database.Database | undefined;
  let createdTarget = false;
  let compacted = false;
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    createdTarget = true;
    fs.chmodSync(target, 0o600);
    opened = new Database(target, { fileMustExist: true });
    if (opened.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("source_database_integrity_failed");
    const sourceIds = new Set((opened.prepare("SELECT id FROM gpt_accounts").all() as any[]).map((row) => String(row.id)));
    opened.close(); opened = undefined;
    // Runtime modules must see only the staging path, even if the protected env names production.
    process.env.DATABASE_PATH = target;
    process.env.V2_AUTO_TRIAL_ENABLED = "false";
    process.env.V2_SHARED_MAIL_SYNC_ENABLED = "false";
    process.env.V2_OUTLOOK_MAIL_SYNC_ENABLED = "false";
    const { migrateSnapshot } = await import("../src/server/migrate-v1.js");
    await migrateSnapshot(["--snapshot", snapshot, "--update-staging"]);
    const [{ db }, { decryptSecret }] = await Promise.all([import("../src/server/db.js"), import("../src/server/crypto.js")]);
    opened = db;
    db.transaction(() => {
      db.exec("UPDATE raw_import_records SET payload_json='{}'");
      const update = db.prepare("UPDATE mail_messages SET metadata_json=? WHERE id=?");
      for (const row of db.prepare("SELECT id,metadata_json FROM mail_messages").all() as any[]) {
        let metadata: Record<string, unknown> = {};
        try { metadata = JSON.parse(String(row.metadata_json || "{}")); } catch {}
        const entries = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? Object.entries(metadata) : [];
        const lightweight = Object.fromEntries(entries.filter(([key, value]) => mailMetadataKeys.has(key)
          && ["string", "number", "boolean"].includes(typeof value))
          .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 256) : value]));
        update.run(JSON.stringify(lightweight), row.id);
      }
    })();
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode = DELETE");
    db.prepare("VACUUM INTO ?").run(compact);
    db.close(); opened = undefined;
    fs.chmodSync(compact, 0o600);
    fs.renameSync(compact, target);
    compacted = true;
    opened = new Database(target, { readonly: true, fileMustExist: true });
    opened.pragma("query_only = ON");
    return audit(opened, sourceIds, decryptSecret);
  } finally {
    if (opened?.open) opened.close();
    if (fs.existsSync(compact)) fs.unlinkSync(compact);
    if (createdTarget && !compacted) {
      for (const file of [target, `${target}-wal`, `${target}-shm`, `${target}-journal`]) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    }
    process.umask(previousUmask);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await stageProduction();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 2;
  } catch {
    process.stderr.write("Staging migration failed; source backups were not modified. Check explicit paths and protected environment configuration.\n");
    process.exitCode = 1;
  }
}
