import { simpleParser } from "mailparser";
import { emailHash, normalizeEmail, stableId } from "./association.js";
import { config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { db } from "./db.js";
import { classifyMail } from "./mail-classification.js";
import { fetchSharedMailPage, listOutlookManagerAccounts, listOutlookManagerMails } from "./upstream-mail.js";

interface RoutingRule {
  id: string;
  binding_id: string;
  account_id: string;
  sender_pattern: string;
  recipient_pattern: string;
  valid_from: string;
  valid_to: string;
  receive_disabled_at: string;
}

interface FixedBindingClaim {
  binding_id: string;
  account_id: string;
  valid_from: string;
  valid_to: string;
  receive_disabled_at: string;
}

interface NormalizedMail {
  providerMessageId: string;
  sender: string;
  recipients: string[];
  subject: string;
  receivedAt: string;
  folder: string;
  metadata: Record<string, unknown>;
}

function iso(value: unknown, fallback = new Date().toISOString()): string {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function uniqueEmails(values: unknown[]): string[] {
  const matches = values.flatMap((value) => String(value || "").match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []);
  return [...new Set(matches.map(normalizeEmail).filter(Boolean))];
}

function addressValues(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(addressValues);
  if (Array.isArray(value.value)) return value.value.map((item: any) => String(item?.address || ""));
  return [String(value.address || value.text || value || "")];
}

function matchesPattern(values: string[], pattern: string): boolean {
  if (!pattern) return true;
  try {
    const regex = new RegExp(pattern, "i");
    return values.some((value) => regex.test(value));
  } catch {
    const wanted = pattern.toLowerCase();
    return values.some((value) => value.toLowerCase() === wanted);
  }
}

function inWindow(receivedAt: string, rule: RoutingRule): boolean {
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(received)) return false;
  const from = Date.parse(rule.valid_from || "");
  const to = Date.parse(rule.valid_to || rule.receive_disabled_at || "");
  if (Number.isFinite(from) && received < from) return false;
  if (Number.isFinite(to) && received > to) return false;
  return true;
}

function routingRules(): RoutingRule[] {
  return db.prepare(`SELECT r.id, r.binding_id, b.account_id, r.sender_pattern, r.recipient_pattern,
      r.valid_from, r.valid_to, b.receive_disabled_at
    FROM mail_routing_rules r JOIN email_bindings b ON b.id=r.binding_id`).all() as RoutingRule[];
}

async function normalizeSharedMail(mail: any): Promise<NormalizedMail | null> {
  const providerMessageId = String(mail?.id || "");
  if (!providerMessageId) return null;
  const parsed = await simpleParser(String(mail?.raw || ""), {
    skipHtmlToText: false,
    skipTextToHtml: true,
  });
  const headerRecipients = [
    parsed.to,
    parsed.cc,
    parsed.headers.get("delivered-to"),
    parsed.headers.get("x-original-to"),
    parsed.headers.get("envelope-to"),
    mail?.address,
  ].flatMap(addressValues);
  const sender = normalizeEmail(parsed.from?.value?.[0]?.address || String(parsed.from?.text || mail?.source || ""));
  return {
    providerMessageId,
    sender,
    recipients: uniqueEmails(headerRecipients),
    subject: String(parsed.subject || "(无主题)"),
    receivedAt: iso(parsed.date || mail?.created_at),
    folder: "inbox",
    metadata: {
      upstreamMessageId: String(mail?.message_id || ""),
      source: "shared-mail-api-v2",
      bodyAvailable: Boolean(parsed.text || parsed.html),
    },
  };
}

function upsertMail(provider: string, mail: NormalizedMail, rules: RoutingRule[], fixedBinding?: FixedBindingClaim): { inserted: boolean; claims: number } {
  const now = new Date().toISOString();
  const id = stableId("mail-message", provider, mail.providerMessageId);
  const classification = classifyMail(mail.subject, mail.sender);
  const existing = db.prepare("SELECT 1 FROM mail_messages WHERE provider=? AND provider_message_id=?").get(provider, mail.providerMessageId);
  const candidates = fixedBinding
    ? (inWindow(mail.receivedAt, fixedBinding as RoutingRule) ? [fixedBinding] : [])
    : rules.filter((rule) => inWindow(mail.receivedAt, rule)
      && matchesPattern([mail.sender], rule.sender_pattern)
      && matchesPattern(mail.recipients, rule.recipient_pattern));
  const distinctAccounts = new Set(candidates.map((rule) => rule.account_id));
  const visible = distinctAccounts.size === 1 ? 1 : 0;
  db.transaction(() => {
    db.prepare(`INSERT INTO mail_messages(
        id, provider, provider_message_id, sender, recipient_enc, subject, received_at, folder, category, is_security, metadata_json, indexed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, provider_message_id) DO UPDATE SET sender=excluded.sender,
        recipient_enc=excluded.recipient_enc, subject=excluded.subject, received_at=excluded.received_at,
        folder=excluded.folder, category=excluded.category, is_security=excluded.is_security,
        metadata_json=excluded.metadata_json, indexed_at=excluded.indexed_at`).run(
      id, provider, mail.providerMessageId, mail.sender, encryptSecret(mail.recipients[0] || ""), mail.subject,
      mail.receivedAt, mail.folder, classification.category, classification.isSecurity ? 1 : 0,
      JSON.stringify(mail.metadata), now,
    );
    for (const rule of candidates) {
      db.prepare(`INSERT INTO mail_ownership_claims(
          message_id, account_id, binding_id, claim_type, confidence, reason, visible_to_customer, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id, binding_id) DO UPDATE SET account_id=excluded.account_id,
          claim_type=excluded.claim_type, confidence=excluded.confidence, reason=excluded.reason,
          visible_to_customer=excluded.visible_to_customer`).run(
        id, rule.account_id, rule.binding_id, fixedBinding ? "outlook_connection" : "routing_rule",
        fixedBinding ? 1.1 : 1, fixedBinding ? "V2 Outlook 连接与邮箱绑定一致" : "V2 路由规则和绑定时间窗口一致",
        visible, now,
      );
    }
    if (distinctAccounts.size > 1) {
      db.prepare("UPDATE mail_ownership_claims SET visible_to_customer=0 WHERE message_id=?").run(id);
    }
  })();
  return { inserted: !existing, claims: candidates.length };
}

function updateSyncState(source: string, cursor: string, error = "", newestAt = ""): void {
  const now = new Date().toISOString();
  const newest = Date.parse(newestAt);
  const lag = error || !Number.isFinite(newest) ? 0 : Math.max(0, (Date.now() - newest) / 1_000);
  db.prepare(`INSERT INTO mailbox_sync_state(source, cursor, source_revision, lag_seconds, last_success_at, last_error, updated_at)
    VALUES(?, ?, '', ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor, lag_seconds=excluded.lag_seconds,
      last_success_at=CASE WHEN excluded.last_error='' THEN excluded.last_success_at ELSE mailbox_sync_state.last_success_at END,
      last_error=excluded.last_error, updated_at=excluded.updated_at`).run(source, cursor, lag, error ? "" : now, error, now);
}

export async function syncSharedMail(): Promise<{ fetched: number; inserted: number; claims: number; cursor: string }> {
  const source = "shared-mail-api";
  const state = db.prepare("SELECT cursor FROM mailbox_sync_state WHERE source=?").get(source) as any;
  const existingMax = db.prepare(`SELECT MAX(CAST(provider_message_id AS INTEGER)) value FROM mail_messages
    WHERE provider='shared-mail-api' AND provider_message_id GLOB '[0-9]*'`).get() as any;
  const cursor = String(state?.cursor || existingMax?.value || "0");
  const boundary = Number(cursor) || 0;
  const incoming: any[] = [];
  let newestAt = "";
  let newestId = boundary;
  try {
    for (let page = 0; page < config.sharedMailMaxPages; page += 1) {
      const payload = await fetchSharedMailPage(page * config.sharedMailPageSize, config.sharedMailPageSize);
      const rows = Array.isArray(payload?.results) ? payload.results : [];
      if (!rows.length) break;
      for (const row of rows) {
        const id = Number(row?.id || 0);
        if (id > newestId) {
          newestId = id;
          newestAt = String(row?.created_at || newestAt);
        }
        if (id > boundary) incoming.push(row);
      }
      if (rows.some((row: any) => Number(row?.id || 0) <= boundary) || rows.length < config.sharedMailPageSize) break;
    }
    const rules = routingRules();
    let inserted = 0;
    let claims = 0;
    for (const raw of incoming.sort((left, right) => Number(left.id) - Number(right.id))) {
      const normalized = await normalizeSharedMail(raw);
      if (!normalized) continue;
      const result = upsertMail(source, normalized, rules);
      inserted += result.inserted ? 1 : 0;
      claims += result.claims;
    }
    const nextCursor = String(Math.max(boundary, newestId));
    updateSyncState(source, nextCursor, "", newestAt);
    return { fetched: incoming.length, inserted, claims, cursor: nextCursor };
  } catch (error) {
    updateSyncState(source, cursor, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function outlookMail(item: any): NormalizedMail | null {
  const id = String(item?.id || item?.detailId || "");
  if (!id) return null;
  return {
    providerMessageId: id,
    sender: normalizeEmail(item?.from?.emailAddress?.address || item?.from?.address || item?.from || ""),
    recipients: uniqueEmails(addressValues(item?.to)),
    subject: String(item?.subject || "(无主题)"),
    receivedAt: iso(item?.date || item?.created_at),
    folder: String(item?.folder || "inbox").toLowerCase(),
    metadata: { source: "outlook-manager-v2", idMode: String(item?.id_mode || ""), method: "graph" },
  };
}

export async function syncOutlookMailboxes(): Promise<{ mailboxes: number; fetched: number; inserted: number; errors: number }> {
  const managerAccounts = await listOutlookManagerAccounts();
  const byHash = new Map(managerAccounts.map((item) => [emailHash(normalizeEmail(item?.email)), item]));
  const connections = db.prepare(`SELECT c.id, c.binding_id, c.external_account_id, b.account_id,
      b.valid_from, b.valid_to, b.receive_disabled_at
    FROM mailbox_connections c JOIN email_bindings b ON b.id=c.binding_id
    WHERE c.provider='outlook-manager' AND c.status='active'`).all() as any[];
  const rules = routingRules();
  let mailboxes = 0;
  let fetched = 0;
  let inserted = 0;
  let errors = 0;
  for (const connection of connections) {
    const manager = byHash.get(String(connection.external_account_id || ""));
    if (!manager?.email) continue;
    const source = `outlook:${connection.external_account_id}`;
    try {
      const payload = await listOutlookManagerMails(String(manager.email), 0, config.outlookMailSyncBatch);
      const rows = Array.isArray(payload?.emails) ? payload.emails : [];
      mailboxes += 1;
      fetched += rows.length;
      let newestAt = "";
      for (const row of rows) {
        const normalized = outlookMail(row);
        if (!normalized) continue;
        if (Date.parse(normalized.receivedAt) > Date.parse(newestAt || "")) newestAt = normalized.receivedAt;
        const result = upsertMail(source, normalized, rules, {
          binding_id: String(connection.binding_id),
          account_id: String(connection.account_id),
          valid_from: String(connection.valid_from || ""),
          valid_to: String(connection.valid_to || ""),
          receive_disabled_at: String(connection.receive_disabled_at || ""),
        });
        inserted += result.inserted ? 1 : 0;
      }
      updateSyncState(source, newestAt, "", newestAt);
      db.prepare("UPDATE mailbox_connections SET last_checked_at=?, updated_at=? WHERE id=?")
        .run(new Date().toISOString(), new Date().toISOString(), connection.id);
    } catch (error) {
      errors += 1;
      updateSyncState(source, "", error instanceof Error ? error.message : String(error));
    }
  }
  return { mailboxes, fetched, inserted, errors };
}
