import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });

const backupDirectory = process.env.V2_BACKUP_DIRECTORY || path.join(config.projectRoot, ".state", "backups");
const retention = Math.max(7, Math.min(180, Number(process.env.V2_BACKUP_RETENTION || 45)));
fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
for (const name of fs.readdirSync(backupDirectory).filter((entry) => /\.sqlite\.tmp(?:-wal|-shm)?$/.test(entry))) {
  try { fs.unlinkSync(path.join(backupDirectory, name)); } catch {}
}

const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const destination = path.join(backupDirectory, `mail-opus-v2.${timestamp}.sqlite`);
const temporary = `${destination}.tmp`;

try {
  const sourceIntegrity = String((db.prepare("PRAGMA integrity_check").get() as any)?.integrity_check || "unknown");
  if (sourceIntegrity !== "ok") throw new Error(`源数据库完整性检查失败: ${sourceIntegrity}`);
  await db.backup(temporary);
  fs.chmodSync(temporary, 0o600);
  const verification = new Database(temporary, { readonly: true, fileMustExist: true });
  const backupIntegrity = String((verification.prepare("PRAGMA integrity_check").get() as any)?.integrity_check || "unknown");
  const foreignKeyViolations = (verification.prepare("PRAGMA foreign_key_check").all() as any[]).length;
  verification.close();
  if (backupIntegrity !== "ok" || foreignKeyViolations) throw new Error(`备份校验失败: integrity=${backupIntegrity}, foreignKeys=${foreignKeyViolations}`);
  fs.renameSync(temporary, destination);

  const backups = fs.readdirSync(backupDirectory)
    .filter((name) => /^mail-opus-v2\.\d{8}T\d{6}Z\.sqlite$/.test(name))
    .sort()
    .reverse();
  for (const expired of backups.slice(retention)) fs.unlinkSync(path.join(backupDirectory, expired));
  process.stdout.write(JSON.stringify({ ok: true, backup: path.basename(destination), retained: Math.min(backups.length, retention) }) + "\n");
} finally {
  for (const artifact of [temporary, `${temporary}-wal`, `${temporary}-shm`]) {
    try { if (fs.existsSync(artifact)) fs.unlinkSync(artifact); } catch {}
  }
  db.close();
}
