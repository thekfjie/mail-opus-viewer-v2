import crypto from "node:crypto";
import { db } from "./db.js";
import { encryptSecret } from "./crypto.js";

export interface CredentialObservationInput {
  accountId: string;
  bindingId?: string | null;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  sessionToken?: string;
  openaiPassword?: string;
  subjectHash?: string;
  source: string;
  observedAt?: string;
  validityStatus?: "alive" | "invalid" | "unknown" | "conflict";
  evidence?: Record<string, unknown>;
  observationKey?: string;
  allowAccountMutation?: boolean;
}

export interface CredentialObservationResult {
  credentialVersionId: string;
  tokenFingerprint: string;
  firstSeenAt: string;
  current: boolean;
  changed: boolean;
  conflict: boolean;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function timestamp(value: string | undefined): string {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function encrypted(value: string | undefined): string {
  return value ? encryptSecret(String(value)) : "";
}

function currentBindingId(accountId: string): string {
  const row = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId) as any;
  return String(row?.id || "");
}

function compatibilityProjection(versionId: string): void {
  const row = db.prepare("SELECT * FROM credential_versions WHERE id=?").get(versionId) as any;
  if (!row) return;
  db.prepare(`INSERT INTO credentials(
      account_id, access_token_enc, refresh_token_enc, id_token_enc, session_token_enc, openai_password_enc,
      openai_subject_hash, access_token_alive, refresh_token_alive, source, source_updated_at,
      access_token_fingerprint, access_token_first_seen_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      access_token_enc=excluded.access_token_enc, refresh_token_enc=excluded.refresh_token_enc,
      id_token_enc=excluded.id_token_enc, session_token_enc=excluded.session_token_enc,
      openai_password_enc=excluded.openai_password_enc, openai_subject_hash=excluded.openai_subject_hash,
      access_token_alive=excluded.access_token_alive, refresh_token_alive=excluded.refresh_token_alive,
      source=excluded.source, source_updated_at=excluded.source_updated_at,
      access_token_fingerprint=excluded.access_token_fingerprint,
      access_token_first_seen_at=excluded.access_token_first_seen_at, updated_at=excluded.updated_at`).run(
    row.account_id, row.access_token_enc, row.refresh_token_enc, row.id_token_enc, row.session_token_enc,
    row.openai_password_enc, row.subject_hash, row.validity_status === "alive" ? 1 : 0,
    row.validity_status === "alive" && row.refresh_token_enc ? 1 : 0, row.source, row.last_seen_at,
    row.token_fingerprint, row.first_seen_at, row.updated_at,
  );
}

export function observeCredentialVersion(input: CredentialObservationInput): CredentialObservationResult {
  const account = db.prepare(`SELECT id, plan, billing_channel, billing_channel_override
    FROM gpt_accounts WHERE id=? AND deleted_at=''`).get(input.accountId) as any;
  if (!account) throw new Error("凭证目标账号不存在");
  const observedAt = timestamp(input.observedAt);
  const accessToken = String(input.accessToken || "");
  const refreshToken = String(input.refreshToken || "");
  const idToken = String(input.idToken || "");
  const sessionToken = String(input.sessionToken || "");
  if (!accessToken && !refreshToken && !idToken && !sessionToken) throw new Error("凭证观察没有 AT/RT/ID Token/Session Token");
  const tokenFingerprint = accessToken
    ? sha256(accessToken)
    : `bundle:${sha256(`${refreshToken}\0${idToken}\0${sessionToken}`)}`;
  const bindingId = String(input.bindingId || currentBindingId(input.accountId) || "");
  const currentBinding = currentBindingId(input.accountId);
  const existing = db.prepare("SELECT * FROM credential_versions WHERE account_id=? AND token_fingerprint=?").get(input.accountId, tokenFingerprint) as any;
  const versionId = String(existing?.id || sha256(`credential-version:${input.accountId}:${tokenFingerprint}`).slice(0, 32));
  const selected = db.prepare(`SELECT cc.credential_version_id, cv.subject_hash, cv.token_fingerprint
    FROM account_current_credentials cc JOIN credential_versions cv ON cv.id=cc.credential_version_id WHERE cc.account_id=?`).get(input.accountId) as any;
  const subjectHash = String(input.subjectHash || existing?.subject_hash || "");
  const subjectConflict = Boolean(selected?.subject_hash && subjectHash && String(selected.subject_hash) !== subjectHash);
  const protectedPaidAccount = String(account.plan || "") === "plus"
    && Boolean(String(account.billing_channel_override || account.billing_channel || ""));
  const historicalObservation = Boolean(bindingId && currentBinding && bindingId !== currentBinding);
  const canSelect = !subjectConflict && !historicalObservation;
  const changed = !existing;
  const requestedValidity = String(input.validityStatus || "unknown");
  const reviveAfterBindingChange = Boolean(existing?.retired_reason === "binding_changed_without_current_credential"
    && bindingId && bindingId === currentBinding && requestedValidity === "alive");
  const preserveTerminalValidity = Boolean(existing && ["invalid", "conflict"].includes(String(existing.validity_status || ""))
    && !subjectConflict && !reviveAfterBindingChange && ["alive", "unknown"].includes(requestedValidity));
  const validity = subjectConflict ? "conflict" : preserveTerminalValidity ? String(existing.validity_status) : requestedValidity;
  const validityCheckedAt = preserveTerminalValidity
    ? String(existing.validity_checked_at || "")
    : validity === "unknown" ? "" : observedAt;
  const firstSeenAt = String(existing?.first_seen_at || observedAt);
  const previousVersionId = canSelect && selected && String(selected.credential_version_id) !== versionId
    ? String(selected.credential_version_id) : null;

  db.transaction(() => {
    db.prepare(`INSERT INTO credential_versions(
        id, account_id, observed_binding_id, subject_hash, access_token_enc, refresh_token_enc, id_token_enc,
        session_token_enc, openai_password_enc, token_fingerprint, first_seen_at, last_seen_at, validity_status,
        validity_checked_at, source, supersedes_id, retired_reason, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
      ON CONFLICT(account_id, token_fingerprint) DO UPDATE SET
        observed_binding_id=COALESCE(credential_versions.observed_binding_id, excluded.observed_binding_id),
        subject_hash=CASE WHEN excluded.subject_hash!='' THEN excluded.subject_hash ELSE credential_versions.subject_hash END,
        access_token_enc=CASE WHEN excluded.access_token_enc!='' THEN excluded.access_token_enc ELSE credential_versions.access_token_enc END,
        refresh_token_enc=CASE WHEN excluded.refresh_token_enc!='' THEN excluded.refresh_token_enc ELSE credential_versions.refresh_token_enc END,
        id_token_enc=CASE WHEN excluded.id_token_enc!='' THEN excluded.id_token_enc ELSE credential_versions.id_token_enc END,
        session_token_enc=CASE WHEN excluded.session_token_enc!='' THEN excluded.session_token_enc ELSE credential_versions.session_token_enc END,
        openai_password_enc=CASE WHEN excluded.openai_password_enc!='' THEN excluded.openai_password_enc ELSE credential_versions.openai_password_enc END,
        last_seen_at=CASE WHEN julianday(excluded.last_seen_at)>julianday(credential_versions.last_seen_at) THEN excluded.last_seen_at ELSE credential_versions.last_seen_at END,
        validity_status=CASE
          WHEN credential_versions.validity_status IN ('invalid','conflict') AND excluded.validity_status IN ('alive','unknown')
            AND NOT (credential_versions.retired_reason='binding_changed_without_current_credential' AND excluded.validity_status='alive')
            THEN credential_versions.validity_status
          WHEN excluded.validity_status!='unknown' THEN excluded.validity_status
          ELSE credential_versions.validity_status END,
        validity_checked_at=CASE
          WHEN credential_versions.validity_status IN ('invalid','conflict') AND excluded.validity_status IN ('alive','unknown')
            AND NOT (credential_versions.retired_reason='binding_changed_without_current_credential' AND excluded.validity_status='alive')
            THEN credential_versions.validity_checked_at
          WHEN excluded.validity_status!='unknown' THEN excluded.validity_checked_at
          ELSE credential_versions.validity_checked_at END,
        retired_reason=CASE
          WHEN credential_versions.retired_reason='binding_changed_without_current_credential'
            AND excluded.validity_status='alive' THEN ''
          ELSE credential_versions.retired_reason END,
        source=excluded.source, updated_at=excluded.updated_at`).run(
      versionId, input.accountId, bindingId || null, subjectHash, encrypted(input.accessToken), encrypted(input.refreshToken),
      encrypted(input.idToken), encrypted(input.sessionToken), encrypted(input.openaiPassword), tokenFingerprint,
      firstSeenAt, observedAt, validity, validityCheckedAt, input.source,
      previousVersionId, observedAt, observedAt,
    );
    const observationId = sha256(`credential-observation:${versionId}:${bindingId || "none"}:${input.source}:${input.observationKey || tokenFingerprint}`).slice(0, 32);
    db.prepare(`INSERT INTO credential_observations(id, credential_version_id, binding_id, source, observed_at, evidence_json)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at, evidence_json=excluded.evidence_json`).run(
      observationId, versionId, bindingId || null, input.source, observedAt,
      JSON.stringify({ historicalObservation, ...input.evidence }),
    );
    if (canSelect) {
      if (previousVersionId) db.prepare("UPDATE credential_versions SET retired_reason='superseded', updated_at=? WHERE id=? AND retired_reason=''")
        .run(observedAt, previousVersionId);
      db.prepare(`INSERT INTO account_current_credentials(account_id, credential_version_id, selected_at, selection_reason)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET credential_version_id=excluded.credential_version_id,
          selected_at=excluded.selected_at, selection_reason=excluded.selection_reason`).run(
        input.accountId, versionId, observedAt, previousVersionId ? "new_credential_observation" : "matching_credential_observation",
      );
      compatibilityProjection(versionId);
    }
    if (subjectConflict && input.allowAccountMutation !== false) {
      const reason = protectedPaidAccount
        ? "新凭证 subject 与管理员确认的付费账号冲突，版本已保留且未切换当前指针"
        : "新凭证 subject 与账号当前凭证冲突，版本已保留但未切换当前指针";
      if (!protectedPaidAccount) {
        db.prepare(`UPDATE gpt_accounts SET lifecycle_status=CASE WHEN deactivation_locked=1 THEN 'deactivated' ELSE 'quarantined' END,
          identity_status='conflict', quarantined_at=CASE WHEN quarantined_at='' THEN ? ELSE quarantined_at END,
          quarantine_reason=?, updated_at=? WHERE id=?`).run(observedAt, reason, observedAt, input.accountId);
      }
      db.prepare(`INSERT OR IGNORE INTO pending_reviews(id, review_type, account_id, candidate_email_hash, reason, evidence_json, created_at, updated_at)
        VALUES(?, 'credential_subject_conflict', ?, ?, ?, ?, ?, ?)`).run(
        sha256(`credential-conflict:${input.accountId}:${tokenFingerprint}`).slice(0, 32), input.accountId,
        sha256(`credential:${versionId}`), reason, JSON.stringify({ versionId, bindingId, source: input.source }), observedAt, observedAt,
      );
    }
  })();

  return { credentialVersionId: versionId, tokenFingerprint, firstSeenAt, current: canSelect, changed, conflict: subjectConflict };
}

export function invalidateCredentialVersion(versionId: string, checkedAt: string): void {
  db.prepare("UPDATE credential_versions SET validity_status='invalid', validity_checked_at=?, updated_at=? WHERE id=?")
    .run(checkedAt, checkedAt, versionId);
  const current = db.prepare("SELECT 1 FROM account_current_credentials WHERE credential_version_id=?").get(versionId);
  if (current) compatibilityProjection(versionId);
}

export function invalidateCurrentCredentialWithoutCurrentBindingObservation(
  accountId: string,
  currentBindingId: string,
  checkedAt: string,
): boolean {
  const selected = db.prepare(`SELECT cv.id FROM account_current_credentials cc
    JOIN credential_versions cv ON cv.id=cc.credential_version_id
    WHERE cc.account_id=?`).get(accountId) as any;
  if (!selected?.id || !currentBindingId) return false;
  const observedOnCurrent = db.prepare(`SELECT 1 FROM credential_observations
    WHERE credential_version_id=? AND binding_id=? LIMIT 1`).get(selected.id, currentBindingId);
  if (observedOnCurrent) return false;
  db.prepare(`UPDATE credential_versions SET validity_status='invalid', validity_checked_at=?,
    retired_reason=CASE WHEN retired_reason='' THEN 'binding_changed_without_current_credential' ELSE retired_reason END,
    updated_at=? WHERE id=?`).run(checkedAt, checkedAt, selected.id);
  compatibilityProjection(String(selected.id));
  return true;
}

export function credentialHistory(accountId: string): Array<Record<string, unknown>> {
  return (db.prepare(`SELECT cv.id, cv.subject_hash subjectHash, cv.token_fingerprint tokenFingerprint,
      cv.first_seen_at firstSeenAt, cv.last_seen_at lastSeenAt, cv.validity_status validityStatus,
      cv.validity_checked_at validityCheckedAt, cv.source, cv.supersedes_id supersedesId,
      cv.retired_reason retiredReason, cv.observed_binding_id observedBindingId,
      CASE WHEN cc.credential_version_id=cv.id THEN 1 ELSE 0 END current,
      (SELECT count(*) FROM credential_observations co WHERE co.credential_version_id=cv.id) observationCount
    FROM credential_versions cv LEFT JOIN account_current_credentials cc ON cc.account_id=cv.account_id
    WHERE cv.account_id=? ORDER BY cv.first_seen_at DESC, cv.id DESC`).all(accountId) as any[]).map((row) => ({ ...row, current: Boolean(row.current) }));
}
