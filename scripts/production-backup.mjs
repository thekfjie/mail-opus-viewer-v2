import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const DEFAULT_UNITS = ["mail-opus-viewer.service", "mail-opus-viewer-v2.service", "mail-opus-viewer-v2-worker.service"];
const MAIL_FIELDS = new Set(["id", "detailId", "from", "source", "to", "address", "subject", "created_at", "created_at_utc",
  "folder", "category", "isSecurity", "isDeactivation", "isPlus", "envelopeRecipients"]);
const INDEX_FIELDS = new Set(["configKey", "updatedAt", "newestId", "oldestId", "newestMailAt", "oldestMailAt", "coverageComplete", "backfillVersion", "fullScan"]);
const FLAG_FIELDS = new Set(["configKey", "updatedAt", "hasDeactivation", "hasPlus", "plusEvidenceSource", "plusStateSource", "plusEvidenceVersion", "plusStateVersion", "billingChannel"]);
const USAGE_FIELDS = new Set(["configKey", "billingAt", "lastActivityAt", "newestMailAt", "deactivatedAt", "suspectedUnused", "checkedAt"]);
const CONTENT_KEY = /^(?:raw|rawMime|raw_mime|raw_blob|mime|body|bodyText|bodyHtml|body_text|body_html|text|html|parsedText|parsedHtml|attachments?|body_preview|preview)$/i;

function fail(code) { throw new Error(code); }
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function plain(value) { return value && typeof value === "object" && !Array.isArray(value); }

function stableRead(filename) {
  const before = fs.statSync(filename);
  if (!before.isFile()) fail("SOURCE_NOT_REGULAR_FILE");
  const bytes = fs.readFileSync(filename);
  const after = fs.statSync(filename);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("SOURCE_CHANGED_DURING_BACKUP");
  return { bytes, mtime: before.mtime, sourceHash: digest(bytes) };
}

function pick(value, fields) {
  return Object.fromEntries(Object.entries(plain(value) ? value : {}).filter(([key, item]) => fields.has(key)
    && (item === null || ["string", "number", "boolean"].includes(typeof item)
      || (key === "envelopeRecipients" && Array.isArray(item) && item.every((entry) => typeof entry === "string")))));
}

function filterEvidence(payload, kind) {
  if (!plain(payload) || !plain(payload.entries)) fail("INVALID_EVIDENCE_SNAPSHOT");
  const entries = Object.fromEntries(Object.entries(payload.entries).map(([id, value]) => {
    if (!plain(value)) fail("INVALID_EVIDENCE_ENTRY");
    if (kind !== "index") return [id, pick(value, kind === "flags" ? FLAG_FIELDS : USAGE_FIELDS)];
    const entry = pick(value, INDEX_FIELDS);
    entry.mails = (Array.isArray(value.mails) ? value.mails : []).map((mail) => pick(mail, MAIL_FIELDS));
    return [id, entry];
  }));
  return { version: Number.isSafeInteger(payload.version) ? payload.version : 1, entries };
}

function withoutMailContent(value) {
  if (Array.isArray(value)) return value.map(withoutMailContent);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !CONTENT_KEY.test(key)).map(([key, child]) => [key, withoutMailContent(child)]));
}

function accessBackupFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...accessBackupFiles(filename));
    else if (entry.isFile() && (/access-config.*\.json$/i.test(entry.name) || /^access-config\.bak/i.test(entry.name))) output.push(filename);
  }
  return output.sort();
}

function checkDatabase(filename) {
  const database = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only=ON");
    const integrity = database.pragma("integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") fail("SQLITE_INTEGRITY_FAILED");
    if (database.pragma("foreign_key_check").length) fail("SQLITE_FOREIGN_KEYS_FAILED");
    return database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length;
  } finally { database.close(); }
}

function argumentsFrom(argv) {
  const options = {};
  const repeated = new Set(["nginx-file", "env-file"]);
  const allowed = new Set(["destination", "database", "v1-root", "systemd-root", "nginx-file", "env-file"]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!argv[index]?.startsWith("--") || !allowed.has(key) || !value || value.startsWith("--")) fail("INVALID_ARGUMENT");
    if (repeated.has(key)) (options[key] ||= []).push(value);
    else if (options[key]) fail("DUPLICATE_ARGUMENT");
    else options[key] = value;
  }
  return options;
}

export async function productionBackup(options) {
  const destination = options.destination;
  if (!destination || !path.isAbsolute(destination) || path.resolve(destination) === "/") fail("ABSOLUTE_DESTINATION_REQUIRED");
  if (fs.existsSync(destination)) fail("DESTINATION_ALREADY_EXISTS");
  const databasePath = options.database || "/var/lib/mail-opus-v2/mail-opus-v2.sqlite";
  const v1Root = options["v1-root"] || "/opt/mail-opus-viewer";
  const systemdRoot = options["systemd-root"] || "/etc/systemd/system";
  const nginxFiles = options["nginx-file"] || ["/etc/nginx/sites-available/mail.opus.sryze.cc", "/etc/nginx/conf.d/00-cloud-opus-disabled.conf"];
  const envFiles = options["env-file"] || [path.join(v1Root, ".env"), "/opt/mail-opus-viewer-v2/.env", "/etc/opus-mail-v2/runtime.env"];
  for (const input of [databasePath, v1Root, systemdRoot, ...nginxFiles, ...envFiles]) {
    if (!path.isAbsolute(input)) fail("ABSOLUTE_SOURCE_REQUIRED");
    if (path.resolve(input) === path.resolve(destination) || path.resolve(input).startsWith(`${path.resolve(destination)}/`)) fail("DESTINATION_CONTAINS_SOURCE");
  }
  // The caller creates the approved parent directory; no implicit production directories.
  const parent = fs.realpathSync(path.dirname(destination));
  if (!fs.statSync(parent).isDirectory()) fail("DESTINATION_PARENT_REQUIRED");
  const previousUmask = process.umask(0o077);
  const startedAt = new Date().toISOString();
  const files = [];
  const omittedOptionalFiles = [];
  let completed = false;
  let created = false;
  const addFile = (relative, bytes, information = {}) => {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    fs.chmodSync(target, 0o600);
    if (information.mtime) fs.utimesSync(target, information.mtime, information.mtime);
    const handle = fs.openSync(target, "r");
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes), ...information, mtime: undefined });
  };
  const jsonSnapshot = (source, relative, transform) => {
    const snapshot = stableRead(source);
    const payload = transform(JSON.parse(snapshot.bytes.toString("utf8")));
    addFile(relative, Buffer.from(`${JSON.stringify(payload)}\n`), { source, sourceSha256: snapshot.sourceHash, mtime: snapshot.mtime, sanitized: true });
    return payload;
  };
  try {
    fs.mkdirSync(destination, { mode: 0o700 });
    created = true;
    fs.chmodSync(destination, 0o700);
    const source = new Database(databasePath, { readonly: true, fileMustExist: true });
    const databaseRelative = "protected/v2/mail-opus-v2.sqlite";
    const databaseTarget = path.join(destination, databaseRelative);
    fs.mkdirSync(path.dirname(databaseTarget), { recursive: true, mode: 0o700 });
    try { source.pragma("query_only=ON"); await source.backup(databaseTarget); } finally { source.close(); }
    fs.chmodSync(databaseTarget, 0o600);
    const tableCount = checkDatabase(databaseTarget);
    const snapshot = stableRead(databaseTarget);
    files.push({ path: databaseRelative, bytes: snapshot.bytes.length, sha256: snapshot.sourceHash, source: databasePath, sqliteIntegrity: "ok", sqliteForeignKeys: 0, tableCount });

    const access = jsonSnapshot(path.join(v1Root, "access-config.json"), "protected/v1/access-config.json", (value) => {
      if (!Array.isArray(value) || value.some((entry) => !plain(entry))) fail("INVALID_ACCESS_SNAPSHOT");
      return withoutMailContent(value);
    });
    const index = jsonSnapshot(path.join(v1Root, "mail-index-cache.json"), "protected/v1/mail-index-cache.json", (value) => filterEvidence(value, "index"));
    jsonSnapshot(path.join(v1Root, "mail-flag-cache.json"), "protected/v1/mail-flag-cache.json", (value) => filterEvidence(value, "flags"));
    jsonSnapshot(path.join(v1Root, "usage-audit-cache.json"), "protected/v1/usage-audit-cache.json", (value) => filterEvidence(value, "usage"));
    const backupRoot = path.join(v1Root, "backups");
    const backups = accessBackupFiles(backupRoot);
    for (const sourceFile of backups) {
      jsonSnapshot(sourceFile, path.join("protected/v1/backups", path.relative(backupRoot, sourceFile)), (value) => {
        if (!Array.isArray(value) || value.some((entry) => !plain(entry))) fail("INVALID_ACCESS_BACKUP");
        return withoutMailContent(value);
      });
    }
    for (const unit of DEFAULT_UNITS) {
      const sourceFile = path.join(systemdRoot, unit);
      const snapshot = stableRead(sourceFile);
      addFile(`protected/systemd/${unit}`, snapshot.bytes, { source: sourceFile });
    }
    const dropinRoot = path.join(systemdRoot, "mail-opus-viewer.service.d");
    if (fs.existsSync(dropinRoot)) {
      for (const entry of fs.readdirSync(dropinRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".conf")) continue;
        const sourceFile = path.join(dropinRoot, entry.name);
        addFile(`protected/systemd/mail-opus-viewer.service.d/${entry.name}`, stableRead(sourceFile).bytes, { source: sourceFile });
      }
    }
    for (const [index, sourceFile] of nginxFiles.entries()) {
      addFile(`protected/nginx/${index}-${path.basename(sourceFile)}`, stableRead(sourceFile).bytes, { source: sourceFile });
    }
    for (const [index, sourceFile] of envFiles.entries()) {
      if (!fs.existsSync(sourceFile)) { omittedOptionalFiles.push(sourceFile); continue; }
      addFile(`protected/environment/${index}-${path.basename(path.dirname(sourceFile))}-${path.basename(sourceFile)}`, stableRead(sourceFile).bytes, { source: sourceFile });
    }
    const manifest = { version: 1, complete: true, startedAt, completedAt: new Date().toISOString(),
      sqliteIntegrity: "ok", sqliteForeignKeys: 0, accessRecords: access.length,
      indexedMails: Object.values(index.entries).reduce((sum, entry) => sum + entry.mails.length, 0),
      legacyBackupFiles: backups.length, omittedOptionalFiles, files };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    addFile("manifest.json", manifestBytes);
    const directoryHandle = fs.openSync(destination, "r");
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
    completed = true;
    return { ok: true, files: files.length, accessRecords: manifest.accessRecords, indexedMails: manifest.indexedMails,
      legacyBackupFiles: backups.length, omittedOptionalFiles: omittedOptionalFiles.length, manifestSha256: digest(manifestBytes) };
  } finally {
    process.umask(previousUmask);
    if (created && !completed && fs.existsSync(destination)) {
      fs.writeFileSync(path.join(destination, "INCOMPLETE"), "Backup incomplete. Do not migrate or restore from this directory.\n", { flag: "wx", mode: 0o600 });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await productionBackup(argumentsFrom(process.argv.slice(2))))}\n`); }
  catch (error) {
    const code = /^[A-Z][A-Z_]+$/.test(String(error?.message)) ? error.message : "PRODUCTION_BACKUP_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  }
}
