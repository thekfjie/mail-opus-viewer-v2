import fs from "node:fs";
import Database from "better-sqlite3";
import { readEnv } from "./prepare-production-config.mjs";

// Explicit, bounded candidate integration check. No listing or counting upstream.
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (index % 2 === 0) pairs.push([value, args[index + 1]]);
  return pairs;
}, []));
let database;
try {
  if (Object.keys(options).length !== 3 || !options["--base"] || !options["--database"] || !options["--env"]) throw new Error("arguments");
  const base = new URL(options["--base"]);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.port !== "8791") throw new Error("candidate_only");
  const environment = readEnv(options["--env"]);
  if ((fs.statSync(options["--env"]).mode & 0o777) !== 0o600) throw new Error("environment_mode");
  database = new Database(options["--database"], { readonly: true, fileMustExist: true });
  database.pragma("query_only=ON");
  const row = database.prepare(`SELECT m.id,m.provider_message_id,m.sender,m.subject,c.account_id
    FROM mail_messages m JOIN mail_ownership_claims c ON c.message_id=m.id
    WHERE m.provider='shared-mail-api' AND m.category='deactivation'
      AND NOT EXISTS(SELECT 1 FROM mail_ownership_claims other WHERE other.message_id=m.id AND other.account_id<>c.account_id)
    ORDER BY m.received_at DESC LIMIT 1`).get();
  if (!row) throw new Error("no_known_mail");
  const counts = () => database.prepare("SELECT COUNT(*) calls,COALESCE(SUM(rows_read),0) rowsRead FROM mail_read_requests").get();
  const before = counts();
  let httpRequests = 0;
  const request = async (route, body, headers = {}) => {
    if (++httpRequests > 4) throw new Error("request_budget");
    const response = await fetch(new URL(route, base), {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(35000),
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("http_failed"); }
    const chunks = []; let size = 0;
    for await (const part of response.body) {
      size += part.length; if (size > 16 * 1024 * 1024) throw new Error("response_limit");
      chunks.push(part);
    }
    return { response, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  };
  const event = { id: row.provider_message_id, from: row.sender, to: "", subject: row.subject };
  const authorization = { authorization: `Bearer ${environment.V2_MAIL_WEBHOOK_SECRET}` };
  const result = await request("/api/v2/internal/mail-events", event, authorization);
  const first = counts();
  const duplicate = await request("/api/v2/internal/mail-events", event, authorization);
  const second = counts();
  const login = await request("/api/v2/admin/login", { password: environment.VIEWER_ADMIN_PASSWORD || environment.MAIL_ADMIN_AUTH });
  const cookie = login.response.headers.getSetCookie().map(value => value.split(";")[0]).find(value => value.startsWith("mail_opus_v2_admin="));
  if (!cookie) throw new Error("admin_cookie");
  const detail = await request(`/api/admin/mapping-mail-detail?mappingId=${encodeURIComponent(row.account_id)}&id=${encodeURIComponent(row.id)}`, undefined, { cookie });
  const after = counts();
  const mail = detail.value.mail;
  const content = [mail?.text, mail?.html].filter(value => typeof value === "string" && value.length > 128);
  const files = [options["--database"], options["--database"] + "-wal"].filter(file => fs.existsSync(file));
  const persisted = files.some(file => { const bytes = fs.readFileSync(file); return content.some(value => bytes.includes(Buffer.from(value))); });
  const account = database.prepare("SELECT deactivation_locked,deactivated_at FROM gpt_accounts WHERE id=?").get(row.account_id);
  const checks = {
    eventProcessed: result.value.processingStatus === "processed",
    duplicateProcessed: duplicate.value.processingStatus === "processed",
    eventReadsBounded: first.calls - before.calls <= 2,
    duplicateReadsZero: second.calls === first.calls,
    bodyReadById: after.calls - second.calls >= 1 && after.calls - second.calls <= 2,
    bodyAvailable: content.length > 0,
    bodyNotPersisted: !persisted,
    bodyNoStore: detail.response.headers.get("cache-control")?.includes("no-store") === true,
    banLockedWithKnownDate: account.deactivation_locked === 1 && Boolean(account.deactivated_at),
  };
  const ok = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ ok, checks, httpRequests, d1Calls: after.calls - before.calls, d1RowsRead: after.rowsRead - before.rowsRead }) + "\n");
  if (!ok) process.exitCode = 2;
} catch {
  process.stderr.write("Candidate mail verification failed; no response bodies or credentials recorded.\n");
  process.exitCode = 1;
} finally { database?.close(); }
