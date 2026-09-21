import fs from "node:fs";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

export function readEnv(filename) {
  const result = {};
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

if (process.argv[1]?.endsWith("prepare-production-config.mjs")) {
  const target = "/etc/opus-mail-v2/runtime.env";
  let quiet = false;
  try {
    if (fs.existsSync(target)) throw new Error("CONFIG_ALREADY_EXISTS");
    const old = readEnv("/opt/mail-opus-viewer-v2/.env");
    const legacy = readEnv("/opt/mail-opus-viewer/.env");
    const automyai = JSON.parse(fs.readFileSync("/opt/automyai/data/runtime-config/config.json", "utf8"));
    const outlook = readEnv("/opt/outlookEmail/.env");
    const session = old.V2_SESSION_SECRET || old.SESSION_SECRET;
    if (!session || !old.IMPORT_API_KEY || !old.MAIL_ADMIN_AUTH) throw new Error("MISSING_EXISTING_KEYS");
    if (old.IMPORT_API_KEY !== legacy.IMPORT_API_KEY || old.MAIL_ADMIN_AUTH !== legacy.MAIL_ADMIN_AUTH) throw new Error("LEGACY_AUTH_KEYS_DIFFER");
    if (process.stdin.isTTY) { execFileSync("stty", ["-echo"], { stdio: "inherit" }); quiet = true; }
    process.stdout.write("Awaiting protected D1 credential JSON on stdin (terminal echo disabled).\n");
    const input = readline.createInterface({ input: process.stdin });
    const line = await new Promise(resolve => input.once("line", resolve));
    input.close();
    process.stdin.pause();
    const credentials = JSON.parse(line);
    if (!/^[a-f0-9]{32}$/.test(credentials.accountId) || !/^[a-f0-9-]{36}$/.test(credentials.databaseId) || !credentials.token) throw new Error("INVALID_CREDENTIAL_INPUT");
    const env = {
      ...old,
      PORT: "8790", DATABASE_PATH: "/var/lib/mail-opus-v2/mail-opus-v2.sqlite",
      V2_SESSION_SECRET: session,
      CREDENTIAL_ENCRYPTION_KEY: old.CREDENTIAL_ENCRYPTION_KEY || `${session}:mail-opus-v2-credentials`,
      V2_READ_ONLY: "false", V2_ACCOUNT_AUTHORITY: "v2", V2_SHARED_MAIL_SYNC_ENABLED: "false",
      V2_SHARED_MAIL_MAX_PAGES: "1", V2_BACKUP_DIRECTORY: "/var/backups/mail-opus-v2/daily",
      PUBLIC_ORIGIN: "https://mail.opus.sryze.cc",
      V2_CF_ACCOUNT_ID: credentials.accountId, V2_CF_D1_DATABASE_ID: credentials.databaseId,
      V2_CF_D1_READ_TOKEN: credentials.token, V2_CF_D1_TIME_INDEX: "",
      V2_MAIL_WEBHOOK_SECRET: crypto.randomBytes(48).toString("base64url"),
      V2_OAUTH_HEALTH_PROXY: legacy.OAUTH_HEALTH_PROXY || "",
      V2_OAUTH_PROBE_PYTHON: "/opt/opus-mail-v2-python/bin/python",
      PROMOTION_PYTHON: "/opt/opus-mail-v2-python/bin/python",
      OUTLOOK_MANAGER_PASSWORD: outlook.LOGIN_PASSWORD || "",
    };
    for (const key of ["SUB2API_API_URL", "SUB2API_ADMIN_EMAIL", "SUB2API_ADMIN_PASSWORD", "SUB2API_ADMIN_TOKEN"]) env[key] = String(old[key] || automyai[key] || "");
    for (const key of Object.keys(env)) {
      if (/^(V1_|CF_|AUTOMYAI_CONFIG_PATH|OUTLOOK_MANAGER_ENV_FILE|SESSION_SECRET)/.test(key)) delete env[key];
      else if (/[\r\n]/.test(env[key])) throw new Error("MULTILINE_ENV_NOT_SUPPORTED");
    }
    fs.writeFileSync(target, Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "wx", mode: 0o600 });
    fs.chmodSync(target, 0o600);
    process.stdout.write(JSON.stringify({ ok: true, configuration: target, mode: "0600", encryptionKeyPreserved: true, legacyAuthCompatible: true, sharedPolling: false }) + "\n");
  } catch (error) {
    const safe = ["CONFIG_ALREADY_EXISTS", "MISSING_EXISTING_KEYS", "LEGACY_AUTH_KEYS_DIFFER", "INVALID_CREDENTIAL_INPUT", "MULTILINE_ENV_NOT_SUPPORTED"];
    process.stderr.write((safe.includes(error.message) ? error.message : "PROTECTED_CONFIG_PREPARATION_FAILED") + "\n");
    process.exitCode = 1;
  } finally {
    if (quiet) execFileSync("stty", ["echo"], { stdio: "inherit" });
  }
}
