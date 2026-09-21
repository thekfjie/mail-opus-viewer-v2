import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export async function migrateSnapshot(args = process.argv.slice(2)): Promise<unknown> {
  const index = args.indexOf("--snapshot");
  const root = index >= 0 ? args[index + 1] : "";
  if (!root) throw new Error("Usage: migrate:v1 -- --snapshot <explicit-snapshot-directory>; DATABASE_PATH must point to a staging database");
  if (!process.env.DATABASE_PATH) throw new Error("DATABASE_PATH must explicitly select a staging database");
  const snapshot = path.resolve(root);
  const currentSnapshot = path.join(snapshot, "access-config.json");
  const records = JSON.parse(fs.readFileSync(currentSnapshot, "utf8"));
  if (!Array.isArray(records)) throw new Error("Snapshot access-config.json must be an array");
  const database = path.resolve(process.env.DATABASE_PATH);
  if (database.startsWith(snapshot + path.sep) || database === snapshot) throw new Error("Staging database must be outside the source snapshot");
  if (fs.existsSync(database) && !args.includes("--update-staging")) throw new Error("Existing staging database requires --update-staging");
  process.env.DATABASE_PATH = database;
  process.env.ENV_FILE ||= "/dev/null";
  process.env.V1_CONFIG_FILE = currentSnapshot;
  process.env.V1_MAIL_INDEX_FILE = path.join(snapshot, "mail-index-cache.json");
  process.env.V1_MAIL_FLAG_FILE = path.join(snapshot, "mail-flag-cache.json");
  process.env.V1_USAGE_AUDIT_FILE = path.join(snapshot, "usage-audit-cache.json");
  process.env.V1_BACKUPS_DIR = path.join(snapshot, "backups");
  const { syncFromV1 } = await import("./legacy-import.js");
  return syncFromV1();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await migrateSnapshot(), null, 2)}\n`);
  } catch {
    process.stderr.write("Snapshot migration failed; check explicit snapshot and staging database configuration.\n");
    process.exitCode = 1;
  }
}
