import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { isPlanOrderSubject } from "./plus-evidence.js";
import { applyMailIngestionSchema } from "./cf-mail.js";
import { applyBusinessEvidenceSchema } from "./business-evidence.js";
import { applyCompatibilitySchema } from "./compatibility-schema.js";
import { applyMailRecipientIndex, repairVerificationCategories } from "./mail-recipient-index.js";
import { decryptSecret } from "./crypto.js";
import { normalizeEmail, splitEmail } from "./association.js";

type SqliteDatabase = Database.Database;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hasColumn(database: SqliteDatabase, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

function hasTable(database: SqliteDatabase, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function addColumn(database: SqliteDatabase, table: string, column: string, declaration: string): void {
  if (!hasColumn(database, table, column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

function applySchemaV7(database: SqliteDatabase): void {
  addColumn(database, "email_bindings", "receive_disabled_at", "TEXT NOT NULL DEFAULT ''");
  addColumn(database, "gpt_accounts", "billing_channel_override", "TEXT NOT NULL DEFAULT ''");
  database.exec(`
    CREATE TABLE IF NOT EXISTS account_origins (
      account_id TEXT NOT NULL REFERENCES gpt_accounts(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT '',
      is_auto INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(account_id, source_type, source_id)
    );
    CREATE TABLE IF NOT EXISTS account_preferences (
      account_id TEXT PRIMARY KEY REFERENCES gpt_accounts(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      hide_billing INTEGER NOT NULL DEFAULT 0,
      show_deactivation INTEGER NOT NULL DEFAULT 0,
      hide_promotion INTEGER NOT NULL DEFAULT 0,
      status_message TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_channel_observations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES gpt_accounts(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      source TEXT NOT NULL,
      evidence_id TEXT NOT NULL DEFAULT '',
      observed_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS mailbox_connections (
      id TEXT PRIMARY KEY,
      binding_id TEXT REFERENCES email_bindings(id) ON DELETE CASCADE,
      mailbox_family_id TEXT REFERENCES mailbox_families(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      external_account_id TEXT NOT NULL DEFAULT '',
      external_group_id TEXT NOT NULL DEFAULT '',
      secret_ref TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      last_checked_at TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_routing_rules (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES email_bindings(id) ON DELETE CASCADE,
      sender_pattern TEXT NOT NULL DEFAULT '',
      recipient_pattern TEXT NOT NULL DEFAULT '',
      valid_from TEXT NOT NULL DEFAULT '',
      valid_to TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS binding_transitions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES gpt_accounts(id) ON DELETE CASCADE,
      from_binding_id TEXT NOT NULL REFERENCES email_bindings(id),
      to_binding_id TEXT NOT NULL REFERENCES email_bindings(id),
      changed_at TEXT NOT NULL,
      method TEXT NOT NULL,
      task_id TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(account_id, from_binding_id, to_binding_id)
    );
    CREATE TABLE IF NOT EXISTS credential_versions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES gpt_accounts(id) ON DELETE CASCADE,
      observed_binding_id TEXT REFERENCES email_bindings(id),
      subject_hash TEXT NOT NULL DEFAULT '',
      access_token_enc TEXT NOT NULL DEFAULT '',
      refresh_token_enc TEXT NOT NULL DEFAULT '',
      id_token_enc TEXT NOT NULL DEFAULT '',
      session_token_enc TEXT NOT NULL DEFAULT '',
      openai_password_enc TEXT NOT NULL DEFAULT '',
      token_fingerprint TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      validity_status TEXT NOT NULL DEFAULT 'unknown',
      validity_checked_at TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      supersedes_id TEXT REFERENCES credential_versions(id),
      retired_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, token_fingerprint)
    );
    CREATE TABLE IF NOT EXISTS account_current_credentials (
      account_id TEXT PRIMARY KEY REFERENCES gpt_accounts(id) ON DELETE CASCADE,
      credential_version_id TEXT NOT NULL REFERENCES credential_versions(id),
      selected_at TEXT NOT NULL,
      selection_reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credential_observations (
      id TEXT PRIMARY KEY,
      credential_version_id TEXT NOT NULL REFERENCES credential_versions(id) ON DELETE CASCADE,
      binding_id TEXT REFERENCES email_bindings(id),
      source TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS promotion_jobs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES gpt_accounts(id) ON DELETE CASCADE,
      credential_version_id TEXT REFERENCES credential_versions(id),
      campaign TEXT NOT NULL,
      region TEXT NOT NULL DEFAULT 'JP',
      check_kind TEXT NOT NULL DEFAULT 'auto',
      due_at TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      error_class TEXT NOT NULL DEFAULT '',
      error_detail TEXT NOT NULL DEFAULT '',
      next_retry_at TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS promotion_observations (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES promotion_jobs(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES gpt_accounts(id) ON DELETE CASCADE,
      credential_version_id TEXT REFERENCES credential_versions(id),
      campaign TEXT NOT NULL,
      eligible INTEGER,
      result_status TEXT NOT NULL,
      upstream_status INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      response_hash TEXT NOT NULL DEFAULT '',
      checked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_health_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_health_results (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES oauth_health_jobs(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES gpt_accounts(id) ON DELETE CASCADE,
      credential_version_id TEXT REFERENCES credential_versions(id),
      access_status TEXT NOT NULL DEFAULT 'unknown',
      refresh_status TEXT NOT NULL DEFAULT 'unknown',
      detail TEXT NOT NULL DEFAULT '',
      checked_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS change_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL DEFAULT 1,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      source_system TEXT NOT NULL DEFAULT 'v2',
      occurred_at TEXT NOT NULL,
      committed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_consumers (
      consumer TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      last_event_id TEXT NOT NULL DEFAULT '',
      source_cursor TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL DEFAULT 0,
      received_version INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_links (
      source_system TEXT NOT NULL,
      source_id TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      source_version TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(source_system, source_id, aggregate_type)
    );
    CREATE TABLE IF NOT EXISTS worker_heartbeats (
      worker_name TEXT PRIMARY KEY,
      artifact_sha256 TEXT NOT NULL DEFAULT '',
      process_id INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      detail_json TEXT NOT NULL DEFAULT '{}',
      heartbeat_at TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mailbox_sync_state (
      source TEXT PRIMARY KEY,
      cursor TEXT NOT NULL DEFAULT '',
      source_revision TEXT NOT NULL DEFAULT '',
      lag_seconds REAL NOT NULL DEFAULT 0,
      last_success_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_origins_workbench ON account_origins(source_type, is_auto, account_id);
    CREATE INDEX IF NOT EXISTS idx_binding_transitions_account ON binding_transitions(account_id, changed_at);
    CREATE INDEX IF NOT EXISTS idx_credential_versions_account ON credential_versions(account_id, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_promotion_jobs_due ON promotion_jobs(status, next_retry_at, due_at);
    CREATE INDEX IF NOT EXISTS idx_promotion_observations_account ON promotion_observations(account_id, checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outbox_committed ON change_outbox(sequence, committed_at);
  `);
}

function backfillCredentialVersions(database: SqliteDatabase, now: string): void {
  const rows = database.prepare(`SELECT c.*,
      (SELECT b.id FROM email_bindings b WHERE b.account_id=c.account_id AND b.is_current=1 ORDER BY b.valid_from DESC LIMIT 1) binding_id
    FROM credentials c
    WHERE c.access_token_enc!='' OR c.refresh_token_enc!='' OR c.id_token_enc!='' OR c.session_token_enc!=''`).all() as any[];
  const insertVersion = database.prepare(`INSERT OR IGNORE INTO credential_versions(
    id, account_id, observed_binding_id, subject_hash, access_token_enc, refresh_token_enc, id_token_enc, session_token_enc,
    openai_password_enc, token_fingerprint, first_seen_at, last_seen_at, validity_status, validity_checked_at, source,
    supersedes_id, retired_reason, created_at, updated_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', ?, ?)`);
  const selectCurrent = database.prepare("SELECT credential_version_id FROM account_current_credentials WHERE account_id=?");
  const insertCurrent = database.prepare(`INSERT OR IGNORE INTO account_current_credentials(account_id, credential_version_id, selected_at, selection_reason)
    VALUES(?, ?, ?, 'legacy_credentials_backfill')`);
  const insertObservation = database.prepare(`INSERT OR IGNORE INTO credential_observations(
    id, credential_version_id, binding_id, source, observed_at, evidence_json
  ) VALUES(?, ?, ?, ?, ?, '{}')`);
  for (const row of rows) {
    const accountId = String(row.account_id);
    const fingerprint = String(row.access_token_fingerprint || "") || `legacy:${sha256(`${accountId}:${row.access_token_enc}:${row.refresh_token_enc}`)}`;
    const versionId = sha256(`credential-version:${accountId}:${fingerprint}`).slice(0, 32);
    const firstSeen = String(row.access_token_first_seen_at || row.source_updated_at || row.updated_at || now);
    const validity = Number(row.access_token_alive) ? "alive" : "unknown";
    insertVersion.run(
      versionId, accountId, row.binding_id || null, String(row.openai_subject_hash || ""), String(row.access_token_enc || ""),
      String(row.refresh_token_enc || ""), String(row.id_token_enc || ""), String(row.session_token_enc || ""),
      String(row.openai_password_enc || ""), fingerprint, firstSeen, String(row.updated_at || now), validity,
      validity === "alive" ? String(row.updated_at || now) : "", String(row.source || "legacy-credentials"), firstSeen, now,
    );
    if (!selectCurrent.get(accountId)) insertCurrent.run(accountId, versionId, now);
    insertObservation.run(sha256(`credential-observation:${versionId}:${row.binding_id || "none"}:backfill`).slice(0, 32), versionId, row.binding_id || null, "legacy-backfill", firstSeen);
  }
}

function migrateBindingTransitions(database: SqliteDatabase, now: string): number {
  const rows = database.prepare(`SELECT * FROM account_relations
    WHERE relation_type='email_rebind' AND from_account_id=to_account_id`).all() as any[];
  const binding = database.prepare("SELECT account_id FROM email_bindings WHERE id=?");
  const insert = database.prepare(`INSERT OR IGNORE INTO binding_transitions(
    id, account_id, from_binding_id, to_binding_id, changed_at, method, task_id, evidence_json, created_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const remove = database.prepare("DELETE FROM account_relations WHERE id=?");
  let migrated = 0;
  for (const row of rows) {
    let evidence: Record<string, unknown> = {};
    try { evidence = JSON.parse(String(row.evidence_json || "{}")); } catch { evidence = {}; }
    const fromBindingId = String(evidence.previousBindingId || evidence.fromBindingId || "");
    const toBindingId = String(evidence.nextBindingId || evidence.toBindingId || "");
    const from = fromBindingId ? binding.get(fromBindingId) as any : null;
    const to = toBindingId ? binding.get(toBindingId) as any : null;
    if (!from || !to || String(from.account_id) !== String(row.from_account_id) || String(to.account_id) !== String(row.from_account_id)) continue;
    insert.run(String(row.id), String(row.from_account_id), fromBindingId, toBindingId, String(row.changed_at || now),
      String(row.association_method || "legacy_rebind"), String(evidence.taskId || ""), String(row.evidence_json || "{}"), String(row.created_at || now));
    remove.run(String(row.id));
    migrated += 1;
  }
  return migrated;
}

function resolveActiveWithoutBinding(database: SqliteDatabase, now: string): { retired: number; quarantined: number } {
  const rows = database.prepare(`SELECT a.*,
      EXISTS(SELECT 1 FROM credentials c WHERE c.account_id=a.id AND (c.access_token_enc!='' OR c.openai_subject_hash!='')) has_identity
    FROM gpt_accounts a WHERE a.lifecycle_status='active' AND a.deleted_at=''
      AND NOT EXISTS(SELECT 1 FROM email_bindings b WHERE b.account_id=a.id AND b.is_current=1)`).all() as any[];
  let retired = 0;
  let quarantined = 0;
  for (const row of rows) {
    if (String(row.source_status) === "recovered" && !Number(row.has_identity)) {
      database.prepare(`UPDATE gpt_accounts SET lifecycle_status='retired', source_status='historical_only',
        retired_at=CASE WHEN retired_at='' THEN ? ELSE retired_at END, updated_at=? WHERE id=?`).run(now, now, row.id);
      retired += 1;
      continue;
    }
    const reason = "身份记录存在但没有可证实的当前邮箱绑定，已隔离等待核对";
    database.prepare(`UPDATE gpt_accounts SET lifecycle_status='quarantined', quarantined_at=CASE WHEN quarantined_at='' THEN ? ELSE quarantined_at END,
      quarantine_reason=?, updated_at=? WHERE id=?`).run(now, reason, now, row.id);
    database.prepare(`INSERT OR IGNORE INTO pending_reviews(id, review_type, account_id, candidate_email_hash, reason, evidence_json, created_at, updated_at)
      VALUES(?, 'active_identity_without_binding', ?, ?, ?, ?, ?, ?)`).run(
      sha256(`active-identity-without-binding:${row.id}`).slice(0, 32), row.id, sha256(`no-current-binding:${row.id}`), reason,
      JSON.stringify({ sourceStatus: row.source_status, identityStatus: row.identity_status }), now, now,
    );
    quarantined += 1;
  }
  return { retired, quarantined };
}

function backfillOriginsAndRouting(database: SqliteDatabase, now: string): void {
  const rows = database.prepare(`SELECT a.id account_id, a.source_status, a.created_at, b.id binding_id, b.provider, b.source_json
    FROM gpt_accounts a LEFT JOIN email_bindings b ON b.account_id=a.id AND b.is_current=1`).all() as any[];
  const insertOrigin = database.prepare(`INSERT OR IGNORE INTO account_origins(account_id, source_type, source_id, is_auto, first_seen_at, metadata_json)
    VALUES(?, ?, ?, ?, ?, ?)`);
  const insertPreference = database.prepare(`INSERT OR IGNORE INTO account_preferences(account_id, hide_promotion, updated_at)
    SELECT id, hide_promotion, ? FROM gpt_accounts WHERE id=?`);
  for (const row of rows) {
    let source: Record<string, unknown> = {};
    try { source = JSON.parse(String(row.source_json || "{}")); } catch { source = {}; }
    const sourcePath = String(source.sourcePath || "");
    const auto = /auto|api/i.test(sourcePath) || String(row.source_status).toLowerCase().includes("sub2api");
    const sourceType = auto ? "auto_api" : String(row.source_status || "legacy_v1");
    insertOrigin.run(row.account_id, sourceType, String(sourcePath || row.binding_id || ""), auto ? 1 : 0,
      String(row.created_at || now), JSON.stringify({ provider: row.provider || "", importedFrom: row.source_status || "" }));
    insertPreference.run(now, row.account_id);
  }
}

function migratePromotionJobs(database: SqliteDatabase, now: string): void {
  const jobs = database.prepare(`SELECT j.*,
      (SELECT credential_version_id FROM account_current_credentials cc WHERE cc.account_id=j.account_id) credential_version_id
    FROM payment_exposure_jobs j WHERE j.job_kind='auto_trial'`).all() as any[];
  const insert = database.prepare(`INSERT OR IGNORE INTO promotion_jobs(
    id, account_id, credential_version_id, campaign, region, check_kind, due_at, attempt, status, error_class, error_detail,
    next_retry_at, started_at, finished_at, created_at, updated_at
  ) VALUES(?, ?, ?, ?, 'JP', 'auto', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of jobs) {
    const oldStatus = String(row.status || "");
    const completed = oldStatus === "completed";
    const status = completed ? "completed" : "retry_wait";
    const errorClass = completed ? "" : oldStatus === "dispatching" ? "interrupted_dispatch" : "legacy_unclassified_failure";
    const detail = completed ? "" : String(row.last_error || "") || `历史 ${oldStatus || "unknown"} 任务未保存上游 item 错误，已转为可重试`;
    insert.run(`legacy:${row.job_id}`, row.account_id, row.credential_version_id || null, "plus-1-month-free",
      String(row.scheduled_at || row.created_at || now), completed ? 1 : 0, status, errorClass, detail,
      completed ? "" : now, String(row.started_at || ""), String(row.finished_at || ""), String(row.created_at || now), now);
  }
}

function applyDataBackfillV8(database: SqliteDatabase): void {
  const now = new Date().toISOString();
  backfillCredentialVersions(database, now);
  const migratedTransitions = migrateBindingTransitions(database, now);
  const noBinding = resolveActiveWithoutBinding(database, now);
  backfillOriginsAndRouting(database, now);
  migratePromotionJobs(database, now);
  database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES('migration_v8_summary', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(
    JSON.stringify({ migratedTransitions, ...noBinding }), now,
  );
}

function preservePromotionInvalidCredentialsV9(database: SqliteDatabase): void {
  const now = new Date().toISOString();
  const latestInvalid = `WITH ranked AS (
    SELECT id, credential_version_id, status,
      ROW_NUMBER() OVER(PARTITION BY credential_version_id ORDER BY datetime(updated_at) DESC, id DESC) position
    FROM promotion_jobs WHERE credential_version_id IS NOT NULL
  ) SELECT credential_version_id FROM ranked WHERE position=1 AND status='credential_invalid'`;
  const repaired = database.prepare(`UPDATE credential_versions
    SET validity_status='invalid', validity_checked_at=CASE WHEN validity_checked_at='' THEN ? ELSE validity_checked_at END, updated_at=?
    WHERE id IN (${latestInvalid}) AND validity_status NOT IN ('invalid','conflict')`).run(now, now).changes;
  const compatibility = database.prepare(`UPDATE credentials SET access_token_alive=0, refresh_token_alive=0, updated_at=?
    WHERE account_id IN (
      SELECT cc.account_id FROM account_current_credentials cc
      JOIN credential_versions cv ON cv.id=cc.credential_version_id
      WHERE cv.validity_status IN ('invalid','conflict')
    ) AND (access_token_alive<>0 OR refresh_token_alive<>0)`).run(now).changes;
  database.prepare(`INSERT INTO settings(key, value, updated_at) VALUES('migration_v9_summary', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(
    JSON.stringify({ repairedCredentialVersions: repaired, clearedCompatibilityRows: compatibility }), now,
  );
}

function applyIndependentRuntimeV10(database: SqliteDatabase): void {
  if (hasTable(database, "mailbox_connections")) {
    addColumn(database, "mailbox_connections", "manager_email_enc", "TEXT NOT NULL DEFAULT ''");
    addColumn(database, "mailbox_connections", "credentials_enc", "TEXT NOT NULL DEFAULT ''");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      token_enc TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL,
      max_views INTEGER NOT NULL DEFAULT 5,
      views INTEGER NOT NULL DEFAULT 0,
      last_view_at TEXT NOT NULL DEFAULT '',
      revoked_at TEXT NOT NULL DEFAULT '',
      filters_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS share_view_dedup (
      link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
      visitor_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY(link_id, visitor_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_share_links_created ON share_links(created_at DESC);
  `);
  if (hasTable(database, "mailbox_sync_state")) database.exec("CREATE INDEX IF NOT EXISTS idx_mailbox_sync_updated ON mailbox_sync_state(updated_at DESC)");
  if (hasTable(database, "email_bindings") && hasColumn(database, "email_bindings", "email_hash")) {
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_binding_per_account
      ON email_bindings(account_id) WHERE is_current=1`);
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_owner_per_email
      ON email_bindings(email_hash) WHERE is_current=1`);
  }
  if (hasTable(database, "mail_ownership_claims")) {
    database.prepare(`UPDATE mail_ownership_claims SET visible_to_customer=0 WHERE message_id IN (
      SELECT message_id FROM mail_ownership_claims GROUP BY message_id
      HAVING COUNT(DISTINCT account_id)>1
        AND SUM(CASE WHEN claim_type<>'legacy_mapping_index' THEN 1 ELSE 0 END)>0
    )`).run();
  }
}

interface Migration {
  version: number;
  name: string;
  apply: (database: SqliteDatabase) => void;
}

function repairPlanOrderMailCategoriesV14(database: SqliteDatabase): void {
  if (!hasTable(database, "mail_messages")) return;
  const rows = database.prepare("SELECT id,subject FROM mail_messages WHERE category!='billing'").all() as Array<{ id: string; subject: string }>;
  const update = database.prepare("UPDATE mail_messages SET category='billing' WHERE id=?");
  for (const row of rows) if (isPlanOrderSubject(row.subject)) update.run(row.id);
}

function restoreLegacyIndexedMailVisibilityV15(database: SqliteDatabase): void {
  if (!hasTable(database, "mail_ownership_claims") || !hasColumn(database, "mail_ownership_claims", "claim_type")) return;
  // V1 stored a per-mapping view, so one shared/iCloud message may appear in
  // several mapping indexes after alias rotation or a rebind. Those rows are
  // not an identity conflict. Restore each exact V1 mapping view only when all
  // claims came from that index; any native/routing claim keeps the message
  // isolated for review.
  database.prepare(`UPDATE mail_ownership_claims SET visible_to_customer=1
    WHERE claim_type='legacy_mapping_index' AND message_id IN (
      SELECT message_id FROM mail_ownership_claims GROUP BY message_id
      HAVING COUNT(DISTINCT account_id)>1
        AND SUM(CASE WHEN claim_type<>'legacy_mapping_index' THEN 1 ELSE 0 END)=0
    )`).run();
}

const COMPATIBILITY_RELAY_SENDER_PATTERN = "(^|<|\\b)[a-z]+_at_tm[a-z0-9]*_openai_com_[a-z0-9]+_[a-z0-9]+@icloud\\.com(>|\\b|$)";
const COMPATIBILITY_DIRECT_SENDER_PATTERN = "(^|<|\\b)[^\\s<>@]+@(?:[a-z0-9-]+\\.)*openai\\.com(>|\\b|$)";

function compatibilityMailboxPattern(address: string): string {
  return `(^|<|\\b)${address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(>|\\b|$)`;
}

function isCompatibilityOpenAiSender(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  const domain = normalized.split("@").at(-1) || "";
  return domain === "openai.com" || domain.endsWith(".openai.com")
    || /^[a-z]+_at_tm[a-z0-9]*_openai_com_[a-z0-9]+_[a-z0-9]+@icloud\.com$/.test(normalized);
}

function repairCompatibilityCustomerSenderRulesV18(database: SqliteDatabase): void {
  if (!hasTable(database, "email_bindings") || !hasTable(database, "mail_routing_rules")) return;
  const rows = database.prepare(`SELECT r.id,r.sender_pattern,b.provider,b.source_json
    FROM mail_routing_rules r JOIN email_bindings b ON b.id=r.binding_id
    WHERE r.source='v2-compatibility'`).all() as Array<{
      id: string; sender_pattern: string; provider: string; source_json: string;
    }>;
  const update = database.prepare("UPDATE mail_routing_rules SET sender_pattern=?,updated_at=? WHERE id=?");
  const now = new Date().toISOString();
  let repaired = 0;
  for (const row of rows) {
    let sourceEmail = "";
    try { sourceEmail = String(JSON.parse(String(row.source_json || "{}"))?.compatibility?.sourceEmail || "").trim().toLowerCase(); }
    catch {}
    if (!sourceEmail || isCompatibilityOpenAiSender(sourceEmail)) continue;
    // Only replace the exact rule generated from sourceEmail. Explicit custom
    // fromPatterns remain untouched.
    if (String(row.sender_pattern) !== compatibilityMailboxPattern(sourceEmail)) continue;
    update.run(row.provider === "domain" ? COMPATIBILITY_DIRECT_SENDER_PATTERN : COMPATIBILITY_RELAY_SENDER_PATTERN, now, row.id);
    repaired += 1;
  }
  if (hasTable(database, "settings")) database.prepare(`INSERT INTO settings(key,value,updated_at)
    VALUES('migration_v18_summary',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(JSON.stringify({ repairedCompatibilitySenderRules: repaired }), now);
}

function applyOpenAiAuthenticationMetadataV19(database: SqliteDatabase): void {
  if (!hasTable(database, "gpt_accounts")) return;
  addColumn(database, "gpt_accounts", "openai_mfa_enabled", "INTEGER NOT NULL DEFAULT 0");
  addColumn(database, "gpt_accounts", "openai_auth_methods_json", "TEXT NOT NULL DEFAULT '[]'");
}

function applyOpenAiTotpSecretV20(database: SqliteDatabase): void {
  if (!hasTable(database, "account_passwords")) return;
  addColumn(database, "account_passwords", "totp_secret_enc", "TEXT NOT NULL DEFAULT ''");
}

function repairAutomaticMailDeactivations(database: SqliteDatabase): number {
  if (!hasTable(database, "lifecycle_events") || !hasColumn(database, "gpt_accounts", "deactivation_locked")
    || !hasColumn(database, "gpt_accounts", "deactivated_at") || !hasColumn(database, "gpt_accounts", "retired_at")) return 0;
  const now = new Date().toISOString();
  const falseLocks = database.prepare(`SELECT a.id,a.identity_status,a.note FROM gpt_accounts a
    WHERE a.deleted_at='' AND a.deactivation_locked=1 AND a.retired_at=''
      AND EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.account_id=a.id
        AND e.event_type='account_deactivated' AND e.source LIKE '%-sync'
        AND json_extract(e.payload_json,'$.reason') LIKE 'mail_deactivation_detected%')
      AND NOT EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.account_id=a.id
        AND ((e.event_type='account_deactivated' AND e.source LIKE 'v2-admin%')
          OR e.event_type='mailbox_recycled_out'))`).all() as Array<{
          id: string; identity_status: string; note: string;
        }>;
  const repair = database.prepare(`UPDATE gpt_accounts SET
    lifecycle_status=CASE
      WHEN identity_status='conflict' THEN 'quarantined'
      WHEN note LIKE '%第三方注册%' AND note LIKE '%待%恢复%' THEN 'third_party_pending_recovery'
      WHEN note LIKE '%第三方注册%' THEN 'third_party_registered'
      ELSE 'active' END,
    deactivation_locked=0,deactivated_at='',admin_deactivated_at='',updated_at=? WHERE id=?`);
  const insertAudit = database.prepare(`INSERT OR IGNORE INTO lifecycle_events(
    id,account_id,event_type,occurred_at,source,payload_json,created_at)
    VALUES(?,?,'automatic_deactivation_reverted',?,'v2-migration',?,?)`);
  for (const account of falseLocks) {
    repair.run(now, account.id);
    insertAudit.run(sha256(`automatic-deactivation-reverted:${account.id}`), account.id, now,
      JSON.stringify({ reason: "mail_detection_is_evidence_only" }), now);
  }
  return falseLocks.length;
}

function writeMigrationRepairSummary(database: SqliteDatabase, key: string, repaired: number): void {
  const now = new Date().toISOString();
  if (hasTable(database, "settings")) database.prepare(`INSERT INTO settings(key,value,updated_at)
    VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(key, JSON.stringify({ revertedAutomaticMailDeactivations: repaired }), now);
}

function applyAdministratorDeactivationBoundaryV21(database: SqliteDatabase): void {
  if (!hasTable(database, "gpt_accounts")) return;
  addColumn(database, "gpt_accounts", "admin_deactivated_at", "TEXT NOT NULL DEFAULT ''");
  writeMigrationRepairSummary(database, "migration_v21_summary", repairAutomaticMailDeactivations(database));
}

function repairAdministratorEventScopeV22(database: SqliteDatabase): void {
  if (!hasTable(database, "gpt_accounts")) return;
  writeMigrationRepairSummary(database, "migration_v22_summary", repairAutomaticMailDeactivations(database));
}

function iCloudPoolAddress(emailInput: string): string {
  const email = normalizeEmail(emailInput);
  const parts = splitEmail(email);
  if (!parts.localPart || !(parts.domain === "icloud.com" || parts.domain.endsWith(".icloud.com"))) return "";
  return `${parts.localPart.replace(/\+oai[a-z0-9]+$/i, "")}@${parts.domain}`;
}

function hideAmbiguousICloudBaseClaimsV23(database: SqliteDatabase): void {
  if (!hasTable(database, "email_bindings") || !hasTable(database, "mail_messages")
    || !hasTable(database, "mail_ownership_claims") || !hasTable(database, "gpt_accounts")
    || !hasColumn(database, "email_bindings", "receive_disabled_at")) return;
  const bindings = database.prepare(`SELECT b.id,b.account_id,b.email_enc,b.valid_from,b.valid_to,b.receive_disabled_at
    FROM email_bindings b JOIN gpt_accounts a ON a.id=b.account_id WHERE a.deleted_at=''`).all() as any[];
  const byId = new Map<string, any>();
  const byPool = new Map<string, any[]>();
  for (const binding of bindings) {
    let email = "";
    try { email = normalizeEmail(decryptSecret(String(binding.email_enc || ""))); } catch {}
    const pool = iCloudPoolAddress(email);
    if (!pool) continue;
    const item = { ...binding, email, pool };
    byId.set(String(binding.id), item);
    const group = byPool.get(pool) || [];
    group.push(item);
    byPool.set(pool, group);
  }
  const rows = database.prepare(`SELECT m.id,m.received_at,m.recipient_enc,c.binding_id
    FROM mail_messages m JOIN mail_ownership_claims c ON c.message_id=m.id
    WHERE m.provider='shared-mail-api' AND c.claim_type='routing_rule' AND c.visible_to_customer=1`).all() as any[];
  const messageIds = new Set<string>();
  const poolKeys = new Set<string>();
  for (const row of rows) {
    let recipient = "";
    try { recipient = normalizeEmail(decryptSecret(String(row.recipient_enc || ""))); } catch {}
    const recipientParts = splitEmail(recipient);
    const pool = iCloudPoolAddress(recipient);
    const owner = byId.get(String(row.binding_id));
    if (!pool || recipientParts.localPart.includes("+") || !owner || owner.pool !== pool || !owner.email.includes("+")) continue;
    const receivedAt = Date.parse(String(row.received_at || ""));
    if (!Number.isFinite(receivedAt)) continue;
    const eligibleAccounts = new Set((byPool.get(pool) || []).filter((binding) => {
      const from = Date.parse(String(binding.valid_from || ""));
      const to = Date.parse(String(binding.valid_to || ""));
      const disabledAt = Date.parse(String(binding.receive_disabled_at || ""));
      return (!Number.isFinite(from) || receivedAt >= from) && (!Number.isFinite(to) || receivedAt < to)
        && (!Number.isFinite(disabledAt) || receivedAt <= disabledAt);
    }).map((binding) => String(binding.account_id)));
    if (eligibleAccounts.size <= 1) continue;
    messageIds.add(String(row.id));
    poolKeys.add(pool);
  }
  const hide = database.prepare(`UPDATE mail_ownership_claims SET visible_to_customer=0
    WHERE message_id=? AND claim_type='routing_rule'`);
  for (const messageId of messageIds) hide.run(messageId);
  const now = new Date().toISOString();
  if (hasTable(database, "settings")) database.prepare(`INSERT INTO settings(key,value,updated_at)
    VALUES('migration_v23_summary',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(JSON.stringify({ hiddenAmbiguousBaseMessages: messageIds.size, affectedPools: poolKeys.size }), now);
}

function repairReviewedTrialAttributionV24(database: SqliteDatabase): void {
  if (!hasTable(database, "gpt_accounts") || !hasTable(database, "mail_messages")
    || !hasTable(database, "mail_ownership_claims") || !hasTable(database, "lifecycle_events")) return;
  // This pair was reviewed from the original MIME headers and OpenAI account
  // identity. Keep the repair deliberately bounded: other legacy index rows
  // remain evidence candidates until their original message is reviewed.
  const rejectedAccountId = "99f6a2b4-5f11-f621-83bb-cbace5f67266";
  const acceptedAccountId = "12c8c11b-ae4f-2638-a19b-5ad4c89d9c86";
  const messages = database.prepare(`SELECT id,provider_message_id FROM mail_messages
    WHERE provider='shared-mail-api' AND provider_message_id IN ('5556','5619')`).all() as any[];
  const rejectedClaims: Array<{ messageId: string; bindingId: string }> = [];
  for (const message of messages) {
    const accepted = database.prepare(`SELECT 1 FROM mail_ownership_claims
      WHERE message_id=? AND account_id=? LIMIT 1`).get(message.id, acceptedAccountId);
    if (!accepted) continue;
    const rows = database.prepare(`SELECT binding_id FROM mail_ownership_claims
      WHERE message_id=? AND account_id=? AND claim_type='legacy_mapping_index'`).all(
      message.id, rejectedAccountId,
    ) as any[];
    for (const row of rows) rejectedClaims.push({ messageId: String(message.id), bindingId: String(row.binding_id) });
  }
  const now = new Date().toISOString();
  const insertEvent = database.prepare(`INSERT OR IGNORE INTO lifecycle_events(
      id,account_id,binding_id,event_type,occurred_at,source,payload_json,created_at)
    VALUES(?,?,?,'mail_claim_rejected',?,'v2-migration',?,?)`);
  const hide = database.prepare(`UPDATE mail_ownership_claims SET visible_to_customer=0,
    reason='reviewed_recipient_identity_mismatch' WHERE message_id=? AND account_id=? AND binding_id=?`);
  for (const claim of rejectedClaims) {
    insertEvent.run(sha256(`reviewed-mail-claim-rejected:${claim.messageId}:${claim.bindingId}`), rejectedAccountId,
      claim.bindingId, now, JSON.stringify({ messageId: claim.messageId, reason: "reviewed_recipient_identity_mismatch" }), now);
    hide.run(claim.messageId, rejectedAccountId, claim.bindingId);
  }
  if (rejectedClaims.length) {
    database.prepare(`INSERT OR IGNORE INTO lifecycle_events(
        id,account_id,binding_id,event_type,occurred_at,source,payload_json,created_at)
      VALUES(?,?,NULL,'plus_trial_only_corrected',?,'v2-migration',?,?)`).run(
      sha256(`reviewed-plus-trial-only:${rejectedAccountId}`), rejectedAccountId, now,
      JSON.stringify({ reason: "zero_charge_trial_and_wrong_mail_attribution" }), now,
    );
    database.prepare(`UPDATE gpt_accounts SET plan='free',billing_channel='',billing_channel_override='',updated_at=?
      WHERE id=?`).run(now, rejectedAccountId);
    if (hasTable(database, "account_business_evidence")) database.prepare(`UPDATE account_business_evidence
      SET billing_started_at='',updated_at=? WHERE account_id=?`).run(now, rejectedAccountId);
    if (hasTable(database, "billing_channel_observations")) database.prepare(`UPDATE billing_channel_observations
      SET active=0 WHERE account_id=?`).run(rejectedAccountId);
  }
  if (hasTable(database, "settings")) database.prepare(`INSERT INTO settings(key,value,updated_at)
    VALUES('migration_v24_summary',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(
      JSON.stringify({ rejectedClaims: rejectedClaims.length, correctedAccounts: rejectedClaims.length ? 1 : 0 }), now,
    );
}

function restoreMailboxBatchVisibilityV25(database: SqliteDatabase): void {
  if (!hasTable(database, "email_bindings") || !hasTable(database, "mail_messages")
    || !hasTable(database, "mail_ownership_claims") || !hasTable(database, "gpt_accounts")
    || !hasColumn(database, "email_bindings", "receive_disabled_at")) return;
  const bindings = database.prepare(`SELECT b.id,b.account_id,b.email_enc,b.valid_from,b.valid_to,b.receive_disabled_at
    FROM email_bindings b JOIN gpt_accounts a ON a.id=b.account_id WHERE a.deleted_at=''`).all() as any[];
  const byId = new Map<string, any>();
  const byPool = new Map<string, any[]>();
  for (const binding of bindings) {
    let email = "";
    try { email = normalizeEmail(decryptSecret(String(binding.email_enc || ""))); } catch {}
    const pool = iCloudPoolAddress(email);
    if (!pool) continue;
    const item = { ...binding, email, pool };
    byId.set(String(binding.id), item);
    byPool.set(pool, [...(byPool.get(pool) || []), item]);
  }
  const rows = database.prepare(`SELECT DISTINCT m.id,m.received_at,m.recipient_enc,c.binding_id
    FROM mail_messages m JOIN mail_ownership_claims c ON c.message_id=m.id
    WHERE m.provider='shared-mail-api' AND c.claim_type='routing_rule'`).all() as any[];
  const messageIds = new Set<string>();
  const poolKeys = new Set<string>();
  for (const row of rows) {
    let recipient = "";
    try { recipient = normalizeEmail(decryptSecret(String(row.recipient_enc || ""))); } catch {}
    const recipientParts = splitEmail(recipient);
    const pool = iCloudPoolAddress(recipient);
    const owner = byId.get(String(row.binding_id));
    if (!pool || recipientParts.localPart.includes("+") || !owner || owner.pool !== pool) continue;
    const receivedAt = Date.parse(String(row.received_at || ""));
    if (!Number.isFinite(receivedAt)) continue;
    const eligibleAccounts = new Set((byPool.get(pool) || []).filter((binding) => {
      const from = Date.parse(String(binding.valid_from || ""));
      const to = Date.parse(String(binding.valid_to || ""));
      const disabledAt = Date.parse(String(binding.receive_disabled_at || ""));
      return (!Number.isFinite(from) || receivedAt >= from) && (!Number.isFinite(to) || receivedAt < to)
        && (!Number.isFinite(disabledAt) || receivedAt <= disabledAt);
    }).map((binding) => String(binding.account_id)));
    if (eligibleAccounts.size <= 1) continue;
    messageIds.add(String(row.id));
    poolKeys.add(pool);
  }
  const restore = database.prepare(`UPDATE mail_ownership_claims SET visible_to_customer=1,
    reason='mailbox_batch_shared_visibility_v25' WHERE message_id=? AND claim_type='routing_rule'`);
  let restoredClaims = 0;
  for (const messageId of messageIds) restoredClaims += restore.run(messageId).changes;
  const now = new Date().toISOString();
  if (hasTable(database, "settings")) database.prepare(`INSERT INTO settings(key,value,updated_at)
    VALUES('migration_v25_summary',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(
      JSON.stringify({ sharedBatchMessages: messageIds.size, restoredClaims, affectedBatches: poolKeys.size,
        v24AuditEvidenceRetained: true }), now,
    );
}

function repairLocalizedPlanOrderMailCategoriesV26(database: SqliteDatabase): void {
  if (!hasTable(database, "mail_messages") || !hasColumn(database, "mail_messages", "category")) return;
  const rows = database.prepare("SELECT id,subject FROM mail_messages WHERE category!='billing'").all() as Array<{ id: string; subject: string }>;
  const update = database.prepare("UPDATE mail_messages SET category='billing' WHERE id=?");
  for (const row of rows) if (isPlanOrderSubject(row.subject)) update.run(row.id);
}

function addPaymentExposureRemoteJobIdV29(database: SqliteDatabase): void {
  if (!hasTable(database, "payment_exposure_jobs")) return;
  addColumn(database, "payment_exposure_jobs", "remote_job_id", "TEXT NOT NULL DEFAULT ''");
  database.prepare("UPDATE payment_exposure_jobs SET remote_job_id=job_id WHERE TRIM(remote_job_id)='' ").run();
}

const migrations: Migration[] = [
  { version: 7, name: "domain-model-and-sync-schema", apply: applySchemaV7 },
  { version: 8, name: "lossless-production-backfill", apply: applyDataBackfillV8 },
  { version: 9, name: "preserve-promotion-invalid-credentials", apply: preservePromotionInvalidCredentialsV9 },
  { version: 10, name: "independent-runtime-and-share-links", apply: applyIndependentRuntimeV10 },
  { version: 11, name: "bounded-mail-ingestion-and-business-evidence", apply: (database) => {
    applyMailIngestionSchema(database);
    applyBusinessEvidenceSchema(database);
    if (hasTable(database, "raw_import_records")) {
      // Preserve provenance hashes, discard legacy whole-record envelopes.
      database.exec("UPDATE raw_import_records SET payload_json='{}'");
    }
  } },
  { version: 12, name: "independent-pending-mailbox-intake", apply: applyCompatibilitySchema },
  { version: 13, name: "atomic-mail-event-retries", apply: applyMailIngestionSchema },
  { version: 14, name: "repair-plan-order-mail-categories", apply: repairPlanOrderMailCategoriesV14 },
  { version: 15, name: "restore-v1-mapping-mail-visibility", apply: restoreLegacyIndexedMailVisibilityV15 },
  { version: 16, name: "recipient-index-and-multilingual-verification", apply: applyMailRecipientIndex },
  { version: 17, name: "repair-historical-localized-login-codes", apply: repairVerificationCategories },
  { version: 18, name: "repair-compatibility-customer-sender-rules", apply: repairCompatibilityCustomerSenderRulesV18 },
  { version: 19, name: "openai-authentication-metadata", apply: applyOpenAiAuthenticationMetadataV19 },
  { version: 20, name: "encrypted-openai-totp-secret", apply: applyOpenAiTotpSecretV20 },
  { version: 21, name: "administrator-deactivation-mail-boundary", apply: applyAdministratorDeactivationBoundaryV21 },
  { version: 22, name: "repair-administrator-event-scope", apply: repairAdministratorEventScopeV22 },
  { version: 23, name: "hide-ambiguous-coexisting-mailbox-claims", apply: hideAmbiguousICloudBaseClaimsV23 },
  { version: 24, name: "repair-reviewed-trial-mail-attribution", apply: repairReviewedTrialAttributionV24 },
  { version: 25, name: "restore-mailbox-batch-shared-visibility", apply: restoreMailboxBatchVisibilityV25 },
  { version: 26, name: "repair-localized-plan-order-mail-categories", apply: repairLocalizedPlanOrderMailCategoriesV26 },
  { version: 29, name: "payment-exposure-remote-batch-job-id", apply: addPaymentExposureRemoteJobIdV29 },
];

export function runMigrations(database: SqliteDatabase): Array<{ version: number; name: string }> {
  const current = Number((database.prepare("SELECT COALESCE(MAX(version), 0) version FROM schema_meta").get() as any)?.version || 0);
  const applied: Array<{ version: number; name: string }> = [];
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    database.transaction(() => {
      migration.apply(database);
      database.prepare("INSERT INTO schema_meta(version, applied_at) VALUES(?, ?)").run(migration.version, new Date().toISOString());
    })();
    applied.push({ version: migration.version, name: migration.name });
  }
  return applied;
}
