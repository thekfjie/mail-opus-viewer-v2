import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildAssociationGraph, emailHash, LegacyMapping, LegacyRecord, normalizeEmail, parseJwtSubject, providerFor, splitEmail, stableId } from "./association.js";
import { config } from "./config.js";
import { legacyConfig } from "./legacy-config.js";
import { decryptSecret, digestToken, encryptSecret } from "./crypto.js";
import { db } from "./db.js";
import { classifyMail } from "./mail-classification.js";
import { fingerprintAccessToken } from "./access-token-observation.js";
import { invalidateCurrentCredentialWithoutCurrentBindingObservation, observeCredentialVersion } from "./credential-versions.js";
import { freezeAccountTransition } from "./account-transitions.js";
import { LEGACY_DIRECT_SENDER_PATTERN, LEGACY_RELAY_SENDER_PATTERN, mailboxRecipientPattern, normalizeHiddenTags } from "./business-evidence.js";
import { parseExternalMailbox } from "./external-mailbox.js";
import { hasActiveTrialOnlyCorrection } from "./plus-plan-state.js";

type JsonObject = Record<string, any>;
const OPENAI_SIGNUP_POOL_NOTE = "automyai OpenAI signup pool pending";
const OPENAI_REBIND_TARGET_NOTE = "automyai OpenAI email rebind target pending";

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function readJsonArray(filePath: string): JsonObject[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

function readEvidenceEntries(filePath: string): JsonObject {
  if (!filePath) return {};
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value.entries === "object" && !Array.isArray(value.entries) ? value.entries : {};
  } catch { return {}; }
}

function legacyEvidenceConfigKey(record: JsonObject, usage = false): string {
  const parts: unknown[] = [record.outlookManagerEmail || "", record.outlookManagerGroupId || "", record.address || "",
    record.sourceEmail || "", record.toEmail || record.email || "", record.fromPatterns || [], record.toPatterns || []];
  if (!usage) parts.unshift(record.billingChannelOverride || "");
  if (record.mailNotBefore || record.mailNotAfter || record.mailRestoredAt || record.lifecycleStatus) {
    parts.push(record.mailNotBefore || "", record.mailNotAfter || "", record.mailRestoredAt || "", record.lifecycleStatus || "");
  }
  if ((record.domainMailbox || providerFor(record as LegacyMapping) === "domain") && (record.rebindPreviousId || record.rebindPreviousEmail)) {
    parts.push("mail-association", record.rebindPreviousId || "", normalizeEmail(record.rebindPreviousEmail || ""));
  }
  return JSON.stringify(parts) + (usage && record.markColor === "purple" ? "|self-used-purple" : "");
}

function findBackupFiles(root: string): string[] {
  const output: string[] = [];
  const walk = (directory: string): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (/access-config.*\.json$/i.test(entry.name) || /^access-config\.bak/i.test(entry.name)) output.push(target);
    }
  };
  walk(root);
  return output.sort((left, right) => {
    try { return fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs; } catch { return left.localeCompare(right); }
  });
}

function sourceRecordId(record: JsonObject): string {
  return String(record.id || stableId("legacy-source", normalizeEmail(record.email || record.login), record.createdAt || ""));
}

function isRebindTargetRecord(record: JsonObject): boolean {
  return Boolean(record.rebindPreviousId || record.rebindPreviousEmail || record.__synthetic);
}

function recordOrderTimestamp(record: JsonObject): string {
  const rebindChangedAt = isRebindTargetRecord(record) ? String(record.rebindChangedAt || "") : "";
  if (rebindChangedAt && Number.isFinite(Date.parse(rebindChangedAt))) return rebindChangedAt;
  return String(record.mailNotBefore || record.createdAt || record.updatedAt || record.registrationCreatedAt || "");
}

function recordTime(record: JsonObject): number {
  const value = Date.parse(recordOrderTimestamp(record));
  return Number.isFinite(value) ? value : 0;
}

function iso(value: unknown, fallback = ""): string {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function earliestIso(values: unknown[]): string {
  const times = values.map((value) => Date.parse(String(value || ""))).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : "";
}

function latestIso(values: unknown[], fallback: string): string {
  const times = values.map((value) => Date.parse(String(value || ""))).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : fallback;
}

function tokenMaterial(record: JsonObject): JsonObject {
  const oauth = record.openaiOAuth && typeof record.openaiOAuth === "object" ? record.openaiOAuth : {};
  const raw = {
    accessToken: String(oauth.accessToken || oauth.access_token || record.accessToken || record.access_token || ""),
    refreshToken: String(oauth.refreshToken || oauth.refresh_token || record.refreshToken || record.refresh_token || ""),
    idToken: String(oauth.idToken || oauth.id_token || record.idToken || record.id_token || ""),
    sessionToken: String(oauth.sessionToken || oauth.session_token || record.sessionToken || record.session_token || ""),
  };
  let wrapper: JsonObject = {};
  for (const value of [raw.accessToken, raw.idToken, raw.sessionToken]) {
    if (!value.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") { wrapper = parsed; break; }
    } catch {
      // Keep the original token when it is not JSON.
    }
  }
  const accessToken = String(wrapper.accessToken || wrapper.access_token || raw.accessToken);
  const idToken = String(wrapper.idToken || wrapper.id_token || raw.idToken);
  const sessionToken = String(wrapper.sessionToken || wrapper.session_token || raw.sessionToken);
  const claims = jwtClaims(accessToken || idToken);
  const identity = String(wrapper.user?.id || claims.accountUserId || claims.subject || "");
  const email = normalizeEmail(wrapper.user?.email || wrapper.profile?.email || claims.email || "");
  const seconds = Number(wrapper.user?.iat || claims.iat || 0);
  return {
    accessToken,
    refreshToken: String(wrapper.refreshToken || wrapper.refresh_token || raw.refreshToken),
    idToken,
    sessionToken,
    openaiPassword: String(record.openaiPassword || ""),
    updatedAt: String(oauth.updatedAt || record.credentialsSourceUpdatedAt || record.updatedAt || ""),
    source: String(record.credentialsImportedFrom || record.credentialsSource || "legacy-v1"),
    identity,
    accountId: String(wrapper.account?.id || claims.accountId || ""),
    email,
    changedAt: seconds > 1_000_000_000 ? new Date(seconds * 1_000).toISOString() : "",
  };
}

function jwtClaims(token: string): { subject: string; accountUserId: string; accountId: string; email: string; iat: number } {
  try {
    const payload = JSON.parse(Buffer.from(String(token || "").split(".")[1] || "", "base64url").toString("utf8"));
    const auth = payload["https://api.openai.com/auth"] || {};
    const profile = payload["https://api.openai.com/profile"] || {};
    return {
      subject: String(payload.sub || auth.user_id || ""),
      accountUserId: String(auth.chatgpt_account_user_id || auth.chatgpt_user_id || ""),
      accountId: String(auth.chatgpt_account_id || ""),
      email: normalizeEmail(profile.email || payload.email || ""),
      iat: Number(payload.iat || 0),
    };
  } catch {
    return { subject: "", accountUserId: "", accountId: "", email: "", iat: 0 };
  }
}

function credentialScore(record: JsonObject): number {
  const material = tokenMaterial(record);
  return [material.accessToken, material.refreshToken, material.idToken, material.sessionToken, material.openaiPassword].filter(Boolean).length * 1_000 + recordTime(record);
}

function isTransientAccountPlaceholder(record: JsonObject): boolean {
  if (record.bindingVerified === true) return false;
  const material = tokenMaterial(record);
  const hasCredential = Boolean(material.accessToken || material.refreshToken || material.idToken || material.sessionToken);
  if (hasCredential) {
    const recordEmail = normalizeEmail(record.email || record.login);
    if (
      record.domainMailbox
      && (record.rebindPreviousId || record.rebindPreviousEmail)
      && material.email
      && normalizeEmail(material.email) !== recordEmail
    ) return true;
    return false;
  }
  const note = String(record.note || "").trim();
  if (note === OPENAI_SIGNUP_POOL_NOTE || note === OPENAI_REBIND_TARGET_NOTE) return true;
  return Boolean(record.domainMailbox && (record.rebindPreviousId || record.rebindPreviousEmail));
}

function providerCanonical(record: JsonObject): string {
  return normalizeEmail(record.recycleBaseEmail || record.baseEmail || record.outlookManagerEmail || record.email || record.login);
}

function parseMailIndex(): Record<string, JsonObject> {
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyConfig.mailIndexFile, "utf8"));
    return parsed && typeof parsed.entries === "object" ? parsed.entries : {};
  } catch {
    return {};
  }
}

function indexedDeactivationAt(record: JsonObject, entry: JsonObject | undefined): string {
  const recordEmail = normalizeEmail(record.email || record.login);
  if (!recordEmail) return "";
  const timestamps: string[] = [];
  for (const mail of Array.isArray(entry?.mails) ? entry.mails : []) {
    const classification = classifyMail(String(mail.subject || ""), String(mail.from || mail.source || ""));
    if (classification.category !== "deactivation") continue;
    const recipientText = [mail.address, mail.to, ...(Array.isArray(mail.envelopeRecipients) ? mail.envelopeRecipients : [])]
      .map((value) => String(value || ""))
      .join("\n");
    const recipients = recipientText.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
    if (!recipients.some((email) => normalizeEmail(email) === recordEmail)) continue;
    const receivedAt = iso(mail.created_at_utc || mail.created_at);
    if (receivedAt) timestamps.push(receivedAt);
  }
  return earliestIso(timestamps);
}

const LEGACY_MARK_COLORS = new Set(["", "yellow", "orange", "green", "blue", "purple", "gray", "red"]);

function legacyBillingChannel(value: unknown): string {
  const channel = String(value || "").trim();
  return channel.toLowerCase() === "ph-grabpay" ? "" : channel;
}

function legacyBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function legacyMarkColor(value: unknown): string {
  const color = String(value || "").trim().toLowerCase();
  return LEGACY_MARK_COLORS.has(color) ? color : "";
}

// Some historical V1 snapshots kept only the terminal-status wording. Keep
// those identities deactivated during a clean projection rebuild as well.
function legacyDeactivationEvidence(record: JsonObject): boolean {
  if (String(record.lifecycleStatus || "").trim().toLowerCase() === "deactivated") return true;
  const text = [record.statusMessage, record.internalStatusMessage, record.status, record.reason]
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return /(?:GPT\s*(?:已被|被)\s*ban|access\s+deactivated|(?:访问|訪問|存取|帳戶|账户|账号|邮箱)\s*(?:已)?停用|(?:アクセス|アカウント)\s*(?:が)?無効)/i.test(text);
}

function legacyDeactivationAt(record: JsonObject): string {
  if (!legacyDeactivationEvidence(record)) return "";
  return String(record.deactivationDetectedAt || record.deactivatedAt || "");
}

function hasLegacyField(record: JsonObject, ...names: string[]): string {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) return name;
  }
  return "";
}

interface PaymentExposureBackup {
  id: string;
  accountId: string;
  subjectHash: string;
  emailHashes: string[];
  target: string;
  ipCountry: string;
  billingCountry: string;
  billingCurrency: string;
  expectedMethod: string;
  availableMethodsJson: string;
  matchedMethodsJson: string;
  paymentMethodsJson: string;
  trialStatus: string;
  exposed: number;
  status: string;
  checkoutType: string;
  detail: string;
  promoEligible: number;
  promoCampaign: string;
  observedAt: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface PaymentExposureJobBackup {
  jobId: string;
  accountId: string;
  routeKey: string;
  target: string;
  ipCountry: string;
  billingCountry: string;
  billingCurrency: string;
  jobKind: string;
  accessTokenFingerprint: string;
  scheduledAt: string;
  status: string;
  lastError: string;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface PromoEligibilityBackup {
  id: string;
  accountId: string;
  subjectHash: string;
  emailHashes: string[];
  accessTokenFingerprint: string;
  checkKind: string;
  status: string;
  eligible: number;
  campaign: string;
  evidence: string;
  method: string;
  endpoint: string;
  upstreamStatus: number;
  durationMs: number;
  error: string;
  scheduledAt: string;
  checkedAt: string;
  createdAt: string;
}

interface AccessTokenObservationBackup {
  accountId: string;
  fingerprint: string;
  firstSeenAt: string;
}

async function captureAccessTokenObservations(): Promise<{ byAccount: Map<string, AccessTokenObservationBackup>; byFingerprint: Map<string, string> }> {
  const byAccount = new Map<string, AccessTokenObservationBackup>();
  const byFingerprint = new Map<string, string>();
  const rows = (await db.prepare(`SELECT account_id, access_token_enc, access_token_fingerprint, access_token_first_seen_at
    FROM credentials`).all()) as any[];
  for (const row of rows) {
    let token = "";
    try { token = decryptSecret(String(row.access_token_enc || "")); } catch { token = ""; }
    const fingerprint = String(row.access_token_fingerprint || "") || fingerprintAccessToken(token);
    const firstSeenAt = String(row.access_token_first_seen_at || "");
    if (!fingerprint) continue;
    const observation = { accountId: String(row.account_id || ""), fingerprint, firstSeenAt };
    byAccount.set(observation.accountId, observation);
    if (firstSeenAt && !byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, firstSeenAt);
  }
  return { byAccount, byFingerprint };
}

async function capturePaymentExposureChecks(): Promise<PaymentExposureBackup[]> {
  const rows = (await db.prepare(`SELECT p.*, COALESCE(c.openai_subject_hash, '') AS subject_hash,
      COALESCE(GROUP_CONCAT(DISTINCT b.email_hash), '') AS email_hashes
    FROM payment_exposure_checks p
    LEFT JOIN credentials c ON c.account_id=p.account_id
    LEFT JOIN email_bindings b ON b.account_id=p.account_id
    GROUP BY p.id`).all()) as any[];
  return rows.map((row) => ({
    id: String(row.id || ""), accountId: String(row.account_id || ""), subjectHash: String(row.subject_hash || ""),
    emailHashes: String(row.email_hashes || "").split(",").filter(Boolean), target: String(row.target || ""),
    ipCountry: String(row.ip_country || ""), billingCountry: String(row.billing_country || ""),
    billingCurrency: String(row.billing_currency || ""), expectedMethod: String(row.expected_method || ""),
    availableMethodsJson: String(row.available_methods_json || "[]"), matchedMethodsJson: String(row.matched_methods_json || "[]"),
    paymentMethodsJson: String(row.payment_methods_json || "[]"), trialStatus: String(row.trial_status || "unknown"),
    exposed: Number(row.exposed || 0) ? 1 : 0, status: String(row.status || "unknown"),
    checkoutType: String(row.checkout_type || ""), detail: String(row.detail || ""),
    promoEligible: Number(row.promo_eligible) < 0 ? -1 : (Number(row.promo_eligible) ? 1 : 0),
    promoCampaign: String(row.promo_campaign || ""), observedAt: String(row.observed_at || ""),
    source: String(row.source || "automyai"), createdAt: String(row.created_at || ""), updatedAt: String(row.updated_at || ""),
  })).filter((row) => row.id && row.accountId);
}

async function capturePaymentExposureJobs(): Promise<PaymentExposureJobBackup[]> {
  const rows = (await db.prepare("SELECT * FROM payment_exposure_jobs").all()) as any[];
  return rows.map((row) => ({
    jobId: String(row.job_id || ""), accountId: String(row.account_id || ""), routeKey: String(row.route_key || ""),
    target: String(row.target || ""), ipCountry: String(row.ip_country || ""), billingCountry: String(row.billing_country || ""),
    billingCurrency: String(row.billing_currency || ""), jobKind: String(row.job_kind || "manual"),
    accessTokenFingerprint: String(row.access_token_fingerprint || ""), scheduledAt: String(row.scheduled_at || ""),
    status: String(row.status || "queued"), lastError: String(row.last_error || ""),
    startedAt: String(row.started_at || ""), finishedAt: String(row.finished_at || ""), createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  })).filter((row) => row.jobId && row.accountId);
}

async function promoEligibilityTableExists(): Promise<boolean> {
  return Boolean((await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='promo_eligibility_checks'").get()));
}

async function capturePromoEligibilityChecks(): Promise<PromoEligibilityBackup[]> {
  if (!(await promoEligibilityTableExists())) return [];
  const rows = (await db.prepare(`SELECT p.*, COALESCE(c.openai_subject_hash, '') AS subject_hash,
      COALESCE(GROUP_CONCAT(DISTINCT b.email_hash), '') AS email_hashes
    FROM promo_eligibility_checks p
    LEFT JOIN credentials c ON c.account_id=p.account_id
    LEFT JOIN email_bindings b ON b.account_id=p.account_id
    GROUP BY p.id`).all()) as any[];
  return rows.map((row) => ({
    id: String(row.id || ""), accountId: String(row.account_id || ""), subjectHash: String(row.subject_hash || ""),
    emailHashes: String(row.email_hashes || "").split(",").filter(Boolean),
    accessTokenFingerprint: String(row.access_token_fingerprint || ""), checkKind: String(row.check_kind || "manual"),
    status: String(row.status || "failed"), eligible: Number(row.eligible) < 0 ? -1 : Number(row.eligible) ? 1 : 0,
    campaign: String(row.campaign || ""), evidence: String(row.evidence || ""), method: String(row.method || "check_promo"),
    endpoint: String(row.endpoint || "/api/tools/chatgpt-promo-check"), upstreamStatus: Number(row.upstream_status || 0),
    durationMs: Number(row.duration_ms || 0), error: String(row.error || ""), scheduledAt: String(row.scheduled_at || ""),
    checkedAt: String(row.checked_at || ""), createdAt: String(row.created_at || ""),
  })).filter((row) => row.id && row.accountId);
}

async function reuseExistingProjectionAccounts(graph: ReturnType<typeof buildAssociationGraph>): Promise<void> {
  const replacements = new Map<string, string>();
  const claimed = new Set<string>();
  const bySource = db.prepare(`SELECT b.account_id
    FROM source_links sl JOIN email_bindings b ON b.id=sl.aggregate_id
    WHERE sl.source_system='v1' AND sl.source_id=? AND sl.aggregate_type='email_binding'`);
  const byEmail = db.prepare(`SELECT DISTINCT account_id FROM email_bindings
    WHERE email_hash=? AND is_current=1`);
  const bySubject = db.prepare(`SELECT DISTINCT account_id FROM openai_identity_observations
    WHERE subject_hash=? AND status!='conflict'`);

  for (const [projectedId, members] of graph.groups) {
    if ((await db.prepare("SELECT 1 FROM gpt_accounts WHERE id=?").get(projectedId))) {
      claimed.add(projectedId);
      continue;
    }
    const candidates = new Set<string>();
    for (const member of members) {
      for (const row of (await bySource.all(member.id)) as any[]) candidates.add(String(row.account_id));
      const email = normalizeEmail(member.email || member.login);
      if (email) for (const row of (await byEmail.all(emailHash(email))) as any[]) candidates.add(String(row.account_id));
      const material = tokenMaterial(member);
      const subject = String(material.identity || parseJwtSubject(material.accessToken || material.idToken));
      if (subject) for (const row of (await bySubject.all(sha256(subject))) as any[]) candidates.add(String(row.account_id));
    }
    const available = [...candidates].filter((accountId) => !claimed.has(accountId));
    if (available.length === 1) {
      replacements.set(projectedId, available[0]);
      claimed.add(available[0]);
    }
  }

  for (const [projectedId, existingId] of replacements) {
    const members = graph.groups.get(projectedId);
    if (!members) continue;
    graph.groups.delete(projectedId);
    graph.groups.set(existingId, members);
    for (const member of members) graph.accountIdByLegacyId.set(member.id, existingId);
  }
}

export interface SyncResult {
  runId: string;
  sourceCount: number;
  accountCount: number;
  bindingCount: number;
  relationCount: number;
  recoveredCount: number;
  routingCount: number;
  messageCount: number;
  paymentExposureRestoredCount: number;
  promoEligibilityRestoredCount: number;
  sourceHash: string;
}

export async function syncFromV1(options: { legacyAuthoritative?: boolean } = {}): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  (await db.prepare("INSERT INTO shadow_sync_runs(id, started_at, status) VALUES(?, ?, 'running')").run(runId, startedAt));

  try {
    const v1Authoritative = options.legacyAuthoritative === true;
    const currentPayload = fs.readFileSync(legacyConfig.configFile);
    const currentRecords = readJsonArray(legacyConfig.configFile);
    const mailFlagEntries = readEvidenceEntries(legacyConfig.mailFlagFile);
    const usageAuditEntries = readEvidenceEntries(legacyConfig.usageAuditFile);
    const currentIds = new Set(currentRecords.map(sourceRecordId));
    const latestById = new Map<string, LegacyRecord>();
    const rawRows: Array<{ sourcePath: string; sourceType: string; record: JsonObject }> = [];

    for (const filePath of findBackupFiles(legacyConfig.backupsDir)) {
      for (const record of readJsonArray(filePath)) {
        rawRows.push({ sourcePath: filePath, sourceType: "v1-backup", record });
        if (isTransientAccountPlaceholder(record)) continue;
        const id = sourceRecordId(record);
        if (currentIds.has(id)) continue;
        const previous = latestById.get(id);
        if (!previous || recordTime(record) >= recordTime(previous)) {
          latestById.set(id, { ...(record as LegacyMapping), id, __sourceStatus: "recovered", __sourcePath: filePath });
        }
      }
    }

    for (const record of currentRecords) {
      const id = sourceRecordId(record);
      rawRows.push({ sourcePath: legacyConfig.configFile, sourceType: "v1-current", record });
      if (isTransientAccountPlaceholder(record)) continue;
      latestById.set(id, { ...(record as LegacyMapping), id, __sourceStatus: "current", __sourcePath: legacyConfig.configFile });
    }

    const now = new Date().toISOString();
    const currentEmailSet = new Set([...latestById.values()].map((record) => normalizeEmail(record.email || record.login)).filter(Boolean));
    for (const record of [...latestById.values()]) {
      const material = tokenMaterial(record);
      if (material.identity) record.__identityKey = sha256(String(material.identity));
      const credentialEmail = normalizeEmail(material.email);
      const currentEmail = normalizeEmail(record.email || record.login);
      if (!credentialEmail || credentialEmail === currentEmail || currentEmailSet.has(credentialEmail)) continue;
      const currentLocal = splitEmail(currentEmail).localPart;
      const nextLocal = splitEmail(credentialEmail).localPart;
      if (!currentLocal || currentLocal !== nextLocal || config.routingEmails.has(credentialEmail)) continue;
      const syntheticId = stableId("credential-detected-binding", record.id, credentialEmail);
      const changedAt = iso(material.changedAt || material.updatedAt || record.updatedAt, now);
      const synthetic: LegacyRecord = {
        id: syntheticId,
        email: credentialEmail,
        domainMailbox: splitEmail(credentialEmail).domain !== "icloud.com",
        mailNotBefore: changedAt,
        createdAt: changedAt,
        updatedAt: changedAt,
        rebindPreviousId: record.id,
        rebindChangedAt: changedAt,
        __sourceStatus: "current",
        __sourcePath: `${legacyConfig.configFile}#credential-evidence`,
        __synthetic: true,
        __identityKey: record.__identityKey,
        openaiOAuth: record.openaiOAuth,
        openaiPassword: record.openaiPassword,
      };
      latestById.set(syntheticId, synthetic);
      currentEmailSet.add(credentialEmail);
    }
    const records = [...latestById.values()];
    const recordsById = new Map(records.map((record) => [String(record.id), record]));
    const mailIndex = parseMailIndex();
    const indexedDeactivationByLegacyId = new Map(records.map((record) => [
      String(record.id),
      indexedDeactivationAt(record, mailIndex[String(record.id)]),
    ]).filter((entry): entry is [string, string] => Boolean(entry[1])));
    const sourceHash = sha256(currentPayload);
    const graph = buildAssociationGraph(records, config.routingEmails);
    (await reuseExistingProjectionAccounts(graph));
    const paymentExposureBackups = (await capturePaymentExposureChecks());
    const paymentExposureJobBackups = (await capturePaymentExposureJobs());
    const promoEligibilityBackups = (await capturePromoEligibilityChecks());
    const accessTokenObservations = (await captureAccessTokenObservations());
    const paymentExposureSubjects = new Map<string, Set<string>>();
    const paymentExposureEmails = new Map<string, Set<string>>();
    const addCandidate = (map: Map<string, Set<string>>, key: string, accountId: string): void => {
      if (!key || !accountId) return;
      const candidates = map.get(key) || new Set<string>();
      candidates.add(accountId);
      map.set(key, candidates);
    };
    for (const record of records) {
      const accountId = graph.accountIdByLegacyId.get(record.id) || "";
      const email = normalizeEmail(record.email || record.login);
      if (email) addCandidate(paymentExposureEmails, emailHash(email), accountId);
    }
    for (const [accountId, members] of graph.groups) {
      const bestCredential = [...members].sort((a, b) => credentialScore(b) - credentialScore(a))[0] as JsonObject;
      const credential = tokenMaterial(bestCredential);
      const subject = String(credential.identity || parseJwtSubject(credential.accessToken || credential.idToken));
      if (subject) addCandidate(paymentExposureSubjects, sha256(subject), accountId);
    }
    const resolveProjectionAccount = (backup: { accountId: string; subjectHash: string; emailHashes: string[] }): string => {
      if (graph.groups.has(backup.accountId)) return backup.accountId;
      const subjectCandidates = paymentExposureSubjects.get(backup.subjectHash);
      if (subjectCandidates?.size === 1) return [...subjectCandidates][0];
      const emailCandidates = new Set<string>();
      for (const hash of backup.emailHashes) {
        for (const accountId of paymentExposureEmails.get(hash) || []) emailCandidates.add(accountId);
      }
      return emailCandidates.size === 1 ? [...emailCandidates][0] : "";
    };
    let paymentExposureRestoredCount = 0;
    let promoEligibilityRestoredCount = 0;
    const bindingIdByLegacyId = new Map<string, string>();
    const bindingWindow = new Map<string, { from: string; to: string; method: string }>();
    for (const record of records) {
      bindingWindow.set(record.id, {
        from: iso(record.mailNotBefore || record.createdAt || record.updatedAt),
        to: iso(record.mailNotAfter),
        method: "legacy_mapping",
      });
    }
    const orderedRebindPairs = [...graph.inferredRebindPairs].sort((left, right) =>
      Number(left.method === "legacy_explicit_rebind") - Number(right.method === "legacy_explicit_rebind"));
    for (const pair of orderedRebindPairs) {
      const changedAt = iso(pair.changedAt, now);
      const previous = bindingWindow.get(pair.previousId);
      const next = bindingWindow.get(pair.nextId);
      if (pair.method === "legacy_explicit_rebind") {
        if (previous) previous.to = changedAt;
        if (next) {
          next.from = changedAt;
          next.to = "";
        }
      } else {
        if (previous && !previous.to) previous.to = changedAt;
        if (next && !next.from) next.from = changedAt;
      }
      if (previous) previous.method = pair.method;
      if (next) next.method = pair.method;
    }

    const transaction = db.transaction(async () => {
      if (v1Authoritative) {
        // V1 is authoritative during coexistence. Projection diagnostics must
        // not become a second, continuously regenerated business queue.
        (await db.prepare("UPDATE pending_reviews SET status='resolved', updated_at=? WHERE status='pending'").run(now));
      }
      const insertRaw = db.prepare(`INSERT INTO raw_import_records(
        source_key, source_type, source_path, source_record_id, source_hash, source_updated_at, payload_json, imported_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET source_hash=excluded.source_hash, source_updated_at=excluded.source_updated_at,
        payload_json=excluded.payload_json, imported_at=excluded.imported_at`);
      for (const row of rawRows) {
        const id = sourceRecordId(row.record);
        const sourcePayload = JSON.stringify(row.record);
        const payload = JSON.stringify({ id, emailHash: emailHash(normalizeEmail(row.record.email || row.record.login)),
          updatedAt: iso(row.record.updatedAt), sourceType: row.sourceType });
        const sourceKey = sha256(`${row.sourcePath}\0${id}`);
        (await insertRaw.run(sourceKey, row.sourceType, row.sourcePath, id, sha256(sourcePayload), iso(row.record.updatedAt), payload, now));
      }

      const insertRouting = db.prepare("INSERT OR REPLACE INTO routing_endpoints(email_hash, email_enc, reason, created_at) VALUES(?, ?, ?, ?)");
      const configuredRoutingEmails = new Set<string>(config.routingEmails);
      for (const record of records.filter((item) => graph.routingIds.has(item.id))) {
        const email = normalizeEmail(record.email || record.login);
        if (email) configuredRoutingEmails.add(email);
      }
      for (const email of configuredRoutingEmails) {
        (await insertRouting.run(emailHash(email), encryptSecret(email), "configured or legacy routing endpoint", now));
      }

      const insertAccount = db.prepare(`INSERT INTO gpt_accounts(
        id, lifecycle_status, deactivation_locked, deactivated_at, sold, plan, billing_channel, billing_channel_override, note, payment_link, identity_status,
        hide_promotion, domain_mailbox, suspected_unused, mark_color, group_boundary, source_status,
        arrived_at, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        lifecycle_status=CASE WHEN gpt_accounts.deactivation_locked=1 THEN 'deactivated'
          WHEN gpt_accounts.retired_at!='' THEN 'retired' ELSE excluded.lifecycle_status END,
        deactivation_locked=MAX(gpt_accounts.deactivation_locked, excluded.deactivation_locked),
        deactivated_at=CASE WHEN gpt_accounts.deactivated_at='' THEN excluded.deactivated_at
          WHEN excluded.deactivated_at='' THEN gpt_accounts.deactivated_at
          ELSE MIN(gpt_accounts.deactivated_at, excluded.deactivated_at) END,
        sold=MAX(gpt_accounts.sold, excluded.sold), plan=excluded.plan, billing_channel=excluded.billing_channel,
        billing_channel_override=excluded.billing_channel_override,
        note=excluded.note, payment_link=excluded.payment_link,
        identity_status=${v1Authoritative ? "excluded.identity_status" : "CASE WHEN gpt_accounts.identity_status='conflict' THEN 'conflict' ELSE excluded.identity_status END"},
        quarantined_at=${v1Authoritative ? "CASE WHEN excluded.lifecycle_status='quarantined' THEN gpt_accounts.quarantined_at ELSE '' END" : "gpt_accounts.quarantined_at"},
        quarantine_reason=${v1Authoritative ? "CASE WHEN excluded.lifecycle_status='quarantined' THEN gpt_accounts.quarantine_reason ELSE '' END" : "gpt_accounts.quarantine_reason"},
        hide_promotion=excluded.hide_promotion, domain_mailbox=excluded.domain_mailbox,
        suspected_unused=excluded.suspected_unused, mark_color=excluded.mark_color,
        group_boundary=excluded.group_boundary, source_status=excluded.source_status,
        arrived_at=gpt_accounts.arrived_at, updated_at=excluded.updated_at`);
      const insertFamily = db.prepare(`INSERT OR IGNORE INTO mailbox_families(
        id, provider, canonical_address_enc, canonical_address_hash, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?)`);
      const insertBinding = db.prepare(`INSERT INTO email_bindings(
        id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider, valid_from, valid_to,
        is_current, association_method, legacy_mapping_id, source_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, mailbox_family_id=excluded.mailbox_family_id,
        email_enc=excluded.email_enc, email_hash=excluded.email_hash, local_part=excluded.local_part, domain=excluded.domain,
        provider=excluded.provider, valid_from=excluded.valid_from,
        valid_to=CASE WHEN email_bindings.valid_to='' THEN excluded.valid_to
          WHEN excluded.valid_to='' THEN email_bindings.valid_to ELSE MIN(email_bindings.valid_to,excluded.valid_to) END,
        is_current=CASE WHEN email_bindings.valid_to!='' THEN 0 ELSE excluded.is_current END, association_method=excluded.association_method,
        source_json=excluded.source_json, updated_at=excluded.updated_at`);
      const insertGrant = db.prepare(`INSERT INTO access_grants(
        id, account_id, binding_id, sale_id, public_token_hash, public_token_enc, legacy_public_token, login_identifier_hash, login_identifier_enc,
        password_hash, password_plain_enc, scope, visible_from, visible_to, active, first_used_at, last_used_at, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sale_id=excluded.sale_id, public_token_enc=excluded.public_token_enc,
        password_hash=excluded.password_hash, password_plain_enc=excluded.password_plain_enc,
        scope=CASE WHEN access_grants.scope='historical' THEN 'historical' ELSE excluded.scope END,
        visible_from=CASE WHEN access_grants.visible_from>excluded.visible_from THEN access_grants.visible_from ELSE excluded.visible_from END,
        visible_to=CASE WHEN access_grants.visible_to='' THEN excluded.visible_to
          WHEN excluded.visible_to='' THEN access_grants.visible_to
          WHEN access_grants.visible_to<excluded.visible_to THEN access_grants.visible_to ELSE excluded.visible_to END,
        active=CASE WHEN access_grants.revoked_at!='' OR (access_grants.scope!='admin_only' AND access_grants.active=0) THEN 0 ELSE excluded.active END,
        revoked_at=access_grants.revoked_at, revoke_reason=access_grants.revoke_reason,
        updated_at=excluded.updated_at`);
      const insertSale = db.prepare(`INSERT INTO sales(
        id, account_id, binding_id, status, started_at, ended_at, end_reason, first_used_at, last_used_at, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET binding_id=excluded.binding_id,
        status=CASE WHEN sales.status!='active' THEN sales.status ELSE excluded.status END,
        ended_at=CASE WHEN sales.ended_at='' THEN excluded.ended_at WHEN excluded.ended_at='' THEN sales.ended_at
          WHEN sales.ended_at<excluded.ended_at THEN sales.ended_at ELSE excluded.ended_at END,
        end_reason=CASE WHEN sales.end_reason!='' THEN sales.end_reason ELSE excluded.end_reason END, updated_at=excluded.updated_at`);
      const insertEvent = db.prepare(`INSERT OR IGNORE INTO lifecycle_events(
        id, account_id, binding_id, event_type, occurred_at, source, payload_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertIdentity = db.prepare(`INSERT OR IGNORE INTO openai_identity_observations(
        id, account_id, subject_hash, source, status, first_seen_at, last_seen_at, evidence_json
      ) VALUES(?, ?, ?, ?, 'confirmed', ?, ?, ?)
      ON CONFLICT(account_id, subject_hash) DO UPDATE SET source=excluded.source, status='confirmed',
        last_seen_at=excluded.last_seen_at, evidence_json=excluded.evidence_json`);
      const insertReview = db.prepare(`INSERT OR REPLACE INTO pending_reviews(
        id, review_type, account_id, candidate_email_enc, candidate_email_hash, status, reason, evidence_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`);
      const upsertOrigin = db.prepare(`INSERT INTO account_origins(account_id, source_type, source_id, is_auto, first_seen_at, metadata_json)
        VALUES(?, 'legacy_v1', 'access-config', ?, ?, ?)
        ON CONFLICT(account_id, source_type, source_id) DO UPDATE SET is_auto=excluded.is_auto,
          metadata_json=excluded.metadata_json`);
      const upsertPreference = db.prepare(`INSERT INTO account_preferences(account_id, label, hide_billing, show_deactivation, hide_promotion, status_message, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET label=excluded.label, hide_billing=excluded.hide_billing,
          show_deactivation=excluded.show_deactivation, hide_promotion=excluded.hide_promotion,
          status_message=excluded.status_message, updated_at=excluded.updated_at`);
      const upsertConnection = db.prepare(`INSERT INTO mailbox_connections(id, binding_id, mailbox_family_id, provider,
        external_account_id, external_group_id, secret_ref, status, metadata_json, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET binding_id=excluded.binding_id, mailbox_family_id=excluded.mailbox_family_id,
          provider=excluded.provider, external_account_id=excluded.external_account_id,
          external_group_id=excluded.external_group_id, secret_ref=excluded.secret_ref,
          status=excluded.status, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`);
      const upsertRoutingRule = db.prepare(`INSERT INTO mail_routing_rules(id, binding_id, sender_pattern, recipient_pattern,
        valid_from, valid_to, source, priority, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, 'legacy_v1', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET sender_pattern=excluded.sender_pattern,
          recipient_pattern=excluded.recipient_pattern, valid_from=excluded.valid_from,
          valid_to=excluded.valid_to, priority=excluded.priority, updated_at=excluded.updated_at`);
      const upsertSourceLink = db.prepare(`INSERT INTO source_links(source_system, source_id, aggregate_type, aggregate_id, source_version, updated_at)
        VALUES('v1', ?, ?, ?, ?, ?)
        ON CONFLICT(source_system, source_id, aggregate_type) DO UPDATE SET aggregate_id=excluded.aggregate_id,
          source_version=excluded.source_version, updated_at=excluded.updated_at`);

      for (const [accountId, members] of graph.groups) {
        const ordered = [...members].sort((a, b) => recordTime(a) - recordTime(b) || a.id.localeCompare(b.id));
        const latest = ordered[ordered.length - 1];
        const firstSold = ordered.find((item: JsonObject) => item.sold);
        const firstSoldEmail = firstSold ? normalizeEmail(firstSold.email || firstSold.login) : "";
        const firstSoldIndex = firstSold ? ordered.findIndex((item) => item.id === firstSold.id) : -1;
        const approvedRebindEmails = new Set(
          graph.inferredRebindPairs
            .filter((pair) => pair.method === "legacy_explicit_rebind")
            .filter((pair) => graph.accountIdByLegacyId.get(pair.previousId) === accountId && graph.accountIdByLegacyId.get(pair.nextId) === accountId)
            .map((pair) => normalizeEmail(recordsById.get(pair.nextId)?.email || recordsById.get(pair.nextId)?.login)),
        );
        const soldRebindAnomaly = firstSoldIndex >= 0 && ordered.slice(firstSoldIndex + 1).some((item) =>
          normalizeEmail(item.email || item.login) !== firstSoldEmail
            && !approvedRebindEmails.has(normalizeEmail(item.email || item.login)),
        );
        const indexedDeactivationTimes = members.map((item: JsonObject) => indexedDeactivationByLegacyId.get(String(item.id)) || "").filter(Boolean);
        const deactivationLocked = indexedDeactivationTimes.length > 0
          || members.some((item: JsonObject) => item.deactivationLocked || item.hasDeactivation || item.deactivatedAt || legacyDeactivationEvidence(item));
        const deactivatedAt = earliestIso([
          ...members.flatMap((item: JsonObject) => [item.deactivationDetectedAt, item.deactivatedAt, legacyDeactivationAt(item)]),
          ...indexedDeactivationTimes,
        ]);
        const allRetired = members.every((item: JsonObject) => String(item.lifecycleStatus || "") === "retired" || item.retiredAt);
        const allRecovered = members.every((item: JsonObject) => item.__sourceStatus === "recovered");
        const lifecycleStatus = deactivationLocked ? "deactivated"
          : (!v1Authoritative && soldRebindAnomaly) ? "quarantined"
            : (allRetired || allRecovered ? "retired" : "active");
        const trialOnlyCorrected = (await hasActiveTrialOnlyCorrection(db, accountId));
        const plan = !trialOnlyCorrected
          && members.some((item: JsonObject) => item.hasPlus || item.manualPlus || item.hasPlusOverride || String(item.plan || "").toLowerCase() === "plus")
          ? "plus" : "free";
        const everSold = members.some((item: JsonObject) => item.sold);
        // Credentials belong to the newest/current email identity. Never let
        // an older iCloud binding win merely because it has more token fields;
        // after rebind, the target must carry its own newly issued AT.
        const credential = tokenMaterial(latest);
        const suspectedSource = [...ordered].reverse().find((item) => hasLegacyField(item, "suspectedUnused", "suspected_unused"));
        const suspectedField = suspectedSource ? hasLegacyField(suspectedSource, "suspectedUnused", "suspected_unused") : "";
        // Missing credentials and activity evidence are common before the
        // Plus/usage audit completes (new registrations, rebind placeholders,
        // and delayed OAuth imports).  Only project an idle marker after an
        // upstream audit explicitly records the result.
        const suspectedUnused = suspectedField ? legacyBoolean(suspectedSource?.[suspectedField]) : false;
        const markSource = hasLegacyField(latest, "markColor", "mark_color")
          ? latest : [...ordered].reverse().find((item) => hasLegacyField(item, "markColor", "mark_color")) || latest;
        const markField = hasLegacyField(markSource, "markColor", "mark_color");
        const markColor = legacyMarkColor(markField ? markSource[markField] : "");
        const groupBoundaryField = hasLegacyField(latest, "groupBoundary", "group_boundary");
        const groupBoundary = groupBoundaryField ? legacyBoolean(latest[groupBoundaryField]) : markColor === "red";
        const sourceStatus = members.some((item) => item.__sourceStatus === "current") ? "current" : "recovered";
        const arrivedAt = latestIso(members.map((item: JsonObject) => recordOrderTimestamp(item)), now);
        const createdAt = earliestIso(members.map((item: JsonObject) => item.createdAt || item.updatedAt)) || arrivedAt;
        const updatedAt = latestIso(members.map((item: JsonObject) => item.updatedAt || item.createdAt), now);
        (await db.prepare("UPDATE email_bindings SET is_current=0, updated_at=? WHERE account_id=? AND is_current=1")
          .run(updatedAt, accountId));
        (await insertAccount.run(
          accountId, lifecycleStatus, deactivationLocked ? 1 : 0, deactivatedAt,
          everSold ? 1 : 0, plan, trialOnlyCorrected ? "" : legacyBillingChannel(latest.billingChannelOverride || latest.billingChannel || ""),
          trialOnlyCorrected ? "" : legacyBillingChannel(latest.billingChannelOverride || ""), String(latest.note || ""), String(latest.paymentLink || ""), credential.identity ? "confirmed" : "unknown",
          latest.hidePromotion ? 1 : 0,
          members.some((item: JsonObject) => item.domainMailbox) ? 1 : 0, suspectedUnused ? 1 : 0,
          markColor, groupBoundary ? 1 : 0, sourceStatus,
          arrivedAt, createdAt, updatedAt,
        ));
        (await upsertOrigin.run(accountId, members.some((item: JsonObject) => Boolean(item.autoFlag)) ? 1 : 0, createdAt,
          JSON.stringify({ currentLegacyId: latest.id, providers: [...new Set(members.map((item) => providerFor(item)))] })));
        (await upsertPreference.run(accountId, String(latest.label || ""), latest.showBilling ? 1 : 0,
          latest.showDeactivation ? 1 : 0, latest.hidePromotion ? 1 : 0,
          String(latest.statusMessage || ""), updatedAt));
        const flags = mailFlagEntries[latest.id] || {};
        const audit = usageAuditEntries[latest.id] || {};
        const flagMatches = flags.configKey === legacyEvidenceConfigKey(latest) && Number(flags.updatedAt) > 0;
        const auditMatches = audit.configKey === legacyEvidenceConfigKey(latest, true);
        const atIso = (value: unknown) => Number(value) > 0 ? new Date(Number(value)).toISOString() : "";
        const generation = Number(latest.recycleGeneration);
        (await db.prepare(`INSERT INTO account_business_evidence(account_id,hidden_tags_json,mail_verified_no_plus,mail_verified_at,
            recycle_generation,billing_started_at,last_activity_at,newest_mail_at,audit_binding_id,audited_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET hidden_tags_json=excluded.hidden_tags_json,
            mail_verified_no_plus=excluded.mail_verified_no_plus,mail_verified_at=excluded.mail_verified_at,
            recycle_generation=COALESCE(account_business_evidence.recycle_generation,excluded.recycle_generation),
            billing_started_at=CASE WHEN account_business_evidence.billing_started_at='' THEN excluded.billing_started_at
              WHEN excluded.billing_started_at='' THEN account_business_evidence.billing_started_at
              ELSE MIN(account_business_evidence.billing_started_at,excluded.billing_started_at) END,
            last_activity_at=MAX(account_business_evidence.last_activity_at,excluded.last_activity_at),
            newest_mail_at=MAX(account_business_evidence.newest_mail_at,excluded.newest_mail_at),
            audit_binding_id=excluded.audit_binding_id,audited_at=MAX(account_business_evidence.audited_at,excluded.audited_at),updated_at=excluded.updated_at`).run(
          accountId, JSON.stringify(normalizeHiddenTags(latest.hiddenTags)), flagMatches && !flags.hasPlus ? 1 : 0,
          flagMatches ? atIso(flags.updatedAt) : "", Number.isInteger(generation) && generation >= 0 ? generation : null,
          trialOnlyCorrected ? "" : atIso(audit.billingAt), auditMatches ? atIso(audit.lastActivityAt) : "", auditMatches ? atIso(audit.newestMailAt) : "",
          stableId("email-binding", latest.id), auditMatches ? atIso(audit.checkedAt) : "", now,
        ));
        if (!v1Authoritative && soldRebindAnomaly) {
          (await db.prepare(`UPDATE gpt_accounts SET quarantined_at=?, quarantine_reason='已售GPT身份在未停用状态下出现后续改绑', updated_at=? WHERE id=?`)
            .run(updatedAt, updatedAt, accountId));
          const latestEmail = normalizeEmail(latest.email || latest.login);
          (await insertReview.run(
            stableId("legacy-sold-rebind-anomaly", accountId), "legacy_sold_rebind_anomaly", accountId,
            encryptSecret(latestEmail), emailHash(latestEmail), "已售GPT身份在未停用状态下出现新绑定，已隔离并禁止二次出售",
            JSON.stringify({ firstSoldLegacyId: firstSold?.id, latestLegacyId: latest.id }), now, now,
          ));
        }

        const saleId = everSold ? stableId("legacy-sale", accountId) : "";
        for (const record of ordered) {
          const email = normalizeEmail(record.email || record.login);
          const parts = splitEmail(email);
          const provider = providerFor(record);
          const canonical = providerCanonical(record);
          const familyId = stableId("mailbox-family", provider, emailHash(canonical));
          (await insertFamily.run(familyId, provider, encryptSecret(canonical), emailHash(canonical), now, now));
          const bindingId = stableId("email-binding", record.id);
          bindingIdByLegacyId.set(record.id, bindingId);
          const window = bindingWindow.get(record.id) || { from: "", to: "", method: "legacy_mapping" };
          // A record recovered from a V1 backup is audit history, even when
          // that snapshot omitted mailNotAfter.  Letting it stay current can
          // create two current bindings for one identity after each rebuild.
          const isCurrent = !window.to && String(record.lifecycleStatus || "") !== "retired"
            && record.__sourceStatus !== "recovered";
          (await insertBinding.run(
            bindingId, accountId, familyId, encryptSecret(email), emailHash(email), parts.localPart, parts.domain, provider,
            window.from, window.to, isCurrent ? 1 : 0, window.method, record.id,
            JSON.stringify({ sourceStatus: record.__sourceStatus, sourcePath: record.__sourcePath,
              compatibility: { sourceEmail: String(record.sourceEmail || "").trim().slice(0, 320),
                toEmail: String(record.toEmail || email).trim().slice(0, 320),
                internalStatusMessage: String(record.internalStatusMessage || record.statusMessage || "").trim().slice(0, 500) } }),
            iso(record.createdAt, now), iso(record.updatedAt, now),
          ));
          const persistedBindingWindow = (await db.prepare("SELECT valid_from,valid_to FROM email_bindings WHERE id=?").get(bindingId)) as any;
          const receiveDisabledAt = iso(record.receiveDisabledAt || (record.receiveDisabled ? record.updatedAt || now : ""));
          (await db.prepare("UPDATE email_bindings SET receive_disabled_at=? WHERE id=?").run(receiveDisabledAt, bindingId));
          (await upsertSourceLink.run(String(record.id), "email_binding", bindingId, String(record.updatedAt || ""), now));
          const connectionProvider = record.outlookManagerEmail ? "outlook-manager"
            : record.address ? String(record.mailSource || "external") : provider;
          if (record.outlookManagerEmail || record.address) {
            (await upsertConnection.run(
              stableId("mailbox-connection", record.id), bindingId, familyId, connectionProvider,
              record.outlookManagerEmail ? emailHash(normalizeEmail(record.outlookManagerEmail)) : "",
              String(record.outlookManagerGroupId || ""), `v2:${bindingId}:mailbox`,
              receiveDisabledAt ? "disabled" : "active",
              JSON.stringify({ hasExternalAddress: Boolean(record.address), mailSource: String(record.mailSource || "") }),
              iso(record.createdAt, now), updatedAt,
            ));
            (await db.prepare("UPDATE mailbox_connections SET manager_email_enc=?,credentials_enc=? WHERE id=?").run(
              encryptSecret(normalizeEmail(record.outlookManagerEmail || "")),
              encryptSecret(JSON.stringify({ address: String(record.address || "") })), stableId("mailbox-connection", record.id),
            ));
          }
          const fromPatterns = Array.isArray(record.fromPatterns) ? record.fromPatterns.map(String) : [];
          const toPatterns = Array.isArray(record.toPatterns) ? record.toPatterns.map(String) : [];
          const recipientPatterns = toPatterns.length ? toPatterns : [mailboxRecipientPattern(normalizeEmail(record.toEmail || email))];
          if (provider === "icloud" && canonical !== email && (record.recycled || record.suffixRequired || record.openai4Private || record.recycledFromId || Number(record.recycleGeneration) > 0)) {
            recipientPatterns.push(mailboxRecipientPattern(canonical));
          }
          const senderPatterns = fromPatterns.length ? fromPatterns : record.sourceEmail ? [mailboxRecipientPattern(String(record.sourceEmail))]
            : [provider === "domain" ? LEGACY_DIRECT_SENDER_PATTERN : LEGACY_RELAY_SENDER_PATTERN];
          (await db.prepare("DELETE FROM mail_routing_rules WHERE binding_id=? AND source='legacy_v1'").run(bindingId));
          for (const [fromIndex, senderPattern] of senderPatterns.entries()) for (const [toIndex, recipientPattern] of [...new Set(recipientPatterns)].entries()) {
            (await upsertRoutingRule.run(stableId("mail-routing-rule", record.id, String(fromIndex), String(toIndex)), bindingId,
              senderPattern, recipientPattern,
              persistedBindingWindow.valid_from, persistedBindingWindow.valid_to, 100 - fromIndex - toIndex, iso(record.createdAt, now), updatedAt));
          }

          if (firstSold && record.id === firstSold.id) {
            const saleStartedAt = window.from || iso(record.createdAt, createdAt);
            const saleClosed = allRetired || soldRebindAnomaly || Boolean(window.to);
            const saleEndedAt = saleClosed ? (window.to || updatedAt) : "";
            (await insertSale.run(
              saleId, accountId, bindingId, saleClosed ? "closed" : "active", saleStartedAt, saleEndedAt,
              soldRebindAnomaly ? "sold_identity_rebound" : allRetired ? "account_retired" : window.to ? "binding_ended" : "",
              saleStartedAt, saleStartedAt, saleStartedAt, updatedAt,
            ));
          }

          const soldRecord = Boolean(record.sold);
          // V1 preset/login did not require a sale or an active GPT account.
          // Preserve existing customer credentials, but never create access for
          // synthetic/recovered records or explicitly reclaimed identities.
          const legacyCustomerAccess = soldRecord || Boolean(record.passwordHash || record.password);
          const restoredAt = iso(record.mailRestoredAt);
          const retiredBeforeRestore = latestIso([record.restoredFromRetiredAt, record.restoredFromMailNotAfter], "");
          const explicitlyRestored = record.lifecycleStatus === "active" && !record.retiredAt && !record.mailNotAfter
            && record.restoredFromLifecycleStatus === "retired" && restoredAt && retiredBeforeRestore
            && Date.parse(restoredAt) > Date.parse(retiredBeforeRestore) && isCurrent
            && window.from && Date.parse(window.from) >= Date.parse(restoredAt)
            && !records.some((other) => other.__sourceStatus !== "recovered" && other.id === record.recycledToId);
          const manuallyReclaimed = Boolean((record.recycledToId && !explicitlyRestored) || record.retiredAt)
            || String(record.lifecycleStatus || "") === "retired";
          let scope = legacyCustomerAccess ? (window.to ? "historical" : "current") : "admin_only";
          if (record.__sourceStatus === "recovered" || record.__synthetic || manuallyReclaimed) scope = "admin_only";
          const visibleTo = scope === "historical" ? iso(window.to) : "";
          const usedAt = soldRecord && scope !== "admin_only" ? (window.from || iso(record.createdAt, createdAt)) : "";
          const grantId = stableId("access-grant", record.id);
          (await insertGrant.run(
            grantId, accountId, bindingId, soldRecord ? saleId : null, digestToken(record.id), encryptSecret(record.id), emailHash(email), encryptSecret(email),
            String(record.passwordHash || record.password || ""), encryptSecret(String(record.passwordPlain || "")), scope,
            window.from, visibleTo, scope === "admin_only" ? 0 : 1, usedAt, usedAt, iso(record.createdAt, now), iso(record.updatedAt, now),
          ));
          if (manuallyReclaimed) {
            // Record the explicit action independently from the GPT lifecycle.
            // A later stale active snapshot must not recreate customer access.
            (await db.prepare(`UPDATE access_grants SET active=0,
              revoked_at=CASE WHEN revoked_at='' THEN ? ELSE revoked_at END,
              revoke_reason=CASE WHEN revoke_reason='' THEN 'legacy_admin_reclaimed' ELSE revoke_reason END
              WHERE id=?`).run(iso(record.retiredAt || window.to, updatedAt), grantId));
          }
          (await insertEvent.run(
            stableId("event-binding", record.id), accountId, bindingId, window.method.includes("rebind") ? "email_binding_changed" : "email_binding_imported",
            window.from || createdAt, "v1-shadow-import", JSON.stringify({ legacyMappingId: record.id, associationMethod: window.method }), now,
          ));
        }

        const subject = String(credential.identity || parseJwtSubject(credential.accessToken || credential.idToken));
        const subjectHash = subject ? sha256(subject) : "";
        const fingerprint = fingerprintAccessToken(credential.accessToken);
        const previousToken = accessTokenObservations.byAccount.get(accountId);
        const observedAt = fingerprint && previousToken?.fingerprint === fingerprint
          ? previousToken.firstSeenAt
          : accessTokenObservations.byFingerprint.get(fingerprint) || credential.updatedAt || now;
        const credentialBindingId = bindingIdByLegacyId.get(String(latest.id)) || null;
        if (credential.accessToken || credential.refreshToken || credential.idToken || credential.sessionToken) {
          (await observeCredentialVersion({
            accountId, bindingId: credentialBindingId, accessToken: credential.accessToken,
            refreshToken: credential.refreshToken, idToken: credential.idToken, sessionToken: credential.sessionToken,
            openaiPassword: credential.openaiPassword, subjectHash, source: String(credential.source || "v1-shadow-import"),
            observedAt, validityStatus: credential.accessToken ? "alive" : "unknown",
            evidence: { legacyMappingId: latest.id, incrementalProjection: true }, observationKey: String(latest.id),
            allowAccountMutation: !v1Authoritative,
          }));
        } else if (credentialBindingId) {
          (await invalidateCurrentCredentialWithoutCurrentBindingObservation(accountId, credentialBindingId, updatedAt));
        }
        if (subjectHash) (await insertIdentity.run(
          stableId("legacy-identity", accountId, subjectHash), accountId, subjectHash, String(credential.source || "legacy-v1"),
          createdAt, updatedAt, JSON.stringify({ importedFrom: "v1-shadow", credentialEmail: credential.email || "" }),
        ));
        if (deactivationLocked) {
          (await insertEvent.run(
            stableId("event-deactivation", accountId, deactivatedAt || "locked"), accountId, null, "account_deactivated",
            deactivatedAt, "v1-shadow-import", JSON.stringify({ immutable: true, timePending: !deactivatedAt }), now,
          ));
        }
        const persistedLock = (await db.prepare("SELECT deactivation_locked,deactivated_at FROM gpt_accounts WHERE id=?").get(accountId)) as any;
        if (persistedLock?.deactivation_locked) {
          (await freezeAccountTransition(accountId, "legacy_migration_preserved_lock", "v2-offline-migration", String(persistedLock.deactivated_at || "")));
        }
      }

      const restorePaymentExposureJob = db.prepare(`INSERT INTO payment_exposure_jobs(
        job_id, account_id, route_key, target, ip_country, billing_country, billing_currency,
        job_kind, access_token_fingerprint, scheduled_at, status, last_error, started_at, finished_at, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET account_id=excluded.account_id, status=excluded.status,
        last_error=excluded.last_error, started_at=excluded.started_at, finished_at=excluded.finished_at,
        updated_at=excluded.updated_at`);
      for (const job of paymentExposureJobBackups) {
        if (!graph.groups.has(job.accountId)) continue;
        (await restorePaymentExposureJob.run(
          job.jobId, job.accountId, job.routeKey, job.target, job.ipCountry, job.billingCountry, job.billingCurrency,
          job.jobKind, job.accessTokenFingerprint, job.scheduledAt, job.status, job.lastError, job.startedAt, job.finishedAt, job.createdAt || now, job.updatedAt || now,
        ));
      }

      const findPaymentExposureByLogicalKey = db.prepare(`SELECT id FROM payment_exposure_checks
        WHERE account_id=? AND target=? AND ip_country=? AND billing_country=? AND billing_currency=?`);
      const findPaymentExposureById = db.prepare("SELECT id FROM payment_exposure_checks WHERE id=?");
      const updatePaymentExposure = db.prepare(`UPDATE payment_exposure_checks SET
        account_id=?, target=?, ip_country=?, billing_country=?, billing_currency=?, expected_method=?,
        available_methods_json=?, matched_methods_json=?, payment_methods_json=?, trial_status=?, exposed=?, status=?,
        checkout_type=?, detail=?, promo_eligible=?, promo_campaign=?, observed_at=?, source=?, created_at=?, updated_at=?
        WHERE id=?`);
      const insertPaymentExposure = db.prepare(`INSERT INTO payment_exposure_checks(
        id, account_id, target, ip_country, billing_country, billing_currency, expected_method,
        available_methods_json, matched_methods_json, payment_methods_json, trial_status, exposed, status, checkout_type, detail,
        promo_eligible, promo_campaign, observed_at, source, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const backup of paymentExposureBackups) {
        const accountId = resolveProjectionAccount(backup);
        if (!accountId) continue;
        const logical = (await findPaymentExposureByLogicalKey.get(
          accountId, backup.target, backup.ipCountry, backup.billingCountry, backup.billingCurrency,
        )) as any;
        const byId = (await findPaymentExposureById.get(backup.id)) as any;
        const existingId = String(logical?.id || byId?.id || "");
        const values = [
          accountId, backup.target, backup.ipCountry, backup.billingCountry, backup.billingCurrency, backup.expectedMethod,
          backup.availableMethodsJson, backup.matchedMethodsJson, backup.paymentMethodsJson, backup.trialStatus, backup.exposed, backup.status,
          backup.checkoutType, backup.detail, backup.promoEligible, backup.promoCampaign, backup.observedAt, backup.source,
          backup.createdAt || now, backup.updatedAt || now,
        ];
        if (existingId) (await updatePaymentExposure.run(...values, existingId));
        else (await insertPaymentExposure.run(backup.id, ...values));
        paymentExposureRestoredCount += 1;
      }

      if ((await promoEligibilityTableExists())) {
        const insertPromoEligibility = db.prepare(`INSERT INTO promo_eligibility_checks(
          id, account_id, access_token_fingerprint, check_kind, status, eligible, campaign, evidence,
          method, endpoint, upstream_status, duration_ms, error, scheduled_at, checked_at, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, status=excluded.status,
          eligible=excluded.eligible, evidence=excluded.evidence, upstream_status=excluded.upstream_status,
          duration_ms=excluded.duration_ms, error=excluded.error, checked_at=excluded.checked_at`);
        for (const backup of promoEligibilityBackups) {
          const accountId = resolveProjectionAccount(backup);
          if (!accountId) continue;
          (await insertPromoEligibility.run(
            backup.id, accountId, backup.accessTokenFingerprint, backup.checkKind, backup.status, backup.eligible,
            backup.campaign, backup.evidence, backup.method, backup.endpoint, backup.upstreamStatus, backup.durationMs,
            backup.error, backup.scheduledAt, backup.checkedAt, backup.createdAt || now,
          ));
          promoEligibilityRestoredCount += 1;
        }
      }

      for (const conflict of v1Authoritative ? [] : graph.conflicts) {
        const candidate = records.find((record) => conflict.recordIds.includes(record.id));
        const candidateEmail = normalizeEmail(candidate?.email || candidate?.login);
        const candidateAccounts = [...new Set(conflict.recordIds.map((id) => graph.accountIdByLegacyId.get(id)).filter(Boolean))] as string[];
        (await insertReview.run(
          stableId("legacy-association-conflict", ...conflict.recordIds.sort()), "legacy_association_conflict", candidateAccounts[0] || null,
          encryptSecret(candidateEmail), candidateEmail ? emailHash(candidateEmail) : stableId("legacy-conflict-email", ...conflict.recordIds),
          conflict.reason, JSON.stringify({ recordIds: conflict.recordIds, candidateAccountIds: candidateAccounts, localPart: conflict.localPart }), now, now,
        ));
      }

      const duplicateEmails = v1Authoritative ? [] : (await db.prepare(`SELECT email_hash, GROUP_CONCAT(DISTINCT account_id) AS account_ids
        FROM email_bindings GROUP BY email_hash HAVING COUNT(DISTINCT account_id)>1`).all()) as Array<{ email_hash: string; account_ids: string }>;
      for (const duplicate of duplicateEmails) {
        const accountIds = String(duplicate.account_ids || "").split(",").filter(Boolean);
        const sample = (await db.prepare("SELECT email_enc FROM email_bindings WHERE email_hash=? LIMIT 1").get(duplicate.email_hash)) as any;
        for (const duplicateAccountId of accountIds) {
          const account = (await db.prepare("SELECT source_status, deactivation_locked FROM gpt_accounts WHERE id=?").get(duplicateAccountId)) as any;
          if (String(account?.source_status) === "recovered" && !Number(account?.deactivation_locked)) {
            (await db.prepare(`UPDATE gpt_accounts SET lifecycle_status='retired', retired_at=CASE WHEN retired_at='' THEN ? ELSE retired_at END,
              quarantined_at='', quarantine_reason='', updated_at=? WHERE id=?`).run(now, now, duplicateAccountId));
          }
          (await insertReview.run(
            stableId("legacy-duplicate-email", duplicate.email_hash, duplicateAccountId), "legacy_duplicate_email", duplicateAccountId,
            String(sample?.email_enc || ""), duplicate.email_hash, "同一邮箱存在多条历史身份链；保持分离，等待结合回收关系和OpenAI身份时间线核对",
            JSON.stringify({ candidateAccountIds: accountIds, automaticQuarantine: false }), now, now,
          ));
        }
      }

      const insertRelation = db.prepare(`INSERT OR IGNORE INTO account_relations(
        id, relation_type, from_account_id, to_account_id, changed_at, association_method, evidence_json, status, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertBindingTransition = db.prepare(`INSERT OR IGNORE INTO binding_transitions(
        id, account_id, from_binding_id, to_binding_id, changed_at, method, task_id, evidence_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, '', ?, ?)`);
      for (const pair of graph.inferredRebindPairs) {
        const accountId = graph.accountIdByLegacyId.get(pair.previousId);
        if (!accountId || accountId !== graph.accountIdByLegacyId.get(pair.nextId)) continue;
        const previousBindingId = bindingIdByLegacyId.get(pair.previousId);
        const nextBindingId = bindingIdByLegacyId.get(pair.nextId);
        if (!previousBindingId || !nextBindingId) continue;
        (await insertBindingTransition.run(
          stableId("relation-rebind", pair.previousId, pair.nextId), accountId, previousBindingId, nextBindingId,
          iso(pair.changedAt, now), pair.method, JSON.stringify({ ruleVersion: 2, source: "v1-incremental" }), now,
        ));
      }
      const seenRecycle = new Set<string>();
      for (const record of records) {
        const nextLegacyId = String(record.recycledToId || "");
        const previousLegacyId = String(record.recycledFromId || "");
        const leftId = nextLegacyId ? record.id : previousLegacyId;
        const rightId = nextLegacyId || record.id;
        if (!leftId || !rightId) continue;
        const fromAccountId = graph.accountIdByLegacyId.get(leftId);
        const toAccountId = graph.accountIdByLegacyId.get(rightId);
        if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) continue;
        const key = `${fromAccountId}:${toAccountId}`;
        if (seenRecycle.has(key)) continue;
        seenRecycle.add(key);
        (await insertRelation.run(
          stableId("relation-recycle", fromAccountId, toAccountId), "mailbox_recycle", fromAccountId, toAccountId,
          iso(record.retiredAt || record.updatedAt, now), "legacy_recycle_chain", JSON.stringify({ leftId, rightId }), "confirmed", now,
        ));
      }

      const insertMessage = db.prepare(`INSERT INTO mail_messages(
        id, provider, provider_message_id, sender, recipient_enc, subject, received_at, folder, category, is_security, metadata_json, indexed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, provider_message_id) DO UPDATE SET sender=excluded.sender,
        recipient_enc=excluded.recipient_enc, subject=excluded.subject, received_at=excluded.received_at,
        folder=excluded.folder, category=excluded.category, is_security=excluded.is_security,
        metadata_json=excluded.metadata_json, indexed_at=excluded.indexed_at`);
      const insertClaim = db.prepare(`INSERT INTO mail_ownership_claims(
        message_id, account_id, binding_id, claim_type, confidence, reason, visible_to_customer, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id, binding_id) DO UPDATE SET account_id=excluded.account_id,
        claim_type=excluded.claim_type, confidence=excluded.confidence, reason=excluded.reason,
        visible_to_customer=excluded.visible_to_customer`);
      const explicitRebindWindows = graph.inferredRebindPairs
        .filter((pair) => pair.method === "legacy_explicit_rebind")
        .map((pair) => ({
          ...pair,
          changedMs: Date.parse(String(pair.changedAt || "")),
          accountId: graph.accountIdByLegacyId.get(pair.previousId) || "",
          targetAccountId: graph.accountIdByLegacyId.get(pair.nextId) || "",
          bindingId: bindingIdByLegacyId.get(pair.previousId) || "",
        }))
        .filter((pair) => pair.accountId && pair.accountId === pair.targetAccountId && pair.bindingId && Number.isFinite(pair.changedMs));
      for (const [legacyId, entry] of Object.entries(mailIndex)) {
        const accountId = graph.accountIdByLegacyId.get(legacyId);
        const bindingId = bindingIdByLegacyId.get(legacyId);
        if (!accountId || !bindingId) continue;
        const record = latestById.get(legacyId) as JsonObject | undefined;
        const external = parseExternalMailbox(record?.address);
        const provider = record?.outlookManagerEmail ? `outlook:${emailHash(normalizeEmail(record.outlookManagerEmail))}`
          : external ? `external:${external.provider}:${emailHash(external.email)}` : "shared-mail-api";
        for (const mail of Array.isArray(entry?.mails) ? entry.mails : []) {
          let providerMessageId = String(mail.detailId || mail.id || "");
          if (record?.outlookManagerEmail) {
            const wrapper = `outlook-${String(mail.folder || "inbox")}-`;
            if (providerMessageId.startsWith(wrapper)) providerMessageId = providerMessageId.slice(wrapper.length);
          }
          if (external && providerMessageId.startsWith(`${external.provider}-`)) providerMessageId = providerMessageId.slice(external.provider.length + 1);
          if (!providerMessageId) continue;
          const messageId = stableId("mail-message", provider, providerMessageId);
          const classification = classifyMail(String(mail.subject || ""), String(mail.from || mail.source || ""));
          const receivedAt = iso(mail.created_at_utc || mail.created_at, String(mail.created_at_utc || mail.created_at || ""));
          const receivedMs = Date.parse(receivedAt);
          const taskWindow = Number.isFinite(receivedMs) ? explicitRebindWindows
            .filter((pair) => legacyId !== pair.nextId && (
              (classification.category === "rebind" && Math.abs(pair.changedMs - receivedMs) <= 15 * 60 * 1000)
              || (classification.category === "security" && receivedMs <= pair.changedMs && pair.changedMs - receivedMs <= 10 * 60 * 1000)
            ))
            .sort((left, right) => Math.abs(left.changedMs - receivedMs) - Math.abs(right.changedMs - receivedMs))[0] : null;
          const claimAccountId = taskWindow?.accountId || accountId;
          const claimBindingId = taskWindow?.bindingId || bindingId;
          (await insertMessage.run(
            messageId, provider, providerMessageId, String(mail.from || mail.source || ""), encryptSecret(String(mail.to || "")),
            String(mail.subject || "(无主题)"), receivedAt, String(mail.folder || "inbox"),
            classification.category, classification.isSecurity ? 1 : 0,
            JSON.stringify({ legacyAddress: Boolean(mail.address), source: "v1-mail-index", ...(classification.category === "rebind" ? { rebindNotification: true } : {}) }), now,
          ));
          (await insertClaim.run(
            messageId, claimAccountId, claimBindingId,
            taskWindow ? "explicit_rebind_task_window" : "legacy_mapping_index",
            taskWindow ? 1.25 : 1,
            taskWindow ? "邮件时间与明确换绑任务窗口一致，归属于被换绑的GPT身份" : "V1 indexed this message for the mapping",
            1, now,
          ));
          if (classification.category === "rebind") {
            (await insertEvent.run(
              stableId("event-email-rebind-notice", messageId), claimAccountId, claimBindingId, "email_rebind_notice_detected",
              receivedAt || now, "v1-mail-index", JSON.stringify({ messageId, legacyId, subject: String(mail.subject || ""), taskMatched: Boolean(taskWindow) }), now,
            ));
          }
        }
      }

      (await db.prepare(`UPDATE mail_ownership_claims SET visible_to_customer=0
        WHERE message_id IN (
          SELECT message_id FROM (
            SELECT message_id FROM mail_ownership_claims GROUP BY message_id
            HAVING count(DISTINCT account_id)>1
              AND SUM(CASE WHEN claim_type<>'legacy_mapping_index' THEN 1 ELSE 0 END)>0
          ) AS ambiguous_claims
        )`).run());

      (await db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES('v1_source_hash', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(sourceHash, now));
      (await db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES('v1_source_count', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(String(currentRecords.length), now));
    });

    (await transaction());
    const counts = (await db.prepare(`SELECT
      (SELECT COUNT(*) FROM gpt_accounts) AS accounts,
      (SELECT COUNT(*) FROM email_bindings) AS bindings,
      (SELECT COUNT(*) FROM account_relations) AS relations,
      (SELECT COUNT(*) FROM gpt_accounts WHERE source_status='recovered') AS recovered,
      (SELECT COUNT(*) FROM routing_endpoints) AS routing,
      (SELECT COUNT(*) FROM mail_messages) AS messages`).get()) as any;
    const finishedAt = new Date().toISOString();
    (await db.prepare(`UPDATE shadow_sync_runs SET finished_at=?, source_hash=?, source_count=?, account_count=?, binding_count=?,
      relation_count=?, recovered_count=?, status='ok', detail_json=? WHERE id=?`).run(
      finishedAt, sourceHash, currentRecords.length, counts.accounts, counts.bindings, counts.relations, counts.recovered,
      JSON.stringify({ routingCount: counts.routing, messageCount: counts.messages }), runId,
    ));
    return {
      runId,
      sourceCount: currentRecords.length,
      accountCount: counts.accounts,
      bindingCount: counts.bindings,
      relationCount: counts.relations,
      recoveredCount: counts.recovered,
      routingCount: counts.routing,
      messageCount: counts.messages,
      paymentExposureRestoredCount,
      promoEligibilityRestoredCount,
      sourceHash,
    };
  } catch (error) {
    (await db.prepare("UPDATE shadow_sync_runs SET finished_at=?, status='error', detail_json=? WHERE id=?")
      .run(new Date().toISOString(), JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), runId));
    throw error;
  }
}
