import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { applyMailIngestionSchema, D1MailReader, MailReadError } from "../src/server/cf-mail.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--budget-db") throw new Error("Explicit validation budget database required");
const filename = path.resolve(args[1]);
fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
const database = new Database(filename);
fs.chmodSync(filename, 0o600);
database.pragma("busy_timeout = 30000");
applyMailIngestionSchema(database);
if (process.stdin.isTTY && spawnSync("stty", ["-echo"], { stdio: "inherit" }).status !== 0) {
  database.close();
  throw new Error("Cannot disable credential input echo");
}
const input = readline.createInterface({ input: process.stdin, terminal: false });
try {
  // Credentials are supplied on a non-echoing pipe, never argv or a file.
  const line = await new Promise<string>((resolve, reject) => {
    input.once("line", resolve);
    input.once("close", () => reject(new Error("missing_credentials")));
  });
  input.close();
  const credentials = JSON.parse(line);
  if (typeof credentials.token !== "string" || !credentials.token || typeof credentials.accountId !== "string"
    || typeof credentials.databaseId !== "string") throw new Error("invalid_credentials_input");
  const verification = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(15_000),
  });
  const payload = await verification.json() as any;
  const tokenActive = verification.ok && payload.success === true && payload.result?.status === "active";
  process.stdout.write(`${JSON.stringify({ tokenVerification: { status: verification.status, active: tokenActive } })}\n`);
  if (!tokenActive) process.exitCode = 2;
  else {
    const reader = new D1MailReader(database, { accountId: credentials.accountId, databaseId: credentials.databaseId, readToken: credentials.token });
    const row = await reader.byId("9007199254740991");
    const requests = database.prepare("SELECT outcome, rows_read FROM mail_read_requests ORDER BY started_at").all();
    process.stdout.write(`${JSON.stringify({ d1ReadContract: "ok", returnedRows: row ? 1 : 0, requests })}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof MailReadError ? error.code : "validation_failed",
    requests: database.prepare("SELECT outcome, rows_read FROM mail_read_requests ORDER BY started_at").all() })}\n`);
  process.exitCode = 2;
} finally {
  input.close();
  database.close();
  if (process.stdin.isTTY) spawnSync("stty", ["echo"], { stdio: "inherit" });
  process.stdin.pause();
}
