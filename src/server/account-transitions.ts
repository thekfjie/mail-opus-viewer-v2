import { asyncFilter } from './async-collections.js';
import crypto from "node:crypto";
import { customerGrantBlockReason } from "../shared/customer-access-policy.js";
import { emailHash, normalizeEmail, splitEmail, stableId } from "./association.js";
import { config } from "./config.js";
import { decryptSecret, digestToken, encryptSecret, hashPassword } from "./crypto.js";
import { db } from "./db.js";
import { LEGACY_RELAY_SENDER_PATTERN, mailboxRecipientPattern } from "./business-evidence.js";

type JsonObject = Record<string, unknown>;

function boolean(value: unknown): boolean {
  return Boolean(Number(value));
}

function nowIso(value = ""): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

export function mailboxProvider(email: string): string {
  const domain = splitEmail(email).domain;
  if (domain === "icloud.com" || domain.endsWith(".icloud.com")) return "icloud";
  if (/(?:outlook|hotmail|live)\./i.test(domain)) return "outlook";
  return "domain";
}

export function isTrustedRebindDomain(domainInput: string): boolean {
  const domain = String(domainInput || "").trim().toLowerCase();
  return config.trustedRebindDomains.some((trusted) => domain === trusted || domain.endsWith(`.${trusted}`));
}

async function addEvent(accountId: string, bindingId: string | null, eventType: string, occurredAt: string, source: string, payload: JsonObject): Promise<void> {
  (await db.prepare(`INSERT INTO lifecycle_events(id, account_id, binding_id, event_type, occurred_at, source, payload_json, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), accountId, bindingId, eventType, occurredAt, source, JSON.stringify(payload), new Date().toISOString(),
  ));
}

async function addReview(reviewType: string, accountId: string | null, email: string, reason: string, evidence: JsonObject): Promise<void> {
  const now = new Date().toISOString();
  const candidateHash = email ? emailHash(email) : stableId("review-candidate", reviewType, accountId || "none", reason);
  const id = stableId("pending-review", reviewType, accountId || "none", candidateHash);
  (await db.prepare(`INSERT INTO pending_reviews(id, review_type, account_id, candidate_email_enc, candidate_email_hash, status, reason, evidence_json, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status='pending', reason=excluded.reason,
      evidence_json=excluded.evidence_json, candidate_email_enc=excluded.candidate_email_enc, updated_at=excluded.updated_at`).run(
    id, reviewType, accountId, encryptSecret(email), candidateHash, reason, JSON.stringify(evidence), now, now,
  ));
}

async function insertAdminOnlyGrant(accountId: string, bindingId: string, email: string, now: string): Promise<void> {
  const password = crypto.randomBytes(18).toString("base64url");
  (await db.prepare(`INSERT INTO access_grants(id, account_id, binding_id, public_token_hash, login_identifier_hash, login_identifier_enc,
    password_hash, password_plain_enc, scope, active, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'admin_only', 0, ?, ?)`).run(
    crypto.randomUUID(), accountId, bindingId, digestToken(crypto.randomUUID()), emailHash(email), encryptSecret(email),
    hashPassword(password), encryptSecret(password), now, now,
  ));
}

async function closeSale(accountId: string, cutoff: string, reason: string): Promise<void> {
  (await db.prepare(`UPDATE sales SET status='closed', ended_at=CASE WHEN ended_at='' THEN ? ELSE ended_at END,
    end_reason=CASE WHEN end_reason='' THEN ? ELSE end_reason END, updated_at=?
    WHERE account_id=? AND status='active'`).run(cutoff, reason, cutoff, accountId));
}

async function preserveHistoricalCustomerAccess(bindingId: string, cutoff: string): Promise<void> {
  // A rebind ends this mailbox window, but does not revoke its existing link.
  // This also applies before the customer's first visit. No grant moves to
  // the replacement binding; only an explicit reclaim/revoke ends access.
  (await db.prepare(`UPDATE access_grants SET
      scope='historical',
      visible_to=CASE WHEN visible_to='' OR julianday(visible_to)>julianday(?) THEN ? ELSE visible_to END,
      updated_at=?
    WHERE binding_id=? AND active=1 AND scope!='admin_only'`).run(cutoff, cutoff, cutoff, bindingId));
}

async function revokeActiveCustomerAccess(accountId: string, at: string, reason: string): Promise<void> {
  (await db.prepare(`UPDATE access_grants SET active=0, revoked_at=CASE WHEN revoked_at='' THEN ? ELSE revoked_at END,
    revoke_reason=CASE WHEN revoke_reason='' THEN ? ELSE revoke_reason END, updated_at=?
    WHERE account_id=? AND active=1 AND scope!='admin_only'`).run(at, reason, at, accountId));
}

export interface AccountMatch {
  kind: "account" | "new" | "conflict";
  accountId: string;
  method: string;
  reason: string;
  candidateAccountIds: string[];
}

async function identityAccounts(subjectHash: string): Promise<string[]> {
  if (!subjectHash) return [];
  const rows = (await db.prepare(`SELECT DISTINCT account_id FROM (
      SELECT account_id FROM openai_identity_observations WHERE subject_hash=? AND status='confirmed'
      UNION ALL SELECT account_id FROM credentials WHERE openai_subject_hash=?
    ) AS identity_matches LIMIT 4`).all(subjectHash, subjectHash)) as Array<{ account_id: string }>;
  return [...new Set(rows.map((row) => String(row.account_id)))];
}

async function accountSubjects(accountId: string): Promise<string[]> {
  const rows = (await db.prepare(`SELECT subject_hash FROM openai_identity_observations WHERE account_id=? AND status='confirmed'
    UNION SELECT openai_subject_hash AS subject_hash FROM credentials WHERE account_id=? AND openai_subject_hash!=''`).all(accountId, accountId)) as Array<{ subject_hash: string }>;
  return [...new Set(rows.map((row) => String(row.subject_hash)).filter(Boolean))];
}

async function recycleLineageContains(startAccountId: string, candidateAccountId: string): Promise<boolean> {
  if (!startAccountId || !candidateAccountId) return false;
  if (startAccountId === candidateAccountId) return true;
  const seen = new Set<string>([startAccountId]);
  const pending = [startAccountId];
  while (pending.length && seen.size <= 64) {
    const current = pending.shift()!;
    const rows = (await db.prepare(`SELECT from_account_id, to_account_id FROM account_relations
      WHERE relation_type='mailbox_recycle' AND status='confirmed'
        AND (from_account_id=? OR to_account_id=?)`).all(current, current)) as Array<{ from_account_id: string; to_account_id: string }>;
    for (const row of rows) {
      for (const next of [String(row.from_account_id), String(row.to_account_id)]) {
        if (seen.has(next)) continue;
        if (next === candidateAccountId) return true;
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return false;
}

export async function resolveAccountMatch(subjectHash: string, emailInput: string): Promise<AccountMatch> {
  const email = normalizeEmail(emailInput);
  const parts = splitEmail(email);
  const exact = email ? (await db.prepare("SELECT account_id, is_current FROM email_bindings WHERE email_hash=? LIMIT 8").all(emailHash(email))) as Array<{ account_id: string; is_current: number }> : [];
  const exactIds = [...new Set(exact.map((row) => String(row.account_id)))];
  const exactCurrentIds = [...new Set(exact.filter((row) => Boolean(row.is_current)).map((row) => String(row.account_id)))];
  const identityIds = (await identityAccounts(subjectHash));
  if (identityIds.length === 1 && exactIds.length > 1 && exactCurrentIds.length === 0
    && exactIds.every(async (accountId) => (await recycleLineageContains(identityIds[0], accountId)))) {
    return {
      kind: "account", accountId: identityIds[0], method: "recycled_mailbox_identity",
      reason: "", candidateAccountIds: [...new Set([...exactIds, ...identityIds])],
    };
  }
  if (exactIds.length > 1 || identityIds.length > 1) {
    return { kind: "conflict", accountId: "", method: "ambiguous", reason: "邮箱或OpenAI身份命中多个GPT账号", candidateAccountIds: [...new Set([...exactIds, ...identityIds])] };
  }
  if (exactIds.length === 1 && identityIds.length === 1 && exactIds[0] !== identityIds[0]) {
    if (exactCurrentIds.length === 0 && (await recycleLineageContains(identityIds[0], exactIds[0]))) {
      return {
        kind: "account", accountId: identityIds[0], method: "recycled_mailbox_identity",
        reason: "", candidateAccountIds: [...new Set([...exactIds, ...identityIds])],
      };
    }
    return { kind: "conflict", accountId: exactIds[0], method: "identity_email_conflict", reason: "邮箱与OpenAI身份分别属于不同GPT账号", candidateAccountIds: [...exactIds, ...identityIds] };
  }
  if (exactIds.length === 1) {
    const known = (await accountSubjects(exactIds[0]));
    if (subjectHash && known.length && !known.includes(subjectHash)) {
      return { kind: "conflict", accountId: exactIds[0], method: "contradictory_identity", reason: "相同邮箱出现了不同OpenAI身份", candidateAccountIds: exactIds };
    }
    return { kind: "account", accountId: exactIds[0], method: identityIds.length ? "identity_and_email" : "exact_email", reason: "", candidateAccountIds: exactIds };
  }
  if (identityIds.length === 1) return { kind: "account", accountId: identityIds[0], method: "openai_identity", reason: "", candidateAccountIds: identityIds };
  if (!parts.localPart || !isTrustedRebindDomain(parts.domain)) {
    return { kind: "new", accountId: "", method: "none", reason: "", candidateAccountIds: [] };
  }
  const localRows = (await db.prepare(`SELECT DISTINCT b.account_id FROM email_bindings b
    JOIN gpt_accounts a ON a.id=b.account_id
    WHERE b.local_part=? AND b.is_current=1 AND a.deleted_at='' LIMIT 4`).all(parts.localPart)) as Array<{ account_id: string }>;
  const trustedIds = [...new Set((await asyncFilter(localRows.map((row) => String(row.account_id)), async (accountId) => {
    const current = (await db.prepare("SELECT domain FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId)) as any;
    return current && isTrustedRebindDomain(String(current.domain));
  })))];
  if (trustedIds.length > 1) return { kind: "conflict", accountId: "", method: "trusted_local_ambiguous", reason: "可信域同前缀命中多个GPT账号", candidateAccountIds: trustedIds };
  if (trustedIds.length === 1) {
    const known = (await accountSubjects(trustedIds[0]));
    if (subjectHash && known.length && !known.includes(subjectHash)) {
      return { kind: "conflict", accountId: trustedIds[0], method: "trusted_local_identity_conflict", reason: "同前缀候选账号的OpenAI身份不一致", candidateAccountIds: trustedIds };
    }
    return { kind: "account", accountId: trustedIds[0], method: "trusted_exact_local_part", reason: "", candidateAccountIds: trustedIds };
  }
  return { kind: "new", accountId: "", method: "none", reason: "", candidateAccountIds: [] };
}

export async function recordIdentityObservation(accountId: string, subjectHash: string, source: string, evidence: JsonObject = {}): Promise<{ conflict: boolean }> {
  if (!subjectHash) return { conflict: false };
  const others = (await identityAccounts(subjectHash)).filter((id) => id !== accountId);
  const now = new Date().toISOString();
  if (others.length) {
    (await quarantineAccount(accountId, "OpenAI身份与其他GPT账号冲突", source, { subjectHash, otherAccountIds: others, ...evidence }));
    (await addReview("openai_identity_conflict", accountId, "", "同一OpenAI身份出现在不同GPT账号，已自动隔离当前账号", { subjectHash, otherAccountIds: others, ...evidence }));
    return { conflict: true };
  }
  (await db.prepare(`INSERT INTO openai_identity_observations(id, account_id, subject_hash, source, status, first_seen_at, last_seen_at, evidence_json)
    VALUES(?, ?, ?, ?, 'confirmed', ?, ?, ?)
    ON CONFLICT(account_id, subject_hash) DO UPDATE SET source=excluded.source, status='confirmed',
      last_seen_at=excluded.last_seen_at, evidence_json=excluded.evidence_json`).run(
    stableId("openai-identity-observation", accountId, subjectHash), accountId, subjectHash, source, now, now, JSON.stringify(evidence),
  ));
  (await db.prepare("UPDATE gpt_accounts SET identity_status='confirmed', updated_at=? WHERE id=? AND identity_status!='conflict'").run(now, accountId));
  return { conflict: false };
}

export async function quarantineAccount(accountId: string, reason: string, source = "system", evidence: JsonObject = {}): Promise<void> {
  const account = (await db.prepare("SELECT * FROM gpt_accounts WHERE id=? AND deleted_at='' ").get(accountId)) as any;
  if (!account) return;
  const now = new Date().toISOString();
  if (String(account.identity_status || "") === "conflict") {
    (await revokeActiveCustomerAccess(accountId, now, "identity_conflict"));
    (await closeSale(accountId, now, "identity_conflict"));
    return;
  }
  (await db.transaction(async () => {
    (await revokeActiveCustomerAccess(accountId, now, "identity_conflict"));
    (await closeSale(accountId, now, "identity_conflict"));
    (await db.prepare(`UPDATE gpt_accounts SET lifecycle_status=CASE WHEN deactivation_locked=1 THEN 'deactivated' ELSE 'quarantined' END,
      identity_status='conflict', quarantined_at=CASE WHEN quarantined_at='' THEN ? ELSE quarantined_at END,
      quarantine_reason=?, updated_at=? WHERE id=?`).run(now, String(reason).slice(0, 1000), now, accountId));
    (await addEvent(accountId, null, "account_quarantined", now, source, { reason, ...evidence }));
  })());
}

export async function freezeAccountTransition(accountId: string, reason = "admin_manual", source = "v2-admin", triggerReceivedAt?: string): Promise<void> {
  const account = (await db.prepare("SELECT * FROM gpt_accounts WHERE id=? AND deleted_at='' ").get(accountId)) as any;
  if (!account) throw new Error("账号不存在");
  const alreadyLocked = boolean(account.deactivation_locked);
  const administratorInitiated = source === "v2-admin" || source.startsWith("v2-admin:");
  const alreadyAdministratorStopped = Boolean(String(account.admin_deactivated_at || ""));
  const confirmedTimes = [account.deactivated_at, triggerReceivedAt].map((value) => Date.parse(String(value || ""))).filter(Number.isFinite);
  const now = nowIso();
  const occurredAt = confirmedTimes.length ? new Date(Math.min(...confirmedTimes)).toISOString()
    : alreadyLocked || triggerReceivedAt !== undefined ? "" : now;
  (await db.transaction(async () => {
    (await db.prepare(`UPDATE gpt_accounts SET lifecycle_status='deactivated', deactivation_locked=1,
      deactivated_at=?, admin_deactivated_at=CASE WHEN ?=1 AND admin_deactivated_at='' THEN ? ELSE admin_deactivated_at END,
      updated_at=? WHERE id=?`).run(occurredAt, Number(administratorInitiated), now, now, accountId));
    // A manual administrator stop is the customer mailbox boundary. Existing
    // messages remain visible, while mail received after this exact action is
    // excluded from both list and detail APIs.
    if (administratorInitiated) {
      (await db.prepare(`UPDATE email_bindings SET receive_disabled_at=CASE
          WHEN receive_disabled_at='' OR julianday(receive_disabled_at)>julianday(?) THEN ? ELSE receive_disabled_at END,
        updated_at=? WHERE account_id=? AND is_current=1`).run(now, now, now, accountId));
    }
    if (alreadyLocked && (!administratorInitiated || alreadyAdministratorStopped)) return;
    (await addEvent(accountId, null, "account_deactivated", occurredAt, source,
      { immutable: true, reason: String(reason).slice(0, 500), administratorInitiated,
        customerAccessPreserved: true, customerMailStoppedAt: administratorInitiated ? now : "" }));
  })());
}

// "删除" in the admin UI is deliberately a soft delete.  The GPT identity,
// bindings, mail claims and lifecycle events remain in SQLite for audit and
// recovery; the account is only removed from normal list/customer queries.
// Customer access is revoked first so a deleted record can never continue to
// receive mail through an already-issued grant.
export async function deleteAccountTransition(accountId: string, reason = "admin_bulk_delete", source = "v2-admin"): Promise<void> {
  const account = (await db.prepare("SELECT * FROM gpt_accounts WHERE id=? AND deleted_at='' ").get(accountId)) as any;
  if (!account) throw new Error("账号不存在或已经删除");
  const now = new Date().toISOString();
  (await db.transaction(async () => {
    (await revokeActiveCustomerAccess(accountId, now, "account_deleted"));
    (await closeSale(accountId, now, "account_deleted"));
    (await db.prepare(`UPDATE gpt_accounts SET lifecycle_status='deleted', deleted_at=?, updated_at=? WHERE id=? AND deleted_at=''`)
      .run(now, now, accountId));
    (await addEvent(accountId, null, "account_deleted", now, source, {
      softDelete: true,
      immutableHistory: true,
      reason: String(reason || "admin_bulk_delete").slice(0, 500),
    }));
  })());
}

export interface RebindOptions {
  source?: string;
  associationMethod?: string;
  changedAt?: string;
  evidence?: JsonObject;
  explicitPreviousEmail?: string;
}

export async function rebindAccountTransition(accountId: string, newEmailInput: string, options: RebindOptions = {}): Promise<{ bindingId: string; changed: boolean }> {
  const account = (await db.prepare("SELECT * FROM gpt_accounts WHERE id=? AND deleted_at='' ").get(accountId)) as any;
  if (!account) throw new Error("账号不存在");
  const newEmail = normalizeEmail(newEmailInput);
  const parts = splitEmail(newEmail);
  if (!parts.localPart || !parts.domain) throw new Error("新邮箱格式无效");
  const current = (await db.prepare("SELECT * FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId)) as any;
  if (!current) throw new Error("账号没有当前邮箱绑定");
  if (String(current.email_hash) === emailHash(newEmail)) return { bindingId: String(current.id), changed: false };
  const explicitPrevious = normalizeEmail(options.explicitPreviousEmail || "");
  if (explicitPrevious && emailHash(explicitPrevious) !== String(current.email_hash)) throw new Error("明确改绑来源不是当前邮箱");
  if (String(current.local_part) !== parts.localPart && !explicitPrevious) throw new Error("完整本地部分不一致，不能改绑");
  if (boolean(account.sold) && !boolean(account.deactivation_locked)) throw new Error("已售且未停用的GPT账号不允许改绑；请先人工确认异常");
  const owners = (await db.prepare("SELECT DISTINCT account_id FROM email_bindings WHERE email_hash=?").all(emailHash(newEmail))) as Array<{ account_id: string }>;
  if (owners.some((row) => String(row.account_id) !== accountId)) throw new Error("新邮箱属于其他GPT账号，禁止改绑");
  const changedAt = nowIso(options.changedAt || "");
  const bindingId = crypto.randomUUID();
  const provider = mailboxProvider(newEmail);
  const familyId = stableId("mailbox-family", provider, emailHash(newEmail));
  const method = options.associationMethod || "admin_explicit_rebind";
  const source = options.source || "v2-admin";
  (await db.transaction(async () => {
    (await db.prepare("UPDATE email_bindings SET is_current=0, valid_to=CASE WHEN valid_to='' THEN ? ELSE valid_to END, updated_at=? WHERE id=?")
      .run(changedAt, changedAt, current.id));
    (await preserveHistoricalCustomerAccess(String(current.id), changedAt));
    (await closeSale(accountId, changedAt, "email_rebind"));
    (await db.prepare(`INSERT OR IGNORE INTO mailbox_families(id, provider, canonical_address_enc, canonical_address_hash, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)`).run(familyId, provider, encryptSecret(newEmail), emailHash(newEmail), changedAt, changedAt));
    (await db.prepare(`INSERT INTO email_bindings(id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider,
      valid_from, is_current, association_method, legacy_mapping_id, source_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
      bindingId, accountId, familyId, encryptSecret(newEmail), emailHash(newEmail), parts.localPart, parts.domain, provider,
      changedAt, method, `v2:${bindingId}`, JSON.stringify(options.evidence || {}), changedAt, changedAt,
    ));
    (await insertAdminOnlyGrant(accountId, bindingId, newEmail, changedAt));
    (await db.prepare(`INSERT INTO binding_transitions(id, account_id, from_binding_id, to_binding_id, changed_at, method, task_id, evidence_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      crypto.randomUUID(), accountId, current.id, bindingId, changedAt, method,
      String(options.evidence?.taskId || ""),
      JSON.stringify({ customerAccessInherited: false, credentialsInheritedByAccountPointer: true, ...(options.evidence || {}) }), changedAt,
    ));
    (await addEvent(accountId, bindingId, "email_binding_changed", changedAt, source,
      { previousBindingId: current.id, customerAccessInherited: false, deactivationInherited: boolean(account.deactivation_locked), ...(options.evidence || {}) }));
    (await db.prepare("UPDATE gpt_accounts SET updated_at=? WHERE id=?").run(changedAt, accountId));
  })());
  return { bindingId, changed: true };
}

export async function recycleAccountTransition(accountId: string, newEmailInput: string, planInput = "free", source = "v2-admin"): Promise<{ replacementId: string }> {
  const previous = (await db.prepare("SELECT * FROM gpt_accounts WHERE id=? AND deleted_at='' ").get(accountId)) as any;
  if (!previous) throw new Error("原账号不存在");
  if (boolean(previous.sold) && !boolean(previous.deactivation_locked)) throw new Error("已售但未停用的GPT账号不能回收；该状态必须先人工确认");
  const newEmail = normalizeEmail(newEmailInput);
  const parts = splitEmail(newEmail);
  if (!parts.localPart || !parts.domain) throw new Error("新邮箱格式无效");
  if ((await db.prepare("SELECT 1 FROM email_bindings WHERE email_hash=?").get(emailHash(newEmail)))) throw new Error("新邮箱已被历史或当前账号使用，不能直接回收");
  const current = (await db.prepare("SELECT * FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId)) as any;
  if (!current) throw new Error("原账号没有当前邮箱绑定");
  const now = new Date().toISOString();
  const replacementId = crypto.randomUUID();
  const bindingId = crypto.randomUUID();
  const provider = mailboxProvider(newEmail);
  const previousEmail = decryptSecret(String(current.email_enc));
  const previousParts = splitEmail(previousEmail);
  const canonical = provider === "icloud" ? `${previousParts.localPart.split("+")[0]}@${previousParts.domain}` : newEmail;
  const familyId = stableId("mailbox-family", provider, emailHash(canonical));
  const previousRules = (await db.prepare("SELECT DISTINCT sender_pattern FROM mail_routing_rules WHERE binding_id=?").all(current.id)) as Array<{ sender_pattern: string }>;
  const senders = previousRules.length ? previousRules.map((rule) => rule.sender_pattern) : [LEGACY_RELAY_SENDER_PATTERN];
  let compatibility: Record<string, any> = {};
  try { compatibility = JSON.parse(String(current.source_json || "{}"))?.compatibility || {}; } catch {}
  const allowedPlans = new Set(["free", "plus", "pro", "team", "business", "unknown"]);
  const plan = allowedPlans.has(String(planInput).toLowerCase()) ? String(planInput).toLowerCase() : "free";
  (await db.transaction(async () => {
    (await db.prepare(`UPDATE email_bindings SET is_current=0,
      valid_to=CASE WHEN valid_to='' THEN ? ELSE valid_to END,
      receive_disabled_at=CASE WHEN receive_disabled_at='' THEN ? ELSE receive_disabled_at END,
      updated_at=? WHERE account_id=? AND is_current=1`).run(now, now, now, accountId));
    (await db.prepare("UPDATE mail_routing_rules SET valid_to=CASE WHEN valid_to='' THEN ? ELSE valid_to END, updated_at=? WHERE binding_id=?")
      .run(now, now, current.id));
    // Reclaim is the explicit boundary: old links and existing sessions must
    // stop immediately, including grants from historical bindings.
    (await revokeActiveCustomerAccess(accountId, now, "mailbox_recycle"));
    (await closeSale(accountId, now, "mailbox_recycle"));
    (await db.prepare(`UPDATE gpt_accounts SET lifecycle_status=CASE WHEN deactivation_locked=1 THEN 'deactivated' ELSE 'retired' END,
      admin_deactivated_at=CASE WHEN admin_deactivated_at='' THEN ? ELSE admin_deactivated_at END,
      retired_at=CASE WHEN retired_at='' THEN ? ELSE retired_at END, updated_at=? WHERE id=?`).run(now, now, now, accountId));
    (await db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, plan, domain_mailbox, identity_status, source_status, arrived_at, created_at, updated_at)
      VALUES(?, 'active', ?, ?, 'unknown', 'v2', ?, ?, ?)`).run(replacementId, plan, provider === "domain" ? 1 : 0, now, now, now));
    (await db.prepare(`INSERT OR IGNORE INTO mailbox_families(id, provider, canonical_address_enc, canonical_address_hash, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)`).run(familyId, provider, encryptSecret(canonical), emailHash(canonical), now, now));
    (await db.prepare(`INSERT INTO email_bindings(id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider,
      valid_from, is_current, association_method, legacy_mapping_id, source_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'admin_explicit_recycle', ?, ?, ?, ?)`).run(
      bindingId, replacementId, familyId, encryptSecret(newEmail), emailHash(newEmail), parts.localPart, parts.domain, provider,
      now, `v2:${bindingId}`, JSON.stringify({ compatibility: { sourceEmail: String(compatibility.sourceEmail || "").slice(0, 320),
        toEmail: newEmail, internalStatusMessage: "" } }), now, now,
    ));
    const insertRule = db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,sender_pattern,recipient_pattern,
      valid_from,source,priority,created_at,updated_at) VALUES(?,?,?,?,?,'v2-recycle',?,?,?)`);
    for (const [fromIndex, sender] of senders.entries()) for (const [toIndex, recipient] of [...new Set([newEmail, canonical])].entries()) {
      (await insertRule.run(stableId("recycle-mail-rule", bindingId, String(fromIndex), String(toIndex)), bindingId,
        sender, mailboxRecipientPattern(recipient), now, 100 - fromIndex - toIndex, now, now));
    }
    (await insertAdminOnlyGrant(replacementId, bindingId, newEmail, now));
    (await db.prepare(`INSERT INTO account_relations(id, relation_type, from_account_id, to_account_id, changed_at, association_method, evidence_json, created_at)
      VALUES(?, 'mailbox_recycle', ?, ?, ?, 'admin_explicit_recycle', ?, ?)`).run(
      crypto.randomUUID(), accountId, replacementId, now,
      JSON.stringify({ previousBindingId: current.id, nextBindingId: bindingId, customerAccessInherited: false, identityVerificationRequired: false }), now,
    ));
    (await addEvent(accountId, String(current.id), "mailbox_recycled_out", now, source, { replacementAccountId: replacementId }));
    (await addEvent(replacementId, bindingId, "account_created_from_recycle", now, source,
      { previousAccountId: accountId, customerAccessInherited: false, identityVerificationRequired: false }));
  })());
  return { replacementId };
}

export interface CustomerGrantSecret {
  grantId: string;
  saleId: string;
  publicToken: string;
  loginIdentifier: string;
  password: string;
  scope: string;
}

export async function issueCustomerGrant(accountId: string, bindingId: string, input: JsonObject = {}): Promise<CustomerGrantSecret> {
  const row = (await db.prepare(`SELECT b.*, a.lifecycle_status, a.retired_at, a.quarantine_reason, a.identity_status, a.sold
    FROM email_bindings b JOIN gpt_accounts a ON a.id=b.account_id
    WHERE b.id=? AND b.account_id=? AND a.deleted_at=''`).get(bindingId, accountId)) as any;
  if (!row) throw new Error("邮箱绑定不存在");
  if (!boolean(row.is_current)) throw new Error("只能为当前邮箱绑定生成客户权限");
  const blocked = customerGrantBlockReason({ lifecycleStatus: row.lifecycle_status, retiredAt: row.retired_at,
    quarantineReason: row.quarantine_reason, identityStatus: row.identity_status });
  if (blocked) throw new Error(`${blocked}，不能生成客户授权`);
  const actualEmail = normalizeEmail(String(input.loginIdentifier || "")) || normalizeEmail(decryptSecret(String(row.email_enc || "")));
  if (!splitEmail(actualEmail).localPart) throw new Error("登录标识必须是有效邮箱");
  const existingLogin = (await db.prepare("SELECT account_id FROM access_grants WHERE login_identifier_hash=? AND active=1 AND scope!='admin_only'")
    .all(emailHash(actualEmail))) as Array<{ account_id: string }>;
  if (existingLogin.some((grant) => String(grant.account_id) !== accountId)) throw new Error("该登录邮箱已分配给其他账号");
  const trackSale = input.trackSale !== false;
  const existingSale = (await db.prepare("SELECT * FROM sales WHERE account_id=?").get(accountId)) as any;
  const now = new Date().toISOString();
  const saleId = trackSale ? (existingSale ? String(existingSale.id) : crypto.randomUUID()) : "";
  const password = String(input.password || crypto.randomBytes(18).toString("base64url"));
  if (password.length < 10) throw new Error("接码密码至少10位");
  const publicToken = crypto.randomBytes(24).toString("base64url");
  const grantId = crypto.randomUUID();
  (await db.transaction(async () => {
    // Every issued link is an independent mailbox entrance. Creating another
    // entrance must not rotate or revoke links already handed to other users.
    if (trackSale && existingSale) {
      (await db.prepare(`UPDATE sales SET binding_id=?, status='active', started_at=CASE WHEN first_used_at='' THEN ? ELSE started_at END,
        ended_at='', end_reason='', updated_at=? WHERE id=?`).run(bindingId, now, now, saleId));
    } else if (trackSale) {
      (await db.prepare(`INSERT INTO sales(id, account_id, binding_id, status, started_at, created_at, updated_at)
        VALUES(?, ?, ?, 'active', ?, ?, ?)`).run(saleId, accountId, bindingId, now, now, now));
    }
    (await db.prepare(`INSERT INTO access_grants(id, account_id, binding_id, sale_id, public_token_hash, public_token_enc,
      login_identifier_hash, login_identifier_enc, password_hash, password_plain_enc, scope, visible_from, active, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, 1, ?, ?)`).run(
      grantId, accountId, bindingId, saleId || null, digestToken(publicToken), encryptSecret(publicToken), emailHash(actualEmail), encryptSecret(actualEmail),
      hashPassword(password), encryptSecret(password), String(row.valid_from || now), now, now,
    ));
    if (trackSale) (await db.prepare("UPDATE gpt_accounts SET sold=1, updated_at=? WHERE id=?").run(now, accountId));
    (await addEvent(accountId, bindingId, trackSale ? (existingSale ? "customer_access_added" : "account_sold") : "mailbox_access_link_created",
      now, "v2-admin", { saleId: saleId || null, grantId, previousGrantsPreserved: true, trackSale }));
  })());
  return { grantId, saleId, publicToken, loginIdentifier: actualEmail, password, scope: "current" };
}

export async function cancelUnusedSale(accountId: string): Promise<boolean> {
  const sale = (await db.prepare("SELECT * FROM sales WHERE account_id=?").get(accountId)) as any;
  if (!sale) return false;
  if (String(sale.first_used_at || "")) throw new Error("客户已经使用过该账号，不能恢复未售；只能冻结并回收");
  const now = new Date().toISOString();
  (await db.transaction(async () => {
    (await revokeActiveCustomerAccess(accountId, now, "unused_sale_cancelled"));
    (await db.prepare("UPDATE sales SET status='cancelled', ended_at=?, end_reason='unused_sale_cancelled', updated_at=? WHERE id=?")
      .run(now, now, sale.id));
    (await db.prepare("UPDATE gpt_accounts SET sold=0, updated_at=? WHERE id=?").run(now, accountId));
    (await addEvent(accountId, String(sale.binding_id), "unused_sale_cancelled", now, "v2-admin", { saleId: sale.id }));
  })());
  return true;
}

export async function revokeGrantTransition(accountId: string, grantId: string): Promise<boolean> {
  const grant = (await db.prepare("SELECT * FROM access_grants WHERE id=? AND account_id=? AND scope!='admin_only'").get(grantId, accountId)) as any;
  if (!grant) return false;
  const now = new Date().toISOString();
  (await db.transaction(async () => {
    (await db.prepare("UPDATE access_grants SET active=0, revoked_at=CASE WHEN revoked_at='' THEN ? ELSE revoked_at END, revoke_reason='admin_revoked', updated_at=? WHERE id=?")
      .run(now, now, grantId));
    if (grant.sale_id) {
      const sale = (await db.prepare("SELECT * FROM sales WHERE id=?").get(grant.sale_id)) as any;
      const otherActive = (await db.prepare(`SELECT 1 FROM access_grants
        WHERE sale_id=? AND id!=? AND active=1 AND scope!='admin_only' LIMIT 1`).get(grant.sale_id, grantId));
      if (!otherActive && sale && String(sale.status) === "active") {
        const status = String(sale.first_used_at || "") ? "closed" : "cancelled";
        (await db.prepare("UPDATE sales SET status=?, ended_at=?, end_reason='grant_revoked', updated_at=? WHERE id=?").run(status, now, now, sale.id));
        if (status === "cancelled") (await db.prepare("UPDATE gpt_accounts SET sold=0, updated_at=? WHERE id=?").run(now, accountId));
      }
    }
  })());
  return true;
}

export async function markGrantUsed(grantId: string): Promise<void> {
  if (config.readOnly) return;
  const grant = (await db.prepare("SELECT sale_id FROM access_grants WHERE id=? AND active=1 AND scope!='admin_only'").get(grantId)) as any;
  if (!grant) return;
  const now = new Date().toISOString();
  (await db.transaction(async () => {
    (await db.prepare("UPDATE access_grants SET first_used_at=CASE WHEN first_used_at='' THEN ? ELSE first_used_at END, last_used_at=?, updated_at=? WHERE id=?")
      .run(now, now, now, grantId));
    if (grant.sale_id) (await db.prepare("UPDATE sales SET first_used_at=CASE WHEN first_used_at='' THEN ? ELSE first_used_at END, last_used_at=?, updated_at=? WHERE id=?")
      .run(now, now, now, grant.sale_id));
  })());
}

export async function createPendingAssociationReview(accountId: string | null, email: string, reason: string, evidence: JsonObject = {}): Promise<void> {
  (await addReview("association_conflict", accountId, normalizeEmail(email), reason, evidence));
}
