// Imported only by explicit snapshot migration commands, never by the server or worker.
export const legacyConfig = {
  envFile: "",
  configFile: process.env.V1_CONFIG_FILE || "",
  mailIndexFile: process.env.V1_MAIL_INDEX_FILE || "",
  mailFlagFile: process.env.V1_MAIL_FLAG_FILE || "",
  usageAuditFile: process.env.V1_USAGE_AUDIT_FILE || "",
  changeOutboxFile: process.env.V1_CHANGE_OUTBOX_FILE || "",
  backupsDir: process.env.V1_BACKUPS_DIR || "",
};
