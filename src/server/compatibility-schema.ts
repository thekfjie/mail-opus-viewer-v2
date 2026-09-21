import type { Database } from "better-sqlite3";

export function applyCompatibilitySchema(database: Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS pending_mailboxes (
    id TEXT PRIMARY KEY,email_hash TEXT NOT NULL UNIQUE,email_enc TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('signup','rebind')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_mail_claims (
    pending_id TEXT NOT NULL REFERENCES pending_mailboxes(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY(pending_id,message_id)
  )`);
}
