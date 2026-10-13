import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { SqliteTestDatabase as Database } from "../src/server/storage/sqlite-test.js";
import { D1MailReader, MailReadError } from "../src/server/cf-mail.js";

export interface IndexVerificationReport {
  verified: boolean;
  requests: number;
  rowsRead: number;
  error?: string;
}

// D1 is read-only. The explicitly selected existing local database is writable
// only so verification shares the candidate/runtime's persistent request budget.
// This script never loads .env implicitly, migrates a schema or changes config.
export async function verifyD1Index(args = process.argv.slice(2), transport: typeof fetch = globalThis.fetch): Promise<IndexVerificationReport> {
  let database: Database | undefined;
  let previous = new Set<string>();
  let verified = false;
  let error: string | undefined;
  let requests = 0;
  let rowsRead = 0;
  try {
    const options = new Map<string, string>();
    for (let at = 0; at < args.length; at += 2) {
      if (!["--database", "--env"].includes(args[at]) || !args[at + 1] || options.has(args[at])) throw new Error("arguments");
      options.set(args[at], args[at + 1]);
    }
    if (options.size !== 2) throw new Error("explicit_database_and_environment_required");
    const environmentFile = fs.realpathSync(options.get("--env")!);
    if ((fs.statSync(environmentFile).mode & 0o777) !== 0o600) throw new Error("environment_mode");
    const environment = parseEnv(fs.readFileSync(environmentFile, "utf8"));
    const filename = fs.realpathSync(options.get("--database")!);
    if (!environment.DATABASE_PATH || fs.realpathSync(environment.DATABASE_PATH) !== filename) throw new Error("environment_database_mismatch");
    database = new Database(filename, { fileMustExist: true });
    database.pragma("busy_timeout = 30000");
    previous = new Set(((await database.prepare("SELECT id FROM mail_read_requests").all()) as { id: string }[]).map((row) => row.id));
    const reader = new D1MailReader(database, {
      accountId: environment.V2_CF_ACCOUNT_ID || environment.CF_ACCOUNT_ID || "",
      databaseId: environment.V2_CF_D1_DATABASE_ID || environment.CF_D1_DATABASE_ID || "",
      readToken: environment.V2_CF_D1_READ_TOKEN || environment.CF_D1_API_TOKEN || "",
      timeIndex: environment.V2_CF_D1_TIME_INDEX || "",
      transport,
    });
    verified = (await reader.verifyTimeIndex()).verified;
  } catch (caught) {
    error = caught instanceof MailReadError ? caught.code : "index_verification_failed";
  } finally {
    if (database) {
      try {
        for (const row of (await database.prepare("SELECT id, rows_read FROM mail_read_requests").all()) as { id: string; rows_read: number }[]) {
          if (!previous.has(row.id)) { requests += 1; rowsRead += row.rows_read; }
        }
      } catch { verified = false; error = "index_verification_failed"; }
      (await database.close());
    }
  }
  return { verified, requests, rowsRead, ...(error ? { error } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await verifyD1Index();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.verified) process.exitCode = 2;
}
