import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { SqliteTestDatabase } from "./sqlite-test.js";
import { config } from "../config.js";
import { decryptSecret } from "../crypto.js";
import { runMigrations } from "../migrations.js";

export async function openLegacySqlite() {
fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
const raw = new Database(config.databasePath);
const db = new SqliteTestDatabase(raw);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// A full V1 projection can hold the single SQLite writer for several seconds.
// Let API and Worker processes serialize instead of surfacing a transient lock.
db.pragma(`busy_timeout = ${config.sqliteBusyTimeoutMs}`);

(await db.exec(`
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_import_records (
  source_key TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_updated_at TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gpt_accounts (
  id TEXT PRIMARY KEY,
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  deactivation_locked INTEGER NOT NULL DEFAULT 0,
  deactivated_at TEXT NOT NULL DEFAULT '',
  admin_deactivated_at TEXT NOT NULL DEFAULT '',
  retired_at TEXT NOT NULL DEFAULT '',
  quarantined_at TEXT NOT NULL DEFAULT '',
  quarantine_reason TEXT NOT NULL DEFAULT '',
  identity_status TEXT NOT NULL DEFAULT 'unknown',
  sold INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'unknown',
  billing_channel TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  payment_link TEXT NOT NULL DEFAULT '',
  hide_promotion INTEGER NOT NULL DEFAULT 0,
  domain_mailbox INTEGER NOT NULL DEFAULT 0,
  suspected_unused INTEGER NOT NULL DEFAULT 0,
  mark_color TEXT NOT NULL DEFAULT '',
  group_boundary INTEGER NOT NULL DEFAULT 0,
  source_status TEXT NOT NULL DEFAULT 'current',
  openai_mfa_enabled INTEGER NOT NULL DEFAULT 0,
  openai_auth_methods_json TEXT NOT NULL DEFAULT '[]',
  arrived_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS mailbox_families (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  canonical_address_enc TEXT NOT NULL DEFAULT '',
  canonical_address_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES gpt_accounts(id),
  mailbox_family_id TEXT REFERENCES mailbox_families(id),
  email_enc TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  local_part TEXT NOT NULL,
  domain TEXT NOT NULL,
  provider TEXT NOT NULL,
  valid_from TEXT NOT NULL DEFAULT '',
  valid_to TEXT NOT NULL DEFAULT '',
  is_current INTEGER NOT NULL DEFAULT 1,
  association_method TEXT NOT NULL DEFAULT 'legacy_mapping',
  association_version INTEGER NOT NULL DEFAULT 1,
  legacy_mapping_id TEXT NOT NULL UNIQUE,
  source_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_relations (
  id TEXT PRIMARY KEY,
  relation_type TEXT NOT NULL,
  from_account_id TEXT NOT NULL REFERENCES gpt_accounts(id),
  to_account_id TEXT NOT NULL REFERENCES gpt_accounts(id),
  changed_at TEXT NOT NULL DEFAULT '',
  association_method TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES gpt_accounts(id),
  binding_id TEXT NOT NULL REFERENCES email_bindings(id),
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL DEFAULT '',
  end_reason TEXT NOT NULL DEFAULT '',
  first_used_at TEXT NOT NULL DEFAULT '',
  last_used_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_endpoints (
  email_hash TEXT PRIMARY KEY,
  email_enc TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES gpt_accounts(id),
  binding_id TEXT NOT NULL REFERENCES email_bindings(id),
  sale_id TEXT REFERENCES sales(id),
  public_token_hash TEXT NOT NULL UNIQUE,
  public_token_enc TEXT NOT NULL DEFAULT '',
  legacy_public_token INTEGER NOT NULL DEFAULT 0,
  login_identifier_hash TEXT NOT NULL,
  login_identifier_enc TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_plain_enc TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,
  visible_from TEXT NOT NULL DEFAULT '',
  visible_to TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  first_used_at TEXT NOT NULL DEFAULT '',
  last_used_at TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',
  revoke_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  account_id TEXT PRIMARY KEY REFERENCES gpt_accounts(id),
  access_token_enc TEXT NOT NULL DEFAULT '',
  refresh_token_enc TEXT NOT NULL DEFAULT '',
  id_token_enc TEXT NOT NULL DEFAULT '',
  session_token_enc TEXT NOT NULL DEFAULT '',
  openai_password_enc TEXT NOT NULL DEFAULT '',
  openai_subject_hash TEXT NOT NULL DEFAULT '',
  access_token_alive INTEGER NOT NULL DEFAULT 0,
  refresh_token_alive INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  source_updated_at TEXT NOT NULL DEFAULT '',
  access_token_fingerprint TEXT NOT NULL DEFAULT '',
  access_token_first_seen_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS openai_identity_observations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES gpt_accounts(id),
  subject_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(account_id, subject_hash)
);

CREATE TABLE IF NOT EXISTS payment_exposure_checks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES gpt_accounts(id),
  target TEXT NOT NULL,
  ip_country TEXT NOT NULL,
  billing_country TEXT NOT NULL,
  billing_currency TEXT NOT NULL,
  expected_method TEXT NOT NULL,
  available_methods_json TEXT NOT NULL DEFAULT '[]',
  matched_methods_json TEXT NOT NULL DEFAULT '[]',
  payment_methods_json TEXT NOT NULL DEFAULT '[]',
  trial_status TEXT NOT NULL DEFAULT 'unknown',
  exposed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown',
  checkout_type TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  promo_eligible INTEGER NOT NULL DEFAULT -1,
  promo_campaign TEXT NOT NULL DEFAULT '',
  promo_mode TEXT NOT NULL DEFAULT 'unknown',
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'automyai',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, target, ip_country, billing_country, billing_currency)
);

CREATE TABLE IF NOT EXISTS payment_exposure_jobs (
  job_id TEXT PRIMARY KEY,
  remote_job_id TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL REFERENCES gpt_accounts(id),
  route_key TEXT NOT NULL,
  target TEXT NOT NULL,
  ip_country TEXT NOT NULL,
  billing_country TEXT NOT NULL,
  billing_currency TEXT NOT NULL,
  job_kind TEXT NOT NULL DEFAULT 'manual',
  access_token_fingerprint TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT NOT NULL DEFAULT '',
  promo_mode TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'queued',
  last_error TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_messages (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  recipient_enc TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT 'inbox',
  category TEXT NOT NULL DEFAULT 'unknown',
  is_security INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  indexed_at TEXT NOT NULL,
  UNIQUE(provider, provider_message_id)
);

CREATE TABLE IF NOT EXISTS mail_ownership_claims (
  message_id TEXT NOT NULL REFERENCES mail_messages(id),
  account_id TEXT NOT NULL REFERENCES gpt_accounts(id),
  binding_id TEXT NOT NULL REFERENCES email_bindings(id),
  claim_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  visible_to_customer INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY(message_id, binding_id)
);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES gpt_accounts(id),
  binding_id TEXT REFERENCES email_bindings(id),
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow_sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '',
  source_count INTEGER NOT NULL DEFAULT 0,
  account_count INTEGER NOT NULL DEFAULT 0,
  binding_count INTEGER NOT NULL DEFAULT 0,
  relation_count INTEGER NOT NULL DEFAULT 0,
  recovered_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sub2api_sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  total_count INTEGER NOT NULL DEFAULT 0,
  active_openai_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  rebind_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS pending_reviews (
  id TEXT PRIMARY KEY,
  review_type TEXT NOT NULL,
  account_id TEXT REFERENCES gpt_accounts(id),
  candidate_email_enc TEXT NOT NULL DEFAULT '',
  candidate_email_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(review_type, account_id, candidate_email_hash)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_arrived ON gpt_accounts(arrived_at DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON gpt_accounts(lifecycle_status, deactivation_locked, sold);
CREATE INDEX IF NOT EXISTS idx_accounts_deactivated_at ON gpt_accounts(deactivation_locked, deactivated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bindings_account ON email_bindings(account_id, valid_from);
CREATE INDEX IF NOT EXISTS idx_bindings_local ON email_bindings(local_part, domain);
CREATE INDEX IF NOT EXISTS idx_grants_login ON access_grants(login_identifier_hash, active);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status, started_at);
CREATE INDEX IF NOT EXISTS idx_identity_subject ON openai_identity_observations(subject_hash, status);
CREATE INDEX IF NOT EXISTS idx_payment_exposure_account ON payment_exposure_checks(account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_exposure_target ON payment_exposure_checks(target, ip_country, status);
CREATE INDEX IF NOT EXISTS idx_payment_exposure_jobs_account ON payment_exposure_jobs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_exposure_jobs_status ON payment_exposure_jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_claims_account ON mail_ownership_claims(account_id, binding_id);
CREATE INDEX IF NOT EXISTS idx_messages_received ON mail_messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_account ON lifecycle_events(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON pending_reviews(status, created_at DESC);
`));

async function ensureColumn(table: string, column: string, declaration: string): Promise<void> {
  const columns = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) (await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`));
}

(await ensureColumn("sub2api_sync_runs", "skipped_count", "INTEGER NOT NULL DEFAULT 0"));
(await ensureColumn("gpt_accounts", "retired_at", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("gpt_accounts", "quarantined_at", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("gpt_accounts", "quarantine_reason", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("gpt_accounts", "identity_status", "TEXT NOT NULL DEFAULT 'unknown'"));
(await ensureColumn("access_grants", "public_token_enc", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("access_grants", "sale_id", "TEXT REFERENCES sales(id)"));
(await ensureColumn("access_grants", "first_used_at", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("access_grants", "last_used_at", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("access_grants", "revoked_at", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("access_grants", "revoke_reason", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("payment_exposure_checks", "payment_methods_json", "TEXT NOT NULL DEFAULT '[]'"));
(await ensureColumn("payment_exposure_checks", "trial_status", "TEXT NOT NULL DEFAULT 'unknown'"));
(await ensureColumn("payment_exposure_checks", "promo_mode", "TEXT NOT NULL DEFAULT 'unknown'"));
(await ensureColumn("credentials", "access_token_fingerprint", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("credentials", "access_token_first_seen_at", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("payment_exposure_jobs", "job_kind", "TEXT NOT NULL DEFAULT 'manual'"));
(await ensureColumn("payment_exposure_jobs", "access_token_fingerprint", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("payment_exposure_jobs", "scheduled_at", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("payment_exposure_jobs", "remote_job_id", "TEXT NOT NULL DEFAULT ''"));
(await ensureColumn("payment_exposure_jobs", "promo_mode", "TEXT NOT NULL DEFAULT 'none'"));

(await db.exec("CREATE INDEX IF NOT EXISTS idx_grants_sale ON access_grants(sale_id, active)"));
(await db.exec("CREATE INDEX IF NOT EXISTS idx_payment_exposure_jobs_dedupe ON payment_exposure_jobs(account_id, job_kind, access_token_fingerprint, status)"));

// Existing credential rows predate automatic trial scheduling. Give each
// existing AT a stable fingerprint and a one-time baseline so deployment does
// not enqueue the whole historical pool at once. New/changed ATs are stamped
// by the import and Sub2API paths with their actual discovery time.
const credentialBaselineAt = new Date().toISOString();
for (const row of (await db.prepare(`SELECT account_id, access_token_enc, access_token_fingerprint,
    access_token_first_seen_at FROM credentials`).all()) as any[]) {
  let fingerprint = String(row.access_token_fingerprint || "");
  let firstSeenAt = String(row.access_token_first_seen_at || "");
  if (!fingerprint && row.access_token_enc) {
    try {
      const token = decryptSecret(String(row.access_token_enc || ""));
      if (token) fingerprint = crypto.createHash("sha256").update(token).digest("base64url");
    } catch {
      fingerprint = "";
    }
  }
  if (!firstSeenAt && fingerprint) firstSeenAt = credentialBaselineAt;
  if (fingerprint || firstSeenAt) {
    (await db.prepare(`UPDATE credentials SET access_token_fingerprint=?, access_token_first_seen_at=? WHERE account_id=?`)
      .run(fingerprint, firstSeenAt, row.account_id));
  }
}

// GrabPay was never a supported channel.  Clear legacy projections so the
// retired label cannot reappear after a V1 shadow sync or a process restart.
(await db.prepare("UPDATE gpt_accounts SET billing_channel='' WHERE lower(billing_channel)='ph-grabpay'").run());

const version = (await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_meta").get()) as { version: number };
if (version.version < 5) {
	(await db.prepare("INSERT INTO schema_meta(version, applied_at) VALUES(5, ?)").run(new Date().toISOString()));
}

(await runMigrations(db));

return db;
}
