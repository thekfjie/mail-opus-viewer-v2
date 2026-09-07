import fs from "node:fs";

function readEnvObject(filePath: string): Record<string, string> {
  const output: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith("#")) continue;
      const index = value.indexOf("=");
      if (index < 1) continue;
      const key = value.slice(0, index).trim();
      let entry = value.slice(index + 1).trim();
      if ((entry.startsWith('"') && entry.endsWith('"')) || (entry.startsWith("'") && entry.endsWith("'"))) entry = entry.slice(1, -1);
      output[key] = entry;
    }
  } catch {
    // The explicit legacy migration command reports missing source files.
  }
  return output;
}

const envFile = process.env.V1_ENV_FILE || "/opt/mail-opus-viewer/.env";
const legacyEnv = readEnvObject(envFile);

export const legacyConfig = {
  envFile,
  configFile: process.env.V1_CONFIG_FILE || "/opt/mail-opus-viewer/access-config.json",
  mailIndexFile: process.env.V1_MAIL_INDEX_FILE || "/opt/mail-opus-viewer/mail-index-cache.json",
  changeOutboxFile: process.env.V1_CHANGE_OUTBOX_FILE || "/var/lib/mail-opus-v2/v1-change-outbox.jsonl",
  backupsDir: process.env.V1_BACKUPS_DIR || "/opt/mail-opus-viewer/backups",
  baseUrl: String(process.env.V1_BASE_URL || `http://127.0.0.1:${legacyEnv.PORT || "8789"}`).replace(/\/+$/, ""),
};
