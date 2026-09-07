import crypto from "node:crypto";
import { emailHash, normalizeEmail, splitEmail, stableId } from "./association.js";
import { config } from "./config.js";
import { decryptSecret, digestToken, encryptSecret, hashPassword } from "./crypto.js";
import { db } from "./db.js";

type JsonObject = Record<string, unknown>;

function boolean(value: unknown): boolean {
  return Boolean(Number(value));
}

function nowIso(value = ""): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function cutoffAfter(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed + 1).toISOString() : nowIso();
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

function addEvent(accountId: string, bindingId: string | null, eventType: string, occurredAt: string, source: string, payload: JsonObject): void {
  db.prepare(`INSERT INTO lifecycle_events(id, account_id, binding_id, event_type, occurred_at, source, payload_json, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), accountId, bindingId, eventType, occurredAt, source, JSON.stringify(payload), new Date().toISOString(),
  );
}

function addReview(reviewType: string, accountId: string | null, email: string, reason: string, evidence: JsonObject): void {
  const now = new Date().toISOString();
  const candidateHash = email ? emailHash(email) : stableId("review-candidate", reviewType, accountId || "none", reason);
  const id = stableId("pending-review", reviewType, accountId || "none", candidateHash);
  db.prepare(`INSERT INTO pending_reviews(id, review_type, account_id, candidate_email_enc, candidate_email_hash, status, reason, evidence_json, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status='pending', reason=excluded.reason,
      evidence_json=excluded.evidence_json, candidate_email_enc=excluded.candidate_email_enc, updated_at=excluded.updated_at`).run(
    id, reviewType, accountId, encryptSecret(email), candidateHash, reason, JSON.stringify(evidence), now, now,
  );
}

function insertAdminOnlyGrant(accountId: string, bindingId: string, email: string, now: string): void {
  const password = crypto.randomBytes(18).toString("base64url");
  db.prepare(`INSERT INTO access_grants(id, account_id, binding_id, public_token_hash, login_identifier_hash, login_identifier_enc,
    password_hash, password_plain_enc, scope, active, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'admin_only', 0, ?, ?)`).run(
    crypto.randomUUID(), accountId, bindingId, digestToken(crypto.randomUUID()), emailHash(email), encryptSecret(email),
    hashPassword(password), encryptSecret(password), now, now,
  );
}

function closeSale(accountId: string, cutoff: string, reason: string): void {
  db.prepare(`UPDATE sales SET status='closed', ended_at=CASE WHEN ended_at='' THEN ? ELSE ended_at END,
    end_reason=CASE WHEN end_reason='' THEN ? ELSE end_reason END, updated_at=?
    WHERE account_id=? AND status='active'`).run(cutoff, reason, cutoff, accountId);
}

function closeCustomerAccess(accountId: string, cutoff: string, reason: string, bindingId = ""): void {
  const clause = bindingId ? "binding_id=?" : "account_id=?";
  const target = bindingId || accountId;
  db.prepare(`UPDATE access_grants SET
      scope=CASE WHEN first_used_at!='' AND (visible_from='' OR julianday(visible_from)<julianday(?)) THEN 'historical' ELSE scope END,
      visible_to=CASE WHEN first_used_at!='' AND (visible_from='' OR julianday(visible_from)<julianday(?))
        AND (visible_to='' OR julianday(visible_to)>julianday(?)) THEN ? ELSE visible_to END,
      active=CASE WHEN first_used_at='' OR (visible_from!='' AND julianday(visible_from)>=julianday(?)) THEN 0 ELSE active END,
      revoked_at=CASE WHEN (first_used_at='' OR (visible_from!='' AND julianday(visible_from)>=julianday(?))) AND revoked_at='' THEN ? ELSE revoked_at END,
      revoke_reason=CASE WHEN (first_used_at='' OR (visible_from!='' AND julianday(visible_from)>=julianday(?))) AND revoke_reason='' THEN ? ELSE revoke_reason END,
      updated_at=?
    WHERE ${clause} AND active=1 AND scope!='admin_only'`).run(
    cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, reason, cutoff, target,
  );
}

function revokeActiveCustomerAccess(accountId: string, at: string, reason: string): void {
  db.prepare(`UPDATE access_grants SET active=0, revoked_at=CASE WHEN revoked_at='' THEN ? ELSE revoked_at END,
    revoke_reason=CASE WHEN revoke_reason='' THEN ? ELSE revoke_reason END, updated_at=?
    WHERE account_id=? AND active=1 AND scope!='admin_only'`).run(at, reason, at, accountId);
}

export interface AccountMatch {
  kind: "account" | "new" | "conflict";
  accountId: string;
  method: string;
  reason: string;
  candidateAccountIds: string[];
}

function identityAccounts(subjectHash: string): string[] {
  if (!subjectHash) return [];
  const rows = db.prepare(`SELECT DISTINCT account_id FROM (
      SELECT account_id FROM openai_identity_observations WHERE subject_hash=? AND status='confirmed'
      UNION ALL SELECT account_id FROM credentials WHERE openai_subject_hash=?
    ) LIMIT 4`).all(subjectHash, subjectHash) as Array<{ account_id: string }>;
  return [...new Set(rows.map((row) => String(row.account_id)))];
}

function accountSubjects(accountId: string): string[] {
  const rows = db.prepare(`SELECT subject_hash FROM openai_identity_observations WHERE account_id=? AND status='confirmed'
    UNION SELECT openai_subject_hash AS subject_hash FROM credentials WHERE account_id=? AND openai_subject_hash!=''`).all(accountId, accountId) as Array<{ subject_hash: string }>;
  return [...new Set(rows.map((row) => String(row.subject_hash)).filter(Boolean))];
}

function recycleLineageContains(startAccountId: string, candidateAccountId: string): boolean {
  if (!startAccountId || !candidateAccountId) return false;
  if (startAccountId === candidateAccountId) return true;
  const seen = new Set<string>([startAccountId]);
  const pending = [startAccountId];
  while (pending.length && seen.size <= 64) {
    const current = pending.shift()!;
    const rows = db.prepare(`SELECT from_account_id, to_account_id FROM account_relations
      WHERE relation_type='mailbox_recycle' AND status='confirmed'
        AND (from_account_id=? OR to_account_id=?)`).all(current, current) as Array<{ from_account_id: string; to_account_id: string }>;
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

export function resolveAccountMatch(subjectHash: string, emailInput: string): AccountMatch {
  const email = normalizeEmail(emailInput);
  const parts = splitEmail(email);
  const exact = email ? db.prepare("SELECT account_id, is_current FROM email_bindings WHERE email_hash=? LIMIT 8").all(emailHash(email)) as Array<{ account_id: string; is_current: number }> : [];
  const exactIds = [...new Set(exact.map((row) => String(row.account_id)))];
  const exactCurrentIds = [...new Set(exact.filter((row) => Boolean(row.is_current)).map((row) => String(row.account_id)))];
  const identityIds = identityAccounts(subjectHash);
  if (identityIds.length === 1 && exactIds.length > 1 && exactCurrentIds.length === 0
    && exactIds.every((accountId) => recycleLineageContains(identityIds[0], accountId))) {
    return {
      kind: "account", accountId: identityIds[0], method: "recycled_mailbox_identity",
      reason: "", candidateAccountIds: [...new Set([...exactIds, ...identityIds])],
    };
  }
  if (exactIds.length > 1 || identityIds.length > 1) {
    return { kind: "conflict", accountId: "", method: "ambiguous", reason: "邮箱或OpenAI身份命中多个GPT账号", candidateAccountIds: [...new Set([...exactIds, ...identityIds])] };
  }
  if (exactIds.length === 1 && identityIds.length === 1 && exactIds[0] !== identityIds[0]) {
    if (exactCurrentIds.length === 0 && recycleLineageContains(identityIds[0], exactIds[0])) {
      return {
        kind: "account", accountId: identityIds[0], method: "recycled_mailbox_identity",
        reason: "", candidateAccountIds: [...new Set([...exactIds, ...identityIds])],
      };
    }
    return { kind: "conflict", accountId: exactIds[0], method: "identity_email_conflict", reason: "邮箱与OpenAI身份分别属于不同GPT账号", candidateAccountIds: [...exactIds, ...identityIds] };
  }
  if (exactIds.length === 1) {
    const known = accountSubjects(exactIds[0]);
    if (subjectHash && known.length && !known.includes(subjectHash)) {
      return { kind: "conflict", accountId: exactIds[0], method: "contradictory_identity", reason: "相同邮箱出现了不同OpenAI身份", candidateAccountIds: exactIds };
    }
    return { kind: "account", accountId: exactIds[0], method: identityIds.length ? "identity_and_email" : "exact_email", reason: "", candidateAccountIds: exactIds };
  }
  if (identityIds.length === 1) return { kind: "account", accountId: identityIds[0], method: "openai_identity", reason: "", candidateAccountIds: identityIds };
  if (!parts.localPart || !isTrustedRebindDomain(parts.domain)) {
    return { kind: "new", accountId: "", method: "none", reason: "", candidateAccountIds: [] };
  }
  const localRows = db.prepare(`SELECT DISTINCT b.account_id FROM email_bindings b
    JOIN gpt_accounts a ON a.id=b.account_id
    WHERE b.local_part=? AND b.is_current=1 AND a.deleted_at='' LIMIT 4`).all(parts.localPart) as Array<{ account_id: string }>;
  const trustedIds = [...new Set(localRows.map((row) => String(row.account_id)).filter((accountId) => {
    const current = db.prepare("SELECT domain FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId) as any;
    return current && isTrustedRebindDomain(String(current.domain));
  }))];
  if (trustedIds.length > 1) return { kind: "conflict", accountId: "", method: "trusted_local_ambiguous", reason: "可信域同前缀命中多个GPT账号", candidateAccountIds: trustedIds };
  if (trustedIds.length === 1) {
    const known = accountSubjects(trustedIds[0]);
    if (subjectHash && known.length && !known.includes(subjectHash)) {
      return { kind: "conflict", accountId: trustedIds[0], method: "trusted_local_identity_conflict", reason: "同前缀候选账号的OpenAI身份不一致", candidateAccountIds: trustedIds };
    }
    return { kind: "account", accountId: trustedIds[0], method: "trusted_exact_local_part", reason: "", candidateAccountIds: trustedIds };
  }
  return { kind: "new", accountId: "", method: "none", reason: "", candidateAccountIds: [] };
}

export function recordIdentityObservation(accountId: string, subjectHash: string, source: string, evidence: JsonObject = {}): { conflict: boolean } {
  if (!subjectHash) return { conflict: false };
  const others = identityAccounts(subjectHash).filter((id) => id !== accountId);
  const now = new Date().toISOString();
  if (others.length) {
    quarantineAccount(accountId, "OpenAI身份与其他GPT账号冲突", source, { subjectHash, otherAccountIds: others, ...evidence });
    addReview("openai_identity_conflict", accountId, "", "同一OpenAI身份出现在不同GPT账号，已自动隔离当前账号", { subjectHash, otherAccountIds: others, ...evidence });
    return { conflict: true };
  }
  db.prepare(`INSERT INTO openai_identity_observations(id, account_id, subject_hash, source, status, first_seen_at, last_seen_at, evidence_json)
    VALUES(?, ?, ?, ?, 'confirmed', ?, ?, ?)
    ON CONFLICT(account_id, subject_hash) DO UPDATE SET source=excluded.source, status='confirmed',
      last_seen_at=excluded.last_seen_at, evidence_json=excluded.evidence_json`).run(
    stableId("openai-identity-observation", accountId, subjectHash), accountId, subjectHash, source, now, now, JSON.stringify(evidence),
  );
  db.prepare("UPDATE gpt_accounts SET identity_status='confirmed', updated_at=? WHERE id=? AND identity_status!='conflict'").run(now, accountId);
  return { conflict: false };
}

export function quarantineAccount(accountId: string, reason: string, source = "system", evidence: JsonObject = {}): void {
  const account = db.prepare("SELECT * FROM gpt_accounts WHERE id=? AND deleted_at='' ").get(accountId) as any;
  if (!account) return;
  const now = new Date().toISOString();
  if (String(account.identity_status || "") === "conflict") {
    revokeActiveCustomerAccess(accountId, now, "identity_conflict");
    closeSale(accountId, now, "identity_conflict");
    return;
  }
  db.transaction(() => {
    revokeActiveCustomerAccess(accountId, now, "identity_conflict");
    closeSale(accountId, now, "identity_conflict");
    db.prepare(`UPDATE gpt_accounts SET lifecycle_status=CASE WHEN deactivation_locked=1 THEN 'deactivated' ELSE 'quarantined' END,
      identity_status='conflict', quarantined_at=CASE WHEN quarantined_at='' THEN ? ELSE quarantined_at END,
      quarantine_reason=?, updated_at=? WHERE id=?`).run(now, String(reason).slice(0, 1000), now, accountId);
    addEvent(accountId, null, "account_quarantined", now, source, { reason, ...evidence });
  })();
}

export function freezeAccountTransition(accountId: string, reason = "admin_manual", source = "v2-admin", triggerReceivedAt = ""): void {
  const account = db.prepare("SELECT * FROM gpt_accounts WHERE id=? AND deleted_at='' ").get(accountId) as any;
  if (!account) throw new Error("账号不存在");
  const alreadyLocked = boolean(account.deactivation_locked);
  const occurredAt = alreadyLocked ? nowIso(String(account.deactivated_at || triggerReceivedAt)) : nowIso(triggerReceivedAt);
  const cutoff = triggerReceivedAt ? cutoffAfter(occurredAt) : occurredAt;
  db.transaction(() => {
    closeCustomerAccess(accountId, cutoff, "account_deactivated");
    closeSale(accountId, cutoff, "account_deactivated");
    if (alreadyLocked) return;
    db.prepare(`UPDATE gpt_accounts SET lifecycle_status='deactivated', deactivation_locked=1,
      deactivated_at=CASE WHEN deactivated_at='' THEN ? ELSE deactivated_at END, updated_at=? WHERE id=?`).run(occurredAt, occurredAt, accountId);
    addEvent(accountId, null, "account_deactivated", occurredAt, source, { immutable: true, reason: String(reason).slice(0, 500), customerCutoff: cutoff });
  })();
}

// "删除" in the admin UI is deliberately a soft delete.  The GPT identity,
// bindings, mail claims and lifecycle events remain in SQLite for audit and
// recovery; the account is only removed from normal list/customer queries.
// Customer access is revoked first so a deleted record can never continue to
// receive mail through an already-issued grant.
export function deleteAccountTransition(accountId: string, reason = "admin_bulk_delete", source = "v2-admin"): void {
  const account = db.prepare("SELECT * FROM gpt_accounts WHERE id=? AND deleted_at='' ").get(accountId) as any;
  if (!account) throw new Error("账号不存在或已经删除");
  const now = new Date().toISOString();
  db.transaction(() => {
    revokeActiveCustomerAccess(accountId, now, "account_deleted");
    closeSale(accountId, now, "account_deleted");
    db.prepare(`UPDATE gpt_accounts SET lifecycle_status='deleted', deleted_at=?, updated_at=? WHERE id=? AND deleted_at=''`)
      .run(now, now, accountId);
    addEvent(accountId, null, "account_deleted", now, source, {
      softDelete: true,
      immutableHistory: true,
      reason: String(reason || "admin_bulk_delete").slice(0, 500),
    });
  })();
}

export interface RebindOptions {
  source?: string;
  associationMethod?: string;
  changedAt?: string;
  evidence?: JsonObject;
}

export function rebindAccountTransition(accountId: string, newEmailInput: string, options: RebindOptions = {}): { bindingId: string; changed: boolean } {
  const account = db.prepare("SELECT * FROM gpt_accounts WHERE id=? AND deleted_at='' ").get(accountId) as any;
  if (!account) throw new Error("账号不存在");
  const newEmail = normalizeEmail(newEmailInput);
  const parts = splitEmail(newEmail);
  if (!parts.localPart || !parts.domain) throw new Error("新邮箱格式无效");
  const current = db.prepare("SELECT * FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId) as any;
  if (!current) throw new Error("账号没有当前邮箱绑定");
  if (String(current.email_hash) === emailHash(newEmail)) return { bindingId: String(current.id), changed: false };
  if (String(current.local_part) !== parts.localPart) throw new Error("完整本地部分不一致，不能改绑");
  if (boolean(account.sold) && !boolean(account.deactivation_locked)) throw new Error("已售且未停用的GPT账号不允许改绑；请先人工确认异常");
  const owners = db.prepare("SELECT DISTINCT account_id FROM email_bindings WHERE email_hash=?").all(emailHash(newEmail)) as Array<{ account_id: string }>;
  if (owners.some((row) => String(row.account_id) !== accountId)) throw new Error("新邮箱属于其他GPT账号，禁止改绑");
  const changedAt = nowIso(options.changedAt || "");
  const bindingId = crypto.randomUUID();
  const provider = mailboxProvider(newEmail);
  const familyId = stableId("mailbox-family", provider, emailHash(newEmail));
  const method = options.associationMethod || "admin_explicit_rebind";
  const source = options.source || "v2-admin";
  db.transaction(() => {
    db.prepare("UPDATE email_bindings SET is_current=0, valid_to=CASE WHEN valid_to='' THEN ? ELSE valid_to END, updated_at=? WHERE id=?")
      .run(changedAt, changedAt, current.id);
    closeCustomerAccess(accountId, changedAt, "email_rebind", String(current.id));
    closeSale(accountId, changedAt, "email_rebind");
    db.prepare(`INSERT OR IGNORE INTO mailbox_families(id, provider, canonical_address_enc, canonical_address_hash, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)`).run(familyId, provider, encryptSecret(newEmail), emailHash(newEmail), changedAt, changedAt);
    db.prepare(`INSERT INTO email_bindings(id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider,
      valid_from, is_current, association_method, legacy_mapping_id, source_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
      bindingId, accountId, familyId, encryptSecret(newEmail), emailHash(newEmail), parts.localPart, parts.domain, provider,
      changedAt, method, `v2:${bindingId}`, JSON.stringify(options.evidence || {}), changedAt, changedAt,
    );
    insertAdminOnlyGrant(accountId, bindingId, newEmail, changedAt);
    db.prepare(`INSERT INTO binding_transitions(id, account_id, from_binding_id, to_binding_id, changed_at, method, task_id, evidence_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      crypto.randomUUID(), accountId, current.id, bindingId, changedAt, method,
      String(options.evidence?.taskId || ""),
      JSON.stringify({ customerAccessInherited: false, credentialsInheritedByAccountPointer: true, ...(options.evidence || {}) }), changedAt,
    );
    addEvent(accountId, bindingId, "email_binding_changed", changedAt, source,
      { previousBindingId: current.id, customerAccessInherited: false, deactivationInherited: boolean(account.deactivation_locked), ...(options.evidence || {}) });
    db.prepare("UPDATE gpt_accounts SET updated_at=? WHERE id=?").run(changedAt, accountId);
  })();
  return { bindingId, changed: true };
}

export function recycleAccountTransition(accountId: string, newEmailInput: string, planInput = "free", source = "v2-admin"): { replacementId: string } {
  const previous = db.prepare("SELECT * FROM gpt_accounts WHERE id=? AND deleted_at='' ").get(accountId) as any;
  if (!previous) throw new Error("原账号不存在");
  if (boolean(previous.sold) && !boolean(previous.deactivation_locked)) throw new Error("已售但未停用的GPT账号不能回收；该状态必须先人工确认");
  const newEmail = normalizeEmail(newEmailInput);
  const parts = splitEmail(newEmail);
  if (!parts.localPart || !parts.domain) throw new Error("新邮箱格式无效");
  if (db.prepare("SELECT 1 FROM email_bindings WHERE email_hash=?").get(emailHash(newEmail))) throw new Error("新邮箱已被历史或当前账号使用，不能直接回收");
  const current = db.prepare("SELECT * FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId) as any;
  if (!current) throw new Error("原账号没有当前邮箱绑定");
  const now = new Date().toISOString();
  const replacementId = crypto.randomUUID();
  const bindingId = crypto.randomUUID();
  const provider = mailboxProvider(newEmail);
  const familyId = stableId("mailbox-family", provider, emailHash(newEmail));
  const allowedPlans = new Set(["free", "plus", "pro", "team", "business", "unknown"]);
  const plan = allowedPlans.has(String(planInput).toLowerCase()) ? String(planInput).toLowerCase() : "free";
  db.transaction(() => {
    db.prepare("UPDATE email_bindings SET is_current=0, valid_to=CASE WHEN valid_to='' THEN ? ELSE valid_to END, updated_at=? WHERE account_id=? AND is_current=1")
      .run(now, now, accountId);
    closeCustomerAccess(accountId, now, "mailbox_recycle");
    closeSale(accountId, now, "mailbox_recycle");
    db.prepare(`UPDATE gpt_accounts SET lifecycle_status=CASE WHEN deactivation_locked=1 THEN 'deactivated' ELSE 'retired' END,
      retired_at=CASE WHEN retired_at='' THEN ? ELSE retired_at END, updated_at=? WHERE id=?`).run(now, now, accountId);
    db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, plan, domain_mailbox, identity_status, source_status, arrived_at, created_at, updated_at)
      VALUES(?, 'active', ?, ?, 'unknown', 'v2', ?, ?, ?)`).run(replacementId, plan, provider === "domain" ? 1 : 0, now, now, now);
    db.prepare(`INSERT OR IGNORE INTO mailbox_families(id, provider, canonical_address_enc, canonical_address_hash, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)`).run(familyId, provider, encryptSecret(newEmail), emailHash(newEmail), now, now);
    db.prepare(`INSERT INTO email_bindings(id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider,
      valid_from, is_current, association_method, legacy_mapping_id, source_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'admin_explicit_recycle', ?, '{}', ?, ?)`).run(
      bindingId, replacementId, familyId, encryptSecret(newEmail), emailHash(newEmail), parts.localPart, parts.domain, provider,
      now, `v2:${bindingId}`, now, now,
    );
    insertAdminOnlyGrant(replacementId, bindingId, newEmail, now);
    db.prepare(`INSERT INTO account_relations(id, relation_type, from_account_id, to_account_id, changed_at, association_method, evidence_json, created_at)
      VALUES(?, 'mailbox_recycle', ?, ?, ?, 'admin_explicit_recycle', ?, ?)`).run(
      crypto.randomUUID(), accountId, replacementId, now,
      JSON.stringify({ previousBindingId: current.id, nextBindingId: bindingId, customerAccessInherited: false, identityVerificationRequired: false }), now,
    );
    addEvent(accountId, String(current.id), "mailbox_recycled_out", now, source, { replacementAccountId: replacementId });
    addEvent(replacementId, bindingId, "account_created_from_recycle", now, source,
      { previousAccountId: accountId, customerAccessInherited: false, identityVerificationRequired: false });
  })();
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

export function issueCustomerGrant(accountId: string, bindingId: string, input: JsonObject = {}): CustomerGrantSecret {
  const row = db.prepare(`SELECT b.*, a.lifecycle_status, a.deactivation_locked, a.identity_status, a.sold
    FROM email_bindings b JOIN gpt_accounts a ON a.id=b.account_id
    WHERE b.id=? AND b.account_id=? AND a.deleted_at=''`).get(bindingId, accountId) as any;
  if (!row) throw new Error("邮箱绑定不存在");
  if (!boolean(row.is_current)) throw new Error("只能为当前邮箱绑定生成客户权限");
  if (String(row.lifecycle_status) !== "active" || boolean(row.deactivation_locked)) throw new Error("停用、历史或隔离账号不能出售");
  if (String(row.identity_status) === "conflict") throw new Error("账号存在OpenAI身份冲突，不能出售");
  const actualEmail = normalizeEmail(String(input.loginIdentifier || "")) || normalizeEmail(decryptSecret(String(row.email_enc || "")));
  if (!splitEmail(actualEmail).localPart) throw new Error("登录标识必须是有效邮箱");
  const existingLogin = db.prepare("SELECT account_id FROM access_grants WHERE login_identifier_hash=? AND active=1 AND scope!='admin_only'")
    .all(emailHash(actualEmail)) as Array<{ account_id: string }>;
  if (existingLogin.some((grant) => String(grant.account_id) !== accountId)) throw new Error("该登录邮箱已分配给其他账号");
  const existingSale = db.prepare("SELECT * FROM sales WHERE account_id=?").get(accountId) as any;
  if (boolean(row.sold) && !existingSale) throw new Error("历史记录表明该GPT身份已经出售，不能再次出售；请回收为新账号");
  if (existingSale && String(existingSale.status) !== "active" && String(existingSale.first_used_at || "")) {
    throw new Error("这个GPT身份已经正式出售过，不能二次出售；请回收为新账号");
  }
  const now = new Date().toISOString();
  const saleId = existingSale ? String(existingSale.id) : crypto.randomUUID();
  const password = String(input.password || crypto.randomBytes(18).toString("base64url"));
  if (password.length < 10) throw new Error("接码密码至少10位");
  const publicToken = crypto.randomBytes(24).toString("base64url");
  const grantId = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`UPDATE access_grants SET active=0, revoked_at=CASE WHEN revoked_at='' THEN ? ELSE revoked_at END,
      revoke_reason=CASE WHEN revoke_reason='' THEN 'grant_rotated' ELSE revoke_reason END, updated_at=?
      WHERE account_id=? AND active=1 AND scope!='admin_only'`).run(now, now, accountId);
    if (existingSale) {
      db.prepare(`UPDATE sales SET binding_id=?, status='active', started_at=CASE WHEN first_used_at='' THEN ? ELSE started_at END,
        ended_at='', end_reason='', updated_at=? WHERE id=?`).run(bindingId, now, now, saleId);
    } else {
      db.prepare(`INSERT INTO sales(id, account_id, binding_id, status, started_at, created_at, updated_at)
        VALUES(?, ?, ?, 'active', ?, ?, ?)`).run(saleId, accountId, bindingId, now, now, now);
    }
    db.prepare(`INSERT INTO access_grants(id, account_id, binding_id, sale_id, public_token_hash, public_token_enc,
      login_identifier_hash, login_identifier_enc, password_hash, password_plain_enc, scope, visible_from, active, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, 1, ?, ?)`).run(
      grantId, accountId, bindingId, saleId, digestToken(publicToken), encryptSecret(publicToken), emailHash(actualEmail), encryptSecret(actualEmail),
      hashPassword(password), encryptSecret(password), String(row.valid_from || now), now, now,
    );
    db.prepare("UPDATE gpt_accounts SET sold=1, updated_at=? WHERE id=?").run(now, accountId);
    addEvent(accountId, bindingId, existingSale ? "customer_grant_rotated" : "account_sold", now, "v2-admin",
      { saleId, grantId, previousGrantInvalidated: true });
  })();
  return { grantId, saleId, publicToken, loginIdentifier: actualEmail, password, scope: "current" };
}

export function cancelUnusedSale(accountId: string): boolean {
  const sale = db.prepare("SELECT * FROM sales WHERE account_id=?").get(accountId) as any;
  if (!sale) return false;
  if (String(sale.first_used_at || "")) throw new Error("客户已经使用过该账号，不能恢复未售；只能冻结并回收");
  const now = new Date().toISOString();
  db.transaction(() => {
    revokeActiveCustomerAccess(accountId, now, "unused_sale_cancelled");
    db.prepare("UPDATE sales SET status='cancelled', ended_at=?, end_reason='unused_sale_cancelled', updated_at=? WHERE id=?")
      .run(now, now, sale.id);
    db.prepare("UPDATE gpt_accounts SET sold=0, updated_at=? WHERE id=?").run(now, accountId);
    addEvent(accountId, String(sale.binding_id), "unused_sale_cancelled", now, "v2-admin", { saleId: sale.id });
  })();
  return true;
}

export function revokeGrantTransition(accountId: string, grantId: string): boolean {
  const grant = db.prepare("SELECT * FROM access_grants WHERE id=? AND account_id=? AND scope!='admin_only'").get(grantId, accountId) as any;
  if (!grant) return false;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE access_grants SET active=0, revoked_at=CASE WHEN revoked_at='' THEN ? ELSE revoked_at END, revoke_reason='admin_revoked', updated_at=? WHERE id=?")
      .run(now, now, grantId);
    if (grant.sale_id) {
      const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(grant.sale_id) as any;
      if (sale && String(sale.status) === "active") {
        const status = String(sale.first_used_at || "") ? "closed" : "cancelled";
        db.prepare("UPDATE sales SET status=?, ended_at=?, end_reason='grant_revoked', updated_at=? WHERE id=?").run(status, now, now, sale.id);
        if (status === "cancelled") db.prepare("UPDATE gpt_accounts SET sold=0, updated_at=? WHERE id=?").run(now, accountId);
      }
    }
  })();
  return true;
}

export function markGrantUsed(grantId: string): void {
  if (config.readOnly) return;
  const grant = db.prepare("SELECT sale_id FROM access_grants WHERE id=? AND active=1 AND scope!='admin_only'").get(grantId) as any;
  if (!grant) return;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE access_grants SET first_used_at=CASE WHEN first_used_at='' THEN ? ELSE first_used_at END, last_used_at=?, updated_at=? WHERE id=?")
      .run(now, now, now, grantId);
    if (grant.sale_id) db.prepare("UPDATE sales SET first_used_at=CASE WHEN first_used_at='' THEN ? ELSE first_used_at END, last_used_at=?, updated_at=? WHERE id=?")
      .run(now, now, now, grant.sale_id);
  })();
}

export function createPendingAssociationReview(accountId: string | null, email: string, reason: string, evidence: JsonObject = {}): void {
  addReview("association_conflict", accountId, normalizeEmail(email), reason, evidence);
}
