import crypto from "node:crypto";
import { emailHash, normalizeEmail, splitEmail, stableId } from "./association.js";
import { config } from "./config.js";
import { encryptSecret } from "./crypto.js";
import { db } from "./db.js";
import { observeCredentialVersion } from "./credential-versions.js";
import { isStrictPlusEvidenceSubject } from "./plus-evidence.js";
import { hasActiveTrialOnlyCorrection } from "./plus-plan-state.js";
import {
  rebindAccountTransition,
  recordIdentityObservation,
  resolveAccountMatch,
} from "./account-transitions.js";

type JsonObject = Record<string, any>;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

async function request(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<any> {
  const response = await fetch(`${config.sub2apiUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || (payload?.code != null && Number(payload.code) !== 0)) {
    throw new Error(String(payload?.message || payload?.error || `Sub2API HTTP ${response.status}`));
  }
  return payload?.data ?? payload;
}

async function accessToken(): Promise<string> {
  if (config.sub2apiAdminToken) return config.sub2apiAdminToken;
  if (!config.sub2apiAdminEmail || !config.sub2apiAdminPassword) throw new Error("Sub2API管理员凭证未配置");
  const payload = await request("/auth/login", {
    method: "POST",
    body: { email: config.sub2apiAdminEmail, password: config.sub2apiAdminPassword },
  });
  const token = String(payload?.access_token || payload?.token || "");
  if (!token) throw new Error("Sub2API登录未返回令牌");
  return token;
}

async function listAccounts(token: string): Promise<JsonObject[]> {
  const output: JsonObject[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const payload = await request(`/admin/accounts?page=${page}&page_size=200`, { token });
    const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.accounts) ? payload.accounts : [];
    output.push(...items.filter((item: unknown) => item && typeof item === "object"));
    if (!items.length || output.length >= Number(payload?.total || output.length)) break;
  }
  return output;
}

function rawAccountKey(item: JsonObject): string[] {
  const credentials = item.credentials || {};
  return [normalizeEmail(credentials.email), String(item.name || "").trim().toLowerCase()].filter(Boolean);
}

function matchMetadata(item: JsonObject, byKey: Map<string, JsonObject[]>): JsonObject | null {
  const candidates = new Map<string, JsonObject>();
  for (const key of rawAccountKey(item)) {
    for (const candidate of byKey.get(key) || []) {
      candidates.set(String(candidate.id || candidate.name), candidate);
    }
  }
  // Names are operator labels and can be duplicated. A complete address is
  // stronger evidence; use the name only to distinguish duplicate exports
  // for that same address, never to replace a contradictory address.
  const email = normalizeEmail(item.credentials?.email);
  const name = String(item.name || "").trim().toLowerCase();
  if (email) {
    const exactEmail = [...candidates.values()].filter((candidate) => normalizeEmail(candidate.credentials?.email) === email);
    if (exactEmail.length === 1) return exactEmail[0];
    if (exactEmail.length > 1) {
      const exactPair = exactEmail.filter((candidate) => String(candidate.name || "").trim().toLowerCase() === name);
      return exactPair.length === 1 ? exactPair[0] : null;
    }
  }
  if (candidates.size === 1) {
    const candidate = [...candidates.values()][0];
    const candidateEmail = normalizeEmail(candidate.credentials?.email);
    return email && candidateEmail && email !== candidateEmail ? null : candidate;
  }
  if (name) {
    const exactName = [...candidates.values()].filter((candidate) => String(candidate.name || "").trim().toLowerCase() === name
      && (!email || !normalizeEmail(candidate.credentials?.email) || normalizeEmail(candidate.credentials?.email) === email));
    if (exactName.length === 1) return exactName[0];
  }
  return null;
}

function provider(email: string): string {
  const domain = splitEmail(email).domain;
  if (domain === "icloud.com" || domain.endsWith(".icloud.com")) return "icloud";
  if (/(?:outlook|hotmail|live)\./i.test(domain)) return "outlook";
  return "domain";
}

function jwtIdentityClaims(token: unknown): JsonObject {
  try {
    const claims = JSON.parse(Buffer.from(String(token || "").split(".")[1] || "", "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : {};
  } catch { return {}; }
}

export function isSub2ApiMailboxAccount(item: JsonObject): boolean {
  const type = String(item.type || "").trim().toLowerCase();
  // platform=openai includes arbitrary OpenAI-compatible API gateways.
  // Their API keys and names do not describe a customer ChatGPT mailbox.
  return String(item.platform || "").toLowerCase() === "openai" && (!type || type === "oauth");
}

export function sub2ApiIdentityMaterial(item: JsonObject): { identityHash: string; email: string; conflictingAccountIds: string[] } {
  const credentials = item.credentials || {};
  const accessClaims = jwtIdentityClaims(credentials.access_token);
  const claims = Object.keys(accessClaims).length ? accessClaims : jwtIdentityClaims(credentials.id_token);
  const auth = claims["https://api.openai.com/auth"] || {};
  const profile = claims["https://api.openai.com/profile"] || {};
  // V1 imported account_user_id, while older tokens sometimes only had sub.
  // Distinct fields in the same token are aliases, not different people.
  // Reuse an existing hash only when this token proves it and the complete
  // alias set identifies one local account. Never infer this from an email.
  const identities = [...new Set([auth.chatgpt_account_user_id, auth.chatgpt_user_id,
    claims.sub, auth.user_id, claims.user_id].map((value) => String(value || "")).filter(Boolean))];
  const fallbackIdentity = String(credentials.chatgpt_user_id || credentials.user_id || credentials.sub || "");
  const hashes = identities.map(sha256);
  const identityRows = hashes.length ? db.prepare(`SELECT account_id, openai_subject_hash subject_hash FROM credentials
      WHERE openai_subject_hash IN (${hashes.map(() => "?").join(",")})
    UNION SELECT account_id, subject_hash FROM openai_identity_observations
      WHERE status='confirmed' AND subject_hash IN (${hashes.map(() => "?").join(",")})`).all(...hashes, ...hashes) as Array<{ account_id: string; subject_hash: string }> : [];
  const accountIds = [...new Set(identityRows.map((row) => row.account_id))];
  const current = accountIds.length === 1
    ? db.prepare("SELECT openai_subject_hash FROM credentials WHERE account_id=?").get(accountIds[0]) as { openai_subject_hash: string } | undefined
    : undefined;
  const identityHash = accountIds.length === 1
    ? current && hashes.includes(current.openai_subject_hash) ? current.openai_subject_hash : identityRows[0].subject_hash
    : hashes[0] || (fallbackIdentity ? sha256(fallbackIdentity) : "");
  const email = normalizeEmail(credentials.email || item.extra?.email || profile.email || claims.email || item.name);
  return { identityHash, email, conflictingAccountIds: accountIds.length > 1 ? accountIds : [] };
}

function addPendingReview(accountId: string | null, email: string, reason: string, evidence: JsonObject): void {
  const now = new Date().toISOString();
  const reviewId = stableId("pending-review", "sub2api-rebind", accountId || "unmatched", emailHash(email));
  db.prepare(`INSERT INTO pending_reviews(id, review_type, account_id, candidate_email_enc, candidate_email_hash, reason, evidence_json, created_at, updated_at)
    VALUES(?, 'sub2api_rebind', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, candidate_email_enc=excluded.candidate_email_enc,
      candidate_email_hash=excluded.candidate_email_hash, status='pending', reason=excluded.reason,
      evidence_json=excluded.evidence_json, updated_at=excluded.updated_at`).run(
    reviewId, accountId, encryptSecret(email), emailHash(email), reason, JSON.stringify(evidence), now, now,
  );
}

function addUnresolvedReview(metadata: JsonObject, reason: string): void {
  const now = new Date().toISOString();
  const email = normalizeEmail(metadata.credentials?.email || metadata.extra?.email || "");
  const sourceKey = String(metadata.id || metadata.name || emailHash(email));
  const candidateHash = email ? emailHash(email) : sha256(`sub2api-unresolved:${sourceKey}`);
  const reviewId = stableId("pending-review", "sub2api-unresolved", sourceKey);
  db.prepare(`INSERT INTO pending_reviews(id, review_type, account_id, candidate_email_enc, candidate_email_hash, reason, evidence_json, created_at, updated_at)
    VALUES(?, 'sub2api_unresolved', NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET candidate_email_enc=excluded.candidate_email_enc, candidate_email_hash=excluded.candidate_email_hash,
      status='pending', reason=excluded.reason, evidence_json=excluded.evidence_json, updated_at=excluded.updated_at`).run(
    reviewId, encryptSecret(email), candidateHash, reason,
    JSON.stringify({ sub2apiId: metadata.id, name: String(metadata.name || ""), status: String(metadata.status || "") }), now, now,
  );
}

function ensureAdminOnlyGrant(accountId: string, bindingId: string, email: string, now: string): void {
  db.prepare(`INSERT OR IGNORE INTO access_grants(
    id, account_id, binding_id, public_token_hash, login_identifier_hash, login_identifier_enc, password_hash,
    scope, active, created_at, updated_at
  ) VALUES(?, ?, ?, ?, ?, ?, '', 'admin_only', 0, ?, ?)`).run(
    stableId("sub2api-admin-grant", bindingId), accountId, bindingId, sha256(`no-public-token:${bindingId}`),
    emailHash(email), encryptSecret(email), now, now,
  );
}

function hasAuthoritativePlusEvidence(accountId: string): boolean {
  const event = db.prepare(`SELECT 1 FROM lifecycle_events
    WHERE account_id=? AND event_type='plus_activated_by_mail' LIMIT 1`).get(accountId);
  if (event) return true;
  const rows = db.prepare(`SELECT m.subject
    FROM mail_messages m
    JOIN mail_ownership_claims oc ON oc.message_id=m.id
    WHERE oc.account_id=? AND m.category='billing'`).all(accountId) as Array<{ subject?: string }>;
  return rows.some((row) => isStrictPlusEvidenceSubject(row.subject));
}

function updateCredential(accountId: string, item: JsonObject, metadata: JsonObject, identityHash: string, now: string): void {
  const credentials = item.credentials || {};
  const accessToken = String(credentials.access_token || "");
  const refreshToken = String(credentials.refresh_token || "");
  const idToken = String(credentials.id_token || "");
  if (accessToken || refreshToken || idToken) {
    const email = normalizeEmail(credentials.email || metadata.extra?.email || "");
    const binding = email
      ? db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND email_hash=? ORDER BY is_current DESC LIMIT 1").get(accountId, emailHash(email)) as any
      : db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId) as any;
    observeCredentialVersion({
      accountId, bindingId: String(binding?.id || "") || null, accessToken, refreshToken, idToken,
      subjectHash: identityHash, source: "sub2api-active", observedAt: String(metadata.updated_at || now),
      validityStatus: accessToken ? "alive" : "unknown", evidence: { sub2apiId: metadata.id || "" },
      observationKey: String(metadata.id || item.name || ""),
      allowAccountMutation: !config.readOnly,
    });
  }
  if (!config.readOnly && credentials.plan_type) {
    const incomingPlan = String(credentials.plan_type).toLowerCase();
    const current = db.prepare("SELECT plan FROM gpt_accounts WHERE id=?").get(accountId) as any;
    const currentPlan = String(current?.plan || "unknown").toLowerCase();
    const paidPlans = new Set(["plus", "pro", "team", "business", "enterprise", "edu"]);
    const durablePlus = paidPlans.has(currentPlan) || hasAuthoritativePlusEvidence(accountId);
    // Sub2API is a credential/identity source, not the authority for a
    // downgrade. A Free/unknown snapshot must never erase a mail-confirmed
    // Plus result, and an account outside Sub2API remains mail-driven.
    const plan = hasActiveTrialOnlyCorrection(db, accountId)
      ? "free"
      : incomingPlan === "plus"
      ? "plus"
      : durablePlus
        ? (paidPlans.has(currentPlan) ? currentPlan : "plus")
        : currentPlan === "unknown" ? incomingPlan : currentPlan;
    if (plan !== currentPlan) db.prepare("UPDATE gpt_accounts SET plan=?, updated_at=? WHERE id=?").run(plan, now, accountId);
  }
}

function ensureSub2ApiAccount(item: JsonObject, metadata: JsonObject): { accountId: string; created: boolean; rebind: boolean; conflict: boolean; skipped: boolean } {
  const credentials = item.credentials || {};
  const { email, identityHash, conflictingAccountIds } = sub2ApiIdentityMaterial(item);
  const parts = splitEmail(email);
  const topologyWritable = !config.readOnly;
  if (conflictingAccountIds.length) {
    if (topologyWritable) addPendingReview(null, email, "同一凭证中的身份字段命中不同GPT账号，禁止自动关联", {
      sub2apiId: metadata.id, candidateAccountIds: conflictingAccountIds, matchMethod: "identity_alias_conflict",
    });
    return { accountId: "", created: false, rebind: false, conflict: true, skipped: false };
  }
  if (!parts.localPart || !parts.domain) {
    const identityOnly = identityHash ? resolveAccountMatch(identityHash, "") : null;
    if (!identityOnly || identityOnly.kind !== "account") return { accountId: "", created: false, rebind: false, conflict: Boolean(identityOnly?.kind === "conflict"), skipped: true };
    const now = new Date().toISOString();
    if (topologyWritable) {
      const identity = recordIdentityObservation(identityOnly.accountId, identityHash, "sub2api", { sub2apiId: metadata.id });
      if (identity.conflict) return { accountId: identityOnly.accountId, created: false, rebind: false, conflict: true, skipped: false };
    }
    updateCredential(identityOnly.accountId, item, metadata, identityHash, now);
    return { accountId: identityOnly.accountId, created: false, rebind: false, conflict: false, skipped: false };
  }
  const match = resolveAccountMatch(identityHash, email);
  const now = new Date().toISOString();
  if (match.kind === "conflict") {
    if (topologyWritable) {
      // Sub2API is a volatile credential projection. A contradictory snapshot
      // must not mutate an already-established account or revoke customer
      // mailbox access. Keep the candidate out of the credential chain and
      // require review; an explicit/admin import can still quarantine after a
      // separately verified conflict.
      addPendingReview(match.accountId || null, email, match.reason, {
        sub2apiId: metadata.id, identityHash, candidateAccountIds: match.candidateAccountIds, matchMethod: match.method,
      });
    }
    return { accountId: match.accountId, created: false, rebind: false, conflict: true, skipped: false };
  }
  let accountId = match.accountId;
  let created = false;
  let rebind = false;
  let conflict = false;
  let staleHistoricalEmail = false;

  if (!accountId) {
    if (!topologyWritable) return { accountId: "", created: false, rebind: false, conflict: false, skipped: true };
    accountId = stableId("sub2api-gpt-account", identityHash || emailHash(email));
    const arrivedAt = String(metadata.created_at || now);
    db.prepare(`INSERT OR IGNORE INTO gpt_accounts(
      id, lifecycle_status, sold, plan, domain_mailbox, source_status, arrived_at, created_at, updated_at
    ) VALUES(?, 'active', 0, ?, ?, 'sub2api', ?, ?, ?)`).run(
      accountId, String(credentials.plan_type || "unknown").toLowerCase(), provider(email) === "domain" ? 1 : 0, arrivedAt, arrivedAt, now,
    );
    const familyId = stableId("mailbox-family", provider(email), emailHash(email));
    const bindingId = stableId("sub2api-binding", accountId, emailHash(email));
    db.prepare(`INSERT OR IGNORE INTO mailbox_families(id, provider, canonical_address_enc, canonical_address_hash, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)`).run(familyId, provider(email), encryptSecret(email), emailHash(email), now, now);
    db.prepare(`INSERT OR IGNORE INTO email_bindings(
      id, account_id, mailbox_family_id, email_enc, email_hash, local_part, domain, provider, valid_from, is_current,
      association_method, legacy_mapping_id, source_json, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'sub2api_active_import', ?, ?, ?, ?)`).run(
      bindingId, accountId, familyId, encryptSecret(email), emailHash(email), splitEmail(email).localPart, splitEmail(email).domain,
      provider(email), arrivedAt, `sub2api:${metadata.id || item.name}`, JSON.stringify({ sub2apiId: metadata.id }), arrivedAt, now,
    );
    ensureAdminOnlyGrant(accountId, bindingId, email, now);
    db.prepare(`INSERT OR IGNORE INTO lifecycle_events(
      id, account_id, binding_id, event_type, occurred_at, source, payload_json, created_at
    ) VALUES(?, ?, ?, 'email_binding_imported', ?, 'sub2api', ?, ?)`).run(
      stableId("sub2api-import-event", bindingId), accountId, bindingId, arrivedAt,
      JSON.stringify({ customerAccessInherited: false, sub2apiId: metadata.id }), now,
    );
    created = true;
  } else {
    const current = db.prepare("SELECT * FROM email_bindings WHERE account_id=? AND is_current=1 ORDER BY valid_from DESC LIMIT 1").get(accountId) as any;
    if (current && String(current.email_hash) !== emailHash(email)) {
      const historical = db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND email_hash=? AND is_current=0 LIMIT 1")
        .get(accountId, emailHash(email)) as any;
      if (!topologyWritable) {
        // V1 owns mailbox topology during coexistence. Wait for its projection
        // before associating a credential observed under another address.
        staleHistoricalEmail = true;
      } else if (historical) {
        // A live export can lag behind an already-completed V1 rebind. The old
        // mailbox and old AT are historical evidence only: never move the
        // current binding backwards and never overwrite the fresh target AT.
        staleHistoricalEmail = true;
        db.prepare(`INSERT OR IGNORE INTO lifecycle_events(
          id, account_id, binding_id, event_type, occurred_at, source, payload_json, created_at
        ) VALUES(?, ?, ?, 'historical_credential_ignored', ?, 'sub2api', ?, ?)`).run(
          stableId("sub2api-historical-credential-ignored", accountId, metadata.id || item.name, emailHash(email)),
          accountId, String(historical.id), String(metadata.updated_at || now),
          JSON.stringify({ sub2apiId: metadata.id, observedEmail: email, currentBindingId: current.id }), now,
        );
      } else if (match.method === "recycled_mailbox_identity") {
        db.prepare(`INSERT OR IGNORE INTO lifecycle_events(
          id, account_id, binding_id, event_type, occurred_at, source, payload_json, created_at
        ) VALUES(?, ?, ?, 'recycled_mailbox_identity_observed', ?, 'sub2api', ?, ?)`).run(
          stableId("sub2api-recycled-mailbox-observation", accountId, metadata.id || item.name, emailHash(email)),
          accountId, String(current.id), String(metadata.updated_at || now),
          JSON.stringify({ sub2apiId: metadata.id, observedEmail: email, identityHash, candidateAccountIds: match.candidateAccountIds }), now,
        );
      } else if (String(current.local_part) === splitEmail(email).localPart) {
        const incomingChangedAt = Date.parse(String(metadata.updated_at || ""));
        const currentValidFrom = Date.parse(String(current.valid_from || ""));
        // Sub2API can retain an older credentials.email after V1 has already
        // recorded a newer explicit rebind.  Applying that stale value would
        // make the primary address oscillate on every shadow refresh.
        if (Number.isFinite(incomingChangedAt) && Number.isFinite(currentValidFrom) && incomingChangedAt <= currentValidFrom) {
          // Keep the current binding and still refresh credentials below.
        } else {
          try {
            const result = rebindAccountTransition(accountId, email, {
              source: "sub2api",
              associationMethod: match.method === "trusted_exact_local_part" ? "sub2api_trusted_local_rebind" : "sub2api_identity_rebind",
              changedAt: String(metadata.updated_at || now),
              evidence: { sub2apiId: metadata.id, identityHash, matchMethod: match.method },
            });
            rebind = result.changed;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            addPendingReview(accountId, email, reason, { sub2apiId: metadata.id, identityHash, matchMethod: match.method });
            conflict = true;
          }
        }
      } else {
        addPendingReview(accountId, email, "OpenAI身份一致，但完整邮箱本地部分不同，禁止自动改绑", { sub2apiId: metadata.id, identityMatched: true });
        conflict = true;
      }
    }
  }
  if (topologyWritable && !conflict && identityHash) {
    const identity = recordIdentityObservation(accountId, identityHash, "sub2api", { sub2apiId: metadata.id, email });
    conflict = identity.conflict;
  }
  if (!conflict && !staleHistoricalEmail) updateCredential(accountId, item, metadata, identityHash, now);
  return { accountId, created, rebind, conflict, skipped: false };
}

export async function syncSub2ApiAlive(): Promise<{ total: number; active: number; matched: number; created: number; rebinds: number; conflicts: number; skipped: number }> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  db.prepare("INSERT INTO sub2api_sync_runs(id, started_at, status) VALUES(?, ?, 'running')").run(runId, startedAt);
  try {
    const token = await accessToken();
    const metadata = await listAccounts(token);
    const exported = await request("/admin/accounts/data", { token });
    const rawAccounts = Array.isArray(exported?.accounts) ? exported.accounts : [];
    const metadataByKey = new Map<string, JsonObject[]>();
    for (const item of metadata) {
      for (const key of rawAccountKey(item)) {
        const list = metadataByKey.get(key) || [];
        list.push(item);
        metadataByKey.set(key, list);
      }
    }
    const active = metadata.filter((item) => isSub2ApiMailboxAccount(item) && String(item.status || "").toLowerCase() === "active").length;
    let matched = 0, created = 0, rebinds = 0, conflicts = 0, processedActive = 0;
    const handledMetadata = new Set<string>();
    const transaction = db.transaction(() => {
      // A credential is alive only when it is present in the current active OpenAI export.
      // Keep the encrypted material for audit/recovery, but never leave stale green AT/RT flags behind.
      db.prepare("UPDATE credentials SET access_token_alive=0, refresh_token_alive=0, updated_at=? WHERE source='sub2api-active'")
        .run(new Date().toISOString());
      db.prepare(`UPDATE credential_versions SET validity_status='unknown', updated_at=?
        WHERE source='sub2api-active' AND validity_status='alive'
          AND id IN (SELECT credential_version_id FROM account_current_credentials)`).run(new Date().toISOString());
      db.prepare("UPDATE pending_reviews SET status='resolved', updated_at=? WHERE review_type LIKE 'sub2api_%' AND status='pending'")
        .run(new Date().toISOString());
      for (const item of rawAccounts) {
        if (!isSub2ApiMailboxAccount(item)) continue;
        const meta = matchMetadata(item, metadataByKey);
        if (!meta || !isSub2ApiMailboxAccount(meta) || String(meta.status || "").toLowerCase() !== "active") continue;
        handledMetadata.add(String(meta.id || meta.name));
        const result = ensureSub2ApiAccount(item, meta);
        if (result.skipped) {
          if (!config.readOnly) addUnresolvedReview(meta, "Sub2API活账号缺少可定位邮箱，且OpenAI身份无法唯一匹配现有GPT账号");
          continue;
        }
        processedActive += 1;
        matched += result.created ? 0 : 1;
        created += result.created ? 1 : 0;
        rebinds += result.rebind ? 1 : 0;
        conflicts += result.conflict ? 1 : 0;
      }
      for (const meta of metadata) {
        if (!isSub2ApiMailboxAccount(meta) || String(meta.status || "").toLowerCase() !== "active") continue;
        if (handledMetadata.has(String(meta.id || meta.name))) continue;
        if (!config.readOnly) addUnresolvedReview(meta, "Sub2API活账号无法与原始凭证导出唯一匹配，已禁止自动导入");
      }
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES('sub2api_active_count', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(String(active), now);
      db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES('sub2api_last_sync_at', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(now, now);
    });
    transaction();
    const skipped = Math.max(0, active - processedActive);
    const finishedAt = new Date().toISOString();
    db.prepare(`UPDATE sub2api_sync_runs SET finished_at=?, total_count=?, active_openai_count=?, matched_count=?, created_count=?,
      rebind_count=?, conflict_count=?, skipped_count=?, status='ok' WHERE id=?`).run(finishedAt, metadata.length, active, matched, created, rebinds, conflicts, skipped, runId);
    return { total: metadata.length, active, matched, created, rebinds, conflicts, skipped };
  } catch (error) {
    db.prepare("UPDATE sub2api_sync_runs SET finished_at=?, status='error', detail_json=? WHERE id=?").run(
      new Date().toISOString(), JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), runId,
    );
    throw error;
  }
}
