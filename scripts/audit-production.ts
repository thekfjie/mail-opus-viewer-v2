import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Explicit snapshot only. Importing the runtime DB would run writable migrations.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--database") {
  throw new Error("Usage: npm run audit -- --database /absolute/path/to/review-snapshot.sqlite");
}
const filename = path.resolve(args[1]);
if (!fs.statSync(filename).isFile()) throw new Error("Database snapshot must be an existing file");
const database = new Database(filename, { readonly: true, fileMustExist: true });
try {
  database.pragma("query_only = ON");
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name));
  const count = (sql: string) => Number((database.prepare(sql).get() as { n: number }).n);
  const checks: Record<string, boolean> = {
    domainSchema: ["schema_meta", "gpt_accounts", "email_bindings", "mail_messages", "mail_ownership_claims", "access_grants"].every((name) => tables.has(name)),
    integrity: database.pragma("integrity_check", { simple: true }) === "ok",
    foreignKeys: database.pragma("foreign_key_check").length === 0,
  };
  const counts: Record<string, number> = {};
  for (const table of ["gpt_accounts", "email_bindings", "mail_messages", "mail_ownership_claims", "access_grants", "raw_import_records"]) {
    if (tables.has(table)) counts[table] = count(`SELECT COUNT(*) n FROM ${table}`);
  }
  if (tables.has("gpt_accounts") && tables.has("access_grants")) {
    checks.revokedOrDeletedGrantsInactive = count(`SELECT COUNT(*) n FROM access_grants g
      JOIN gpt_accounts a ON a.id=g.account_id WHERE g.active=1 AND g.scope!='admin_only'
        AND (g.revoked_at!='' OR g.revoke_reason!='' OR a.deleted_at!='')`) === 0;
  }
  if (tables.has("mail_ownership_claims")) {
    checks.ambiguousMailHidden = count(`SELECT COUNT(*) n FROM mail_ownership_claims c
      WHERE c.visible_to_customer=1 AND c.message_id IN (
        SELECT message_id FROM mail_ownership_claims GROUP BY message_id HAVING COUNT(DISTINCT account_id)>1)`) === 0;
  }
  const forbiddenColumns: string[] = [];
  for (const table of ["mail_messages", "mail_ingestion_state", "mail_read_requests", "mail_read_failures"]) {
    if (!tables.has(table)) continue;
    for (const column of database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]) {
      if (/^(raw|raw_mime|raw_blob|body|body_text|body_html|html|mime|attachment_data|parsed_text|parsed_html)$/i.test(column.name)) {
        forbiddenColumns.push(`${table}.${column.name}`);
      }
    }
  }
  checks.indexOnlySchema = forbiddenColumns.length === 0;
  const ok = Object.values(checks).every(Boolean);
  process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), ok, checks, counts, forbiddenColumns }, null, 2)}\n`);
  if (!ok) process.exitCode = 2;
} finally {
  database.close();
}
