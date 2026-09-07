import crypto from "node:crypto";
import { emailHash, normalizeEmail, splitEmail, stableId } from "./association.js";
import { config } from "./config.js";
import { encryptSecret } from "./crypto.js";
import { db } from "./db.js";
import { observeAccessToken } from "./access-token-observation.js";
import { isStrictPlusEvidenceSubject } from "./plus-evidence.js";
import {
  rebindAccountTransition,
  recordIdentityObservation,
  resolveAccountMatch,
  quarantineAccount,
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
  if (candidates.size === 1) return [...candidates.values()][0];
  const name = String(item.name || "").trim().toLowerCase();
  if (name) {
    const exactName = [...candidates.values()].filter((candidate) => String(candidate.name || "").trim().toLowerCase() === name);
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

function identityMaterial(item: JsonObject): { identityHash: string; email: string } {
  const credentials = item.credentials || {};
  const identity = String(credentials.chatgpt_user_id || credentials.user_id || credentials.sub || "");
  const email = normalizeEmail(credentials.email || item.extra?.email || item.name);
  return { identityHash: identity ? sha256(identity) : "", email };
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

function hasPlusActivationMailEvidence(accountId: string): boolean {
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
  const existing = db.prepare("SELECT access_token_fingerprint, access_token_first_seen_at FROM credentials WHERE account_id=?").get(accountId) as any;
  const tokenObservation = observeAccessToken(accessToken, existing ? {
    fingerprint: String(existing.access_token_fingerprint || ""),
    firstSeenAt: String(existing.access_token_first_seen_at || ""),
  } : null, now);
  db.prepare(`INSERT INTO credentials(
    account_id, access_token_enc, refresh_token_enc, id_token_enc, openai_subject_hash,
    access_token_alive, refresh_token_alive, source, source_updated_at, access_token_fingerprint, access_token_first_seen_at, updated_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, 'sub2api-active', ?, ?, ?, ?)
  ON CONFLICT(account_id) DO UPDATE SET
    access_token_enc=CASE WHEN excluded.access_token_enc!='' THEN excluded.access_token_enc ELSE credentials.access_token_enc END,
    refresh_token_enc=CASE WHEN excluded.refresh_token_enc!='' THEN excluded.refresh_token_enc ELSE credentials.refresh_token_enc END,
    id_token_enc=CASE WHEN excluded.id_token_enc!='' THEN excluded.id_token_enc ELSE credentials.id_token_enc END,
    openai_subject_hash=CASE WHEN excluded.openai_subject_hash!='' THEN excluded.openai_subject_hash ELSE credentials.openai_subject_hash END,
    access_token_alive=excluded.access_token_alive, refresh_token_alive=excluded.refresh_token_alive,
    access_token_fingerprint=CASE WHEN excluded.access_token_fingerprint!='' THEN excluded.access_token_fingerprint ELSE credentials.access_token_fingerprint END,
    access_token_first_seen_at=CASE WHEN excluded.access_token_fingerprint!='' THEN excluded.access_token_first_seen_at ELSE credentials.access_token_first_seen_at END,
    source=excluded.source, source_updated_at=excluded.source_updated_at, updated_at=excluded.updated_at`).run(
    accountId, encryptSecret(accessToken), encryptSecret(refreshToken), encryptSecret(idToken), identityHash,
    accessToken ? 1 : 0, refreshToken ? 1 : 0, String(metadata.updated_at || now), tokenObservation.fingerprint, tokenObservation.firstSeenAt, now,
  );
  if (credentials.plan_type) {
    const incomingPlan = String(credentials.plan_type).toLowerCase();
    // Sub2API can report a stale Free snapshot after Plus was activated. A
    // persisted activation receipt is stronger evidence than that snapshot,
    // so never downgrade a mailbox with a confirmed Plus mail.
    const plan = incomingPlan === "plus" || hasPlusActivationMailEvidence(accountId) ? "plus" : incomingPlan;
    db.prepare("UPDATE gpt_accounts SET plan=?, updated_at=? WHERE id=?").run(plan, now, accountId);
  }
}

function ensureSub2ApiAccount(item: JsonObject, metadata: JsonObject): { accountId: string; created: boolean; rebind: boolean; conflict: boolean; skipped: boolean } {
  const credentials = item.credentials || {};
  const { email, identityHash } = identityMaterial(item);
  const parts = splitEmail(email);
  if (!parts.localPart || !parts.domain) {
    const identityOnly = identityHash ? resolveAccountMatch(identityHash, "") : null;
    if (!identityOnly || identityOnly.kind !== "account") return { accountId: "", created: false, rebind: false, conflict: Boolean(identityOnly?.kind === "conflict"), skipped: true };
    const now = new Date().toISOString();
    const identity = recordIdentityObservation(identityOnly.accountId, identityHash, "sub2api", { sub2apiId: metadata.id });
    if (identity.conflict) return { accountId: identityOnly.accountId, created: false, rebind: false, conflict: true, skipped: false };
    updateCredential(identityOnly.accountId, item, metadata, identityHash, now);
    return { accountId: identityOnly.accountId, created: false, rebind: false, conflict: false, skipped: false };
  }
  const match = resolveAccountMatch(identityHash, email);
  const now = new Date().toISOString();
  if (match.kind === "conflict") {
    if (match.accountId && ["identity_email_conflict", "contradictory_identity", "trusted_local_identity_conflict"].includes(match.method)) {
      quarantineAccount(match.accountId, match.reason, "sub2api", { sub2apiId: metadata.id, identityHash, email, candidateAccountIds: match.candidateAccountIds });
    }
    addPendingReview(match.accountId || null, email, match.reason, {
      sub2apiId: metadata.id, identityHash, candidateAccountIds: match.candidateAccountIds, matchMethod: match.method,
    });
    return { accountId: match.accountId, created: false, rebind: false, conflict: true, skipped: false };
  }
  let accountId = match.accountId;
  let created = false;
  let rebind = false;
  let conflict = false;
  let staleHistoricalEmail = false;

  if (!accountId) {
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
      if (historical) {
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
  if (!conflict && identityHash) {
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
    const active = metadata.filter((item) => String(item.platform || "").toLowerCase() === "openai" && String(item.status || "").toLowerCase() === "active").length;
    let matched = 0, created = 0, rebinds = 0, conflicts = 0, processedActive = 0;
    const handledMetadata = new Set<string>();
    const transaction = db.transaction(() => {
      // A credential is alive only when it is present in the current active OpenAI export.
      // Keep the encrypted material for audit/recovery, but never leave stale green AT/RT flags behind.
      db.prepare("UPDATE credentials SET access_token_alive=0, refresh_token_alive=0, updated_at=? WHERE source='sub2api-active'")
        .run(new Date().toISOString());
      db.prepare("UPDATE pending_reviews SET status='resolved', updated_at=? WHERE review_type LIKE 'sub2api_%' AND status='pending'")
        .run(new Date().toISOString());
      for (const item of rawAccounts) {
        if (String(item.platform || "").toLowerCase() !== "openai") continue;
        const meta = matchMetadata(item, metadataByKey);
        if (!meta || String(meta.status || "").toLowerCase() !== "active") continue;
        handledMetadata.add(String(meta.id || meta.name));
        const result = ensureSub2ApiAccount(item, meta);
        if (result.skipped) {
          addUnresolvedReview(meta, "Sub2API活账号缺少可定位邮箱，且OpenAI身份无法唯一匹配现有GPT账号");
          continue;
        }
        processedActive += 1;
        matched += result.created ? 0 : 1;
        created += result.created ? 1 : 0;
        rebinds += result.rebind ? 1 : 0;
        conflicts += result.conflict ? 1 : 0;
      }
      for (const meta of metadata) {
        if (String(meta.platform || "").toLowerCase() !== "openai" || String(meta.status || "").toLowerCase() !== "active") continue;
        if (handledMetadata.has(String(meta.id || meta.name))) continue;
        addUnresolvedReview(meta, "Sub2API活账号无法与原始凭证导出唯一匹配，已禁止自动导入");
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
