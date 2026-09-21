import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readEnv } from "./prepare-production-config.mjs";

const SETTINGS_PATH = "/admin/mail_webhook/settings";
const DEFAULT_RECEIVER_URL = "https://mailhook.kfjie.me/api/v2/internal/mail-events";
const ENVIRONMENT_FILE = "/etc/opus-mail-v2/runtime.env";

class WebhookError extends Error {
  constructor(code, httpStatus = 0) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
function fail(code) { throw new WebhookError(code); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function fingerprint(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function protectedFile(filename) {
  if (!path.isAbsolute(filename)) fail("PROTECTED_ABSOLUTE_PATH_REQUIRED");
  const information = fs.lstatSync(filename);
  if (!information.isFile() || information.isSymbolicLink() || (information.mode & 0o777) !== 0o600) fail("PROTECTED_FILE_MODE_REQUIRED");
}
function protectedDirectory(directory) {
  if (!directory || !path.isAbsolute(directory)) fail("PROTECTED_BACKUP_DIRECTORY_REQUIRED");
  const information = fs.lstatSync(directory);
  if (!information.isDirectory() || information.isSymbolicLink() || (information.mode & 0o777) !== 0o700) fail("PROTECTED_DIRECTORY_MODE_REQUIRED");
}

async function responseText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1024 * 1024) { await reader.cancel(); fail("WEBHOOK_SETTINGS_RESPONSE_TOO_LARGE"); }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}

function httpCode(status, text) {
  if (status === 403 && /webhook.*(?:disabled|not enabled)|ENABLE_WEBHOOK|KV.*(?:not|missing)/i.test(text)) return "WEBHOOK_DISABLED_OR_KV_MISSING";
  if (status === 401 || status === 403) return "WEBHOOK_SETTINGS_FORBIDDEN";
  if (status === 429) return "WEBHOOK_SETTINGS_RATE_LIMITED";
  if (status >= 500) return "WEBHOOK_SETTINGS_UPSTREAM_FAILED";
  return "WEBHOOK_SETTINGS_HTTP_FAILED";
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--inspect", "--apply", "--rollback"].includes(argument)) {
      if (result.action) fail("EXACTLY_ONE_ACTION_REQUIRED");
      result.action = argument.slice(2);
      if (argument === "--rollback") result.rollbackFile = argv[++index];
    } else if (argument === "--backup-directory" && !result.backupDirectory) result.backupDirectory = argv[++index];
    else fail("INVALID_ARGUMENT");
  }
  if (!result.action) fail("EXACTLY_ONE_ACTION_REQUIRED");
  if (result.action === "rollback" && !result.rollbackFile) fail("ROLLBACK_FILE_REQUIRED");
  return result;
}

export async function manageWebhook(options, dependencies = {}) {
  const environmentFile = dependencies.environmentFile || ENVIRONMENT_FILE;
  protectedFile(environmentFile);
  const env = readEnv(environmentFile);
  let origin;
  try {
    const base = new URL(env.MAIL_API_BASE);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !["", "/"].includes(base.pathname)) fail("INVALID_UPSTREAM_BASE");
    origin = base.origin;
  } catch { fail("INVALID_UPSTREAM_BASE"); }
  let receiverUrl;
  try {
    const receiver = new URL(env.V2_MAIL_WEBHOOK_URL || DEFAULT_RECEIVER_URL);
    if (receiver.protocol !== "https:" || receiver.username || receiver.password || receiver.search || receiver.hash) fail("INVALID_WEBHOOK_RECEIVER_URL");
    receiverUrl = receiver.href;
  } catch { fail("INVALID_WEBHOOK_RECEIVER_URL"); }
  if (!env.MAIL_ADMIN_AUTH || !env.V2_MAIL_WEBHOOK_SECRET || /[\r\n]/.test(env.MAIL_ADMIN_AUTH + env.V2_MAIL_WEBHOOK_SECRET)) fail("WEBHOOK_CREDENTIALS_MISSING");
  const transport = dependencies.transport || globalThis.fetch;
  let requests = 0;
  const request = async (method, body) => {
    if (++requests > 3) fail("WEBHOOK_REQUEST_BUDGET_EXCEEDED");
    let response;
    try {
      response = await transport(`${origin}${SETTINGS_PATH}`, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "x-admin-auth": env.MAIL_ADMIN_AUTH, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { fail("WEBHOOK_SETTINGS_TRANSPORT_FAILED"); }
    const text = await responseText(response);
    if (!response.ok) throw new WebhookError(httpCode(response.status, text), response.status);
    let payload;
    try { payload = JSON.parse(text); } catch { fail("WEBHOOK_SETTINGS_INVALID_JSON"); }
    if (!object(payload)) fail("WEBHOOK_SETTINGS_INVALID_RESPONSE");
    if (method === "POST" && payload.success !== true) fail("WEBHOOK_SETTINGS_WRITE_REJECTED");
    return { payload, status: response.status };
  };
  if (options.action === "inspect") {
    try {
      const { payload, status } = await request("GET");
      return { ok: true, enabled: payload.enabled === true, httpStatus: status, classification: "WEBHOOK_SETTINGS_AVAILABLE" };
    } catch (error) {
      if (!(error instanceof WebhookError)) throw error;
      return { ok: false, enabled: null, httpStatus: error.httpStatus, classification: error.code };
    }
  }
  let desired;
  let backupFile = "";
  if (options.action === "apply") {
    protectedDirectory(options.backupDirectory);
    const { payload: original } = await request("GET");
    backupFile = `webhook-settings-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}.json`;
    const backupPath = path.join(options.backupDirectory, backupFile);
    const backup = { version: 1, upstreamOrigin: origin, createdAt: new Date().toISOString(), settingsSha256: fingerprint(original), settings: original };
    fs.writeFileSync(backupPath, `${JSON.stringify(backup)}\n`, { flag: "wx", mode: 0o600 });
    fs.chmodSync(backupPath, 0o600);
    const fileHandle = fs.openSync(backupPath, "r");
    try { fs.fsyncSync(fileHandle); } finally { fs.closeSync(fileHandle); }
    const directoryHandle = fs.openSync(options.backupDirectory, "r");
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
    desired = {
      ...original,
      enabled: true, url: receiverUrl, method: "POST",
      headers: JSON.stringify({ "content-type": "application/json", authorization: `Bearer ${env.V2_MAIL_WEBHOOK_SECRET}` }),
      body: JSON.stringify({ id: "${id}", from: "${from}", to: "${to}", subject: "${subject}" }),
    };
  } else if (options.action === "rollback") {
    protectedFile(options.rollbackFile);
    protectedDirectory(path.dirname(options.rollbackFile));
    const backup = JSON.parse(fs.readFileSync(options.rollbackFile, "utf8"));
    if (backup.version !== 1 || backup.upstreamOrigin !== origin || !object(backup.settings)
      || backup.settingsSha256 !== fingerprint(backup.settings)) fail("INVALID_WEBHOOK_BACKUP");
    desired = backup.settings;
  } else fail("EXACTLY_ONE_ACTION_REQUIRED");
  await request("POST", desired);
  const { payload: confirmed } = await request("GET");
  if (fingerprint(confirmed) !== fingerprint(desired)) fail("WEBHOOK_SETTINGS_VERIFICATION_FAILED");
  return { ok: true, action: options.action, verified: true, requests, ...(backupFile ? { backupFile } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await manageWebhook(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error instanceof WebhookError ? error.code : "WEBHOOK_OPERATION_FAILED" })}\n`);
    process.exitCode = 1;
  }
}
