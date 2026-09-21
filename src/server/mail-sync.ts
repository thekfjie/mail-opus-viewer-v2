import { simpleParser } from "mailparser";
import crypto from "node:crypto";
import { emailHash, normalizeEmail, splitEmail, stableId } from "./association.js";
import { config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { db } from "./db.js";
import { classifyMail } from "./mail-classification.js";
import { indexMailRecipients } from "./mail-recipient-index.js";
import { sharedMailReader, sharedMailRaw, listOutlookManagerAccounts, listOutlookManagerMails } from "./upstream-mail.js";
import { MailReadError, validateBackfillWindow, type BackfillWindow, type D1MailReader } from "./cf-mail.js";
import { noticeEvidence, resolveNoticeEvidence, type NoticeEvidence } from "./mail-account-evidence.js";
import { deriveBillingMailEvidence, type BillingMailEvidence } from "./billing-evidence.js";
import { mailboxBatchKey } from "./mailbox-batch.js";

interface RoutingRule {
  id: string;
  binding_id: string;
  account_id: string;
  binding_email: string;
  sender_pattern: string;
  recipient_pattern: string;
  valid_from: string;
  valid_to: string;
  receive_disabled_at: string;
  is_current: number;
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
  bodyText?: string;
  bodyHtml?: string;
  noticeEvidence?: NoticeEvidence;
  billingEvidence: BillingMailEvidence;
}

function iso(value: unknown, fallback = new Date().toISOString()): string {
  const input = String(value || "");
  const time = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(input) ? `${input.replace(" ", "T")}Z` : input);
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

const ICLOUD_ALIAS_REGISTRATION_GRACE_MS = 5 * 60 * 1000;

function inWindow(receivedAt: string, rule: RoutingRule, allowRegistrationGrace = false): boolean {
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(received)) return false;
  const from = Date.parse(rule.valid_from || "");
  const to = Date.parse(rule.valid_to || "");
  const disabledAt = Date.parse(rule.receive_disabled_at || "");
  if (Number.isFinite(from) && received < from
    && (!allowRegistrationGrace || received + ICLOUD_ALIAS_REGISTRATION_GRACE_MS < from)) return false;
  if (Number.isFinite(to) && received >= to) return false;
  if (Number.isFinite(disabledAt) && received > disabledAt) return false;
  return true;
}

function routingRules(): RoutingRule[] {
  const rows = db.prepare(`SELECT r.id, r.binding_id, b.account_id, b.email_enc, r.sender_pattern, r.recipient_pattern,
      r.valid_from, r.valid_to, b.receive_disabled_at, b.is_current
    FROM mail_routing_rules r JOIN email_bindings b ON b.id=r.binding_id
    JOIN gpt_accounts a ON a.id=b.account_id
    WHERE NOT (a.source_status='recovered' AND a.lifecycle_status='retired' AND b.is_current=0)`).all() as Array<RoutingRule & { email_enc: string }>;
  return rows.map((row) => {
    let bindingEmail = "";
    try { bindingEmail = normalizeEmail(decryptSecret(String(row.email_enc || ""))); } catch {}
    const { email_enc: _emailEnc, ...rule } = row;
    return { ...rule, binding_email: bindingEmail };
  });
}

function iCloudAddressEquivalent(leftInput: string, rightInput: string): boolean {
  const left = splitEmail(normalizeEmail(leftInput));
  const right = splitEmail(normalizeEmail(rightInput));
  if (!left.localPart || !left.domain || !right.localPart || left.domain !== right.domain) return false;
  if (left.localPart === right.localPart) return true;
  if (left.domain !== "icloud.com" && !left.domain.endsWith(".icloud.com")) return false;
  const leftPlus = left.localPart.includes("+");
  const rightPlus = right.localPart.includes("+");
  if (leftPlus === rightPlus) return false;
  const base = leftPlus ? left.localPart.split("+", 1)[0] : left.localPart;
  const otherBase = rightPlus ? right.localPart.split("+", 1)[0] : right.localPart;
  return base === otherBase;
}

function matchesRecipientRule(recipients: string[], rule: RoutingRule): boolean {
  if (matchesPattern(recipients, rule.recipient_pattern)) return true;
  if (!rule.binding_email || !rule.recipient_pattern) return false;
  // iCloud forwarding can collapse a plus alias to its base address. Match
  // only the rule's own binding and only when exactly one side has a plus
  // suffix; two unrelated aliases must remain distinct.
  return recipients.some((recipient) => iCloudAddressEquivalent(recipient, rule.binding_email)
    && matchesPattern([rule.binding_email, recipient], rule.recipient_pattern));
}

function preferExactRecipientOwners(rules: RoutingRule[], recipients: string[]): RoutingRule[] {
  const normalizedRecipients = new Set(recipients.map(normalizeEmail).filter(Boolean));
  const exactBatches = new Set(rules.filter((rule) => normalizedRecipients.has(rule.binding_email))
    .map((rule) => mailboxBatchKey(rule.binding_email)).filter(Boolean));
  if (!exactBatches.size) return rules;
  // A complete alias identifies the physical mailbox batch, not one child
  // account inside it. All concurrently eligible bindings in that batch share
  // the delivery.
  return rules.filter((rule) => exactBatches.has(mailboxBatchKey(rule.binding_email)));
}

function expandMatchedMailboxBatches(allSenderRules: RoutingRule[], matchedRules: RoutingRule[]): RoutingRule[] {
  const batches = new Set(matchedRules.map((rule) => mailboxBatchKey(rule.binding_email)).filter(Boolean));
  if (!batches.size) return matchedRules;
  return allSenderRules.filter((rule) => batches.has(mailboxBatchKey(rule.binding_email)));
}

function iCloudBaseAddress(emailInput: string): string {
  const email = normalizeEmail(emailInput);
  const parts = splitEmail(email);
  if (!parts.localPart || !(parts.domain === "icloud.com" || parts.domain.endsWith(".icloud.com"))) return "";
  const localPart = parts.localPart.replace(/\+oai[a-z0-9]+$/i, "");
  return localPart ? `${localPart}@${parts.domain}` : "";
}

function uniqueICloudBaseOwner(rules: RoutingRule[], recipients: string[], receivedAt: string): string {
  const normalized = [...new Set(recipients.map(normalizeEmail).filter(Boolean))];
  // A retained concrete alias is authoritative. Temporal fallback is only for
  // iCloud's rewritten bare base recipient.
  if (normalized.some((recipient) => /\+oai[a-z0-9]+@(?:[^@]+\.)?icloud\.com$/i.test(recipient))) return "";
  const bases = [...new Set(normalized.filter((recipient) => {
    const parts = splitEmail(recipient);
    return Boolean(parts.localPart && !parts.localPart.includes("+")
      && (parts.domain === "icloud.com" || parts.domain.endsWith(".icloud.com")));
  }))];
  const received = Date.parse(receivedAt);
  if (bases.length !== 1 || !Number.isFinite(received)) return "";
  const byBinding = new Map<string, RoutingRule>();
  for (const rule of rules) {
    if (iCloudBaseAddress(rule.binding_email) !== bases[0]) continue;
    if (!inWindow(receivedAt, rule, true)) continue;
    const existing = byBinding.get(rule.binding_id);
    if (!existing || Date.parse(rule.valid_from || "") > Date.parse(existing.valid_from || "")) {
      byBinding.set(rule.binding_id, rule);
    }
  }
  const candidates = [...byBinding.values()].sort((left, right) =>
    (Date.parse(right.valid_from || "") || 0) - (Date.parse(left.valid_from || "") || 0)
    || Number(right.is_current) - Number(left.is_current));
  if (!candidates.length) return "";
  // A bare pool address contains no child identity. Several concurrently
  // eligible accounts must remain ambiguous even if one binding was created
  // more recently; creation time is not ownership evidence.
  if (new Set(candidates.map((candidate) => candidate.account_id)).size > 1) return "";
  const newestStart = Date.parse(candidates[0].valid_from || "") || 0;
  let winners = candidates.filter((candidate) => (Date.parse(candidate.valid_from || "") || 0) === newestStart);
  if (winners.length > 1) {
    const current = winners.filter((candidate) => Number(candidate.is_current));
    if (current.length === 1) winners = current;
  }
  return winners.length === 1 ? winners[0].binding_id : "";
}

function pendingMailboxIdsForBaseRecipient(recipient: string): string[] {
  const target = normalizeEmail(recipient);
  const parts = splitEmail(target);
  if (!target || !parts.localPart || !parts.domain || parts.localPart.includes("+")
    || !(parts.domain === "icloud.com" || parts.domain.endsWith(".icloud.com"))) return [];
  // Pending tasks are bounded by the OpenAI batch limit. The explicit limit
  // keeps a malformed or abandoned pool from becoming a table-wide scan.
  const rows = db.prepare(`SELECT id,email_enc FROM pending_mailboxes
    WHERE created_at<=? ORDER BY created_at DESC,id LIMIT 200`).all(new Date().toISOString()) as any[];
  return rows.flatMap((row) => {
    try {
      const pending = splitEmail(normalizeEmail(decryptSecret(String(row.email_enc || ""))));
      return pending.domain === parts.domain && pending.localPart.includes("+")
        && pending.localPart.split("+", 1)[0] === parts.localPart ? [String(row.id)] : [];
    } catch { return []; }
  });
}

async function normalizeSharedMail(mail: any): Promise<NormalizedMail | null> {
  const providerMessageId = String(mail?.id || "");
  if (!/^[1-9][0-9]{0,15}$/.test(providerMessageId) || !Number.isSafeInteger(Number(providerMessageId))) throw new MailReadError("invalid_mail_id", 400);
  const raw = sharedMailRaw(mail);
  const parsed = await simpleParser(raw, {
    skipHtmlToText: false,
    skipTextToHtml: true,
  });
  const headerRecipients = [
    parsed.to,
    parsed.cc,
    ...["delivered-to", "x-original-to", "x-forwarded-to", "x-envelope-to", "envelope-to", "resent-to", "apparently-to"]
      .map((key) => parsed.headers.get(key)),
    mail?.address, mail?.to,
  ].flatMap(addressValues);
  for (const header of parsed.headerLines) {
    if (header.key === "received") {
      for (const match of header.line.matchAll(/\bfor\s+<([^>\r\n]+)>/gi)) headerRecipients.push(match[1]);
    }
    if (header.key === "x-icloud-hme") {
      for (const match of header.line.matchAll(/(?:^|[;\s])(?:p|f)=([^;\s]+)/gi)) headerRecipients.push(match[1]);
    }
  }
  const sender = normalizeEmail(parsed.from?.value?.[0]?.address || String(parsed.from?.text || mail?.source || mail?.from || ""));
  const receivedAt = iso(mail?.created_at, "");
  const billingEvidence = deriveBillingMailEvidence(
    String(parsed.subject || mail?.subject || ""), String(parsed.text || ""), String(parsed.html || ""), sender,
  );
  return {
    providerMessageId,
    sender: sender.slice(0, 320),
    recipients: uniqueEmails(headerRecipients).filter((value) => value.length <= 320).slice(0, 100),
    subject: String(parsed.subject || mail?.subject || "(无主题)").replace(/\s+/g, " ").trim().slice(0, 2048),
    receivedAt,
    folder: "inbox",
    bodyText: String(parsed.text || ""),
    bodyHtml: String(parsed.html || ""),
    metadata: {
      source: "shared-mail-api-v2", receivedTimeVerified: Boolean(receivedAt),
    },
    noticeEvidence: noticeEvidence(String(parsed.subject || mail?.subject || ""), sender, String(parsed.text || "")),
    billingEvidence,
  };
}

function persistBillingEvidence(accountId: string, messageId: string, mail: NormalizedMail, source: string, now: string): void {
  if (config.readOnly || !mail.billingEvidence.confirmedPlus || !mail.receivedAt) return;
  db.prepare(`UPDATE gpt_accounts SET
      plan=CASE WHEN LOWER(TRIM(plan)) IN ('', 'unknown', 'free') THEN 'plus' ELSE plan END,
      billing_channel=CASE WHEN billing_channel='' AND ?!='' THEN ? ELSE billing_channel END,
      updated_at=? WHERE id=? AND deleted_at=''`).run(
    mail.billingEvidence.billingChannel, mail.billingEvidence.billingChannel, now, accountId,
  );
  db.prepare(`INSERT INTO account_business_evidence(account_id,billing_started_at,newest_mail_at,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
      billing_started_at=CASE WHEN account_business_evidence.billing_started_at='' THEN excluded.billing_started_at
        ELSE MIN(account_business_evidence.billing_started_at,excluded.billing_started_at) END,
      newest_mail_at=MAX(account_business_evidence.newest_mail_at,excluded.newest_mail_at),
      updated_at=excluded.updated_at`).run(accountId, mail.receivedAt, mail.receivedAt, now);
  db.prepare(`INSERT OR IGNORE INTO lifecycle_events(
      id,account_id,event_type,occurred_at,source,payload_json,created_at
    ) VALUES(?,?,'plus_activated_by_mail',?,?,?,?)`).run(
    stableId("event-plus-activation-mail", accountId, messageId), accountId, mail.receivedAt, source,
    JSON.stringify({ messageId, evidence: "account_level_subscription_body" }), now,
  );
  if (mail.billingEvidence.billingChannel) {
    db.prepare(`INSERT INTO billing_channel_observations(
        id,account_id,channel,source,evidence_id,observed_at,active
      ) VALUES(?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET channel=excluded.channel,source=excluded.source,
        observed_at=excluded.observed_at,active=1`).run(
      stableId("billing-channel-observation", accountId, messageId), accountId,
      mail.billingEvidence.billingChannel, source, messageId, mail.receivedAt,
    );
  }
}

function upsertMail(provider: string, mail: NormalizedMail, rules: RoutingRule[], fixedBinding?: FixedBindingClaim): { inserted: boolean; claims: number; deactivated: boolean } {
  const now = new Date().toISOString();
  const id = stableId("mail-message", provider, mail.providerMessageId);
  const classification = classifyMail(mail.subject, mail.sender, mail.bodyText || "", mail.bodyHtml || "");
  const existing = db.prepare("SELECT * FROM mail_messages WHERE provider=? AND provider_message_id=?").get(provider, mail.providerMessageId) as any;
  // A migrated index does not verify this event's complete routing headers.
  // Preserve its known values while the event still waits for an upstream ID read.
  const preserveExisting = Boolean(existing && !mail.receivedAt);
  const storedSender = preserveExisting ? existing.sender : mail.sender || existing?.sender || "";
  const storedRecipient = preserveExisting || !mail.recipients.length
    ? existing?.recipient_enc || encryptSecret(mail.recipients[0] || "") : encryptSecret(mail.recipients[0]);
  const storedSubject = preserveExisting || mail.subject === "(无主题)" ? existing?.subject || mail.subject : mail.subject;
  const storedReceivedAt = mail.receivedAt || existing?.received_at || "";
  const senderRules = fixedBinding ? [] : rules.filter((rule) => matchesPattern([mail.sender], rule.sender_pattern));
  let matchedRules = fixedBinding
    ? [fixedBinding]
    : expandMatchedMailboxBatches(senderRules, preferExactRecipientOwners(
      senderRules.filter((rule) => matchesRecipientRule(mail.recipients, rule)), mail.recipients));
  let notice = resolveNoticeEvidence(mail.noticeEvidence, [...new Set(matchedRules.map((rule) => rule.account_id))], mail.receivedAt);
  let baseOwnerBindingId = "";
  if (!fixedBinding && !notice.accountId && !notice.conflict) {
    baseOwnerBindingId = uniqueICloudBaseOwner(matchedRules as RoutingRule[], mail.recipients, mail.receivedAt);
    if (baseOwnerBindingId) matchedRules = matchedRules.filter((rule) => rule.binding_id === baseOwnerBindingId);
  }
  // iCloud can rotate the opaque sender alias independently of the recipient.
  // Only a trusted notice with a confirmed identity AND matching body address
  // may bridge a stale sender rule. Never relax routing for ordinary mail,
  // an arbitrary recipient, an unverified identity or a recovered shell.
  const recipientRules = !fixedBinding && classification.category === "deactivation" && mail.noticeEvidence
    ? preferExactRecipientOwners(rules.filter((rule) => Boolean(rule.recipient_pattern)
      && matchesRecipientRule(mail.recipients, rule)), mail.recipients) : [];
  if (recipientRules.length && mail.noticeEvidence?.identityHashes.length) {
    const verified = resolveNoticeEvidence(mail.noticeEvidence,
      [...new Set(recipientRules.map((rule) => rule.account_id))], mail.receivedAt);
    if (verified.accountId && !verified.conflict) {
      matchedRules = recipientRules.filter((rule) => rule.binding_id === verified.bindingId);
      notice = verified;
    } else if (!matchedRules.length) {
      notice = verified;
    }
  }
  const candidates = matchedRules.filter((rule) => inWindow(mail.receivedAt, rule as RoutingRule,
    Boolean(baseOwnerBindingId && rule.binding_id === baseOwnerBindingId))
    && (!notice.accountId || rule.binding_id === notice.bindingId));
  // A binding may match through both its exact alias rule and the mailbox-batch
  // base-address expansion. Ownership is unique per (message, binding), so the
  // public result must report persisted claims rather than matched rule rows.
  const candidateBindingCount = new Set(candidates.map((rule) => rule.binding_id)).size;
  const distinctAccounts = new Set(candidates.map((rule) => rule.account_id));
  const batchEvidenceRules = candidates.length ? candidates : (notice.accountId ? matchedRules : []);
  const distinctBatches = new Set(batchEvidenceRules.map((rule) => "binding_email" in rule
    ? mailboxBatchKey(String(rule.binding_email || "")) : String(rule.binding_id)));
  const visible = distinctBatches.size === 1 ? 1 : 0;
  let deactivated = false;
  db.transaction(() => {
    db.prepare(`INSERT INTO mail_messages(
        id, provider, provider_message_id, sender, recipient_enc, subject, received_at, folder, category, is_security, metadata_json, indexed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, provider_message_id) DO UPDATE SET sender=excluded.sender,
        recipient_enc=excluded.recipient_enc, subject=excluded.subject, received_at=excluded.received_at,
        folder=excluded.folder, category=excluded.category, is_security=excluded.is_security,
        metadata_json=excluded.metadata_json, indexed_at=excluded.indexed_at`).run(
      id, provider, mail.providerMessageId, storedSender, storedRecipient, storedSubject,
      storedReceivedAt, preserveExisting ? existing.folder : mail.folder,
      preserveExisting ? existing.category : classification.category,
      preserveExisting ? existing.is_security : classification.isSecurity ? 1 : 0,
      preserveExisting ? existing.metadata_json : JSON.stringify(mail.metadata), now,
    );
    if (!preserveExisting) {
      db.prepare("DELETE FROM mail_recipient_index WHERE message_id=?").run(id);
      indexMailRecipients(db, id, mail.recipients.length ? mail.recipients : [decryptSecret(storedRecipient)]);
      // These claims are projections of the current parsed headers/rules. A
      // verified re-read must replace stale projections rather than append a
      // second owner. Imported legacy index claims remain intact.
      db.prepare(`DELETE FROM mail_ownership_claims WHERE message_id=?
        AND claim_type IN ('routing_rule','account_notice','admin_verification','outlook_connection')`).run(id);
    }
    if (notice.accountId) {
      // A verified account notice replaces guesses made from a shared/base recipient.
      db.prepare("DELETE FROM mail_ownership_claims WHERE message_id=? AND binding_id<>?").run(id, notice.bindingId);
    }
    for (const rule of candidates) {
      db.prepare(`INSERT INTO mail_ownership_claims(
          message_id, account_id, binding_id, claim_type, confidence, reason, visible_to_customer, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id, binding_id) DO UPDATE SET account_id=excluded.account_id,
          claim_type=excluded.claim_type, confidence=excluded.confidence, reason=excluded.reason,
          visible_to_customer=excluded.visible_to_customer`).run(
        id, rule.account_id, rule.binding_id, fixedBinding ? "outlook_connection" : "routing_rule",
        fixedBinding ? 1.1 : 1, fixedBinding ? "V2 Outlook 连接与邮箱绑定一致" : "V25 邮箱批次路由和绑定时间窗口一致",
        visible, now,
      );
    }
    if (notice.accountId && notice.bindingId) {
      db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,confidence,reason,visible_to_customer,created_at)
        VALUES(?,?,?,'account_notice',1,'associated_account_and_identity_evidence',?,?)
        ON CONFLICT(message_id,binding_id) DO UPDATE SET claim_type=excluded.claim_type,confidence=excluded.confidence,
          reason=excluded.reason,visible_to_customer=excluded.visible_to_customer`)
        .run(id, notice.accountId, notice.bindingId, Number(distinctBatches.size === 1), now);
      db.prepare("UPDATE mail_messages SET metadata_json=? WHERE id=?")
        .run(JSON.stringify({ ...mail.metadata, method: "associated_account_notice" }), id);
    }
    const historicalSecurityRules = classification.category === "security" && mail.receivedAt
      && new Set(matchedRules.map((rule) => rule.account_id)).size === 1
      ? matchedRules.filter((rule) => !candidates.includes(rule)
        && (fixedBinding || ("recipient_pattern" in rule && Boolean(rule.recipient_pattern)))) : [];
    for (const rule of historicalSecurityRules) {
      // Only the explicit administrator OTP override may use this claim.
      db.prepare(`INSERT OR IGNORE INTO mail_ownership_claims(
        message_id,account_id,binding_id,claim_type,confidence,reason,visible_to_customer,created_at)
        VALUES(?,?,?,'admin_verification',1,'unique_recipient_outside_binding_window',0,?)`)
        .run(id, rule.account_id, rule.binding_id, now);
    }
    if (distinctBatches.size > 1) {
      db.prepare("UPDATE mail_ownership_claims SET visible_to_customer=0 WHERE message_id=?").run(id);
    }
    if (distinctAccounts.size === 1 && !notice.conflict) {
      persistBillingEvidence([...distinctAccounts][0], id, mail, `${provider}-sync`, now);
    }
    // A deactivation message is evidence only. It must never become an account
    // lock: only an explicit administrator action owns that state transition.
    // Ambiguous recycled-address notices still remain hidden and reviewed.
    const deactivationRules = fixedBinding
      ? matchedRules
      : matchedRules.filter((rule) => "recipient_pattern" in rule && Boolean(rule.recipient_pattern));
    const deactivationAccounts = new Set(notice.accountId ? [notice.accountId] : deactivationRules.map((rule) => rule.account_id));
    if (classification.category === "deactivation" && deactivationAccounts.size === 1 && !notice.conflict) {
      const accountId = [...deactivationAccounts][0];
      const account = db.prepare("SELECT id FROM gpt_accounts WHERE id=? AND deleted_at='' ").get(accountId) as any;
      if (account) db.prepare(`INSERT OR IGNORE INTO lifecycle_events(
          id,account_id,event_type,occurred_at,source,payload_json,created_at)
        VALUES(?,?,'deactivation_mail_detected',?,?,?,?)`).run(
        stableId("deactivation-mail-detected", accountId, id), accountId, mail.receivedAt || now, `${provider}-sync`,
        JSON.stringify({ messageId: id, automaticStateChange: false }), now,
      );
    }
    if (classification.category === "deactivation" && distinctBatches.size !== 1) {
      // No account may see an unresolved multi-generation ban, even if its date
      // happens to match the newest binding's normal delivery window.
      db.prepare("UPDATE mail_ownership_claims SET visible_to_customer=0 WHERE message_id=?").run(id);
      db.prepare(`INSERT INTO pending_reviews(id, review_type, candidate_email_enc, candidate_email_hash, reason, evidence_json, created_at, updated_at)
        VALUES(?, 'mail_ownership_ambiguous', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET candidate_email_enc=excluded.candidate_email_enc,
          evidence_json=excluded.evidence_json,reason=excluded.reason,updated_at=excluded.updated_at`).run(
        stableId("mail-review", id), encryptSecret(mail.recipients[0] || ""), emailHash(mail.recipients.join(",")),
        deactivationAccounts.size === 0 ? "deactivation_owner_unresolved" : "deactivation_recipient_has_multiple_identities",
        JSON.stringify({ messageId: id, accountIds: [...new Set([...deactivationAccounts, ...recipientRules.map((rule) => rule.account_id)])] }), now, now,
      );
    } else if (deactivationAccounts.size === 1 && !notice.conflict) {
      const resolvedAccountId = notice.accountId || [...deactivationAccounts][0];
      db.prepare(`UPDATE pending_reviews SET status='resolved',account_id=?,candidate_email_enc=?,updated_at=?
        WHERE id=? AND status='pending'`).run(resolvedAccountId, encryptSecret(mail.recipients[0] || ""), now, stableId("mail-review", id));
    }
  })();
  return { inserted: !existing, claims: candidateBindingCount, deactivated };
}

/** Re-read one already-indexed message by exact ID and apply body-confirmed
 * billing evidence. This operation performs one upstream by-ID read and never
 * stores the raw MIME, text or HTML. */
export async function recheckBillingEvidenceForMail(
  providerMessageId: string,
  reader: Pick<D1MailReader, "byId"> = sharedMailReader,
): Promise<{ matched: boolean; accountIds: string[]; messageId: string; billingChannel: string }> {
  const message = db.prepare(`SELECT id,provider,provider_message_id FROM mail_messages
    WHERE provider='shared-mail-api' AND provider_message_id=?`).get(providerMessageId) as any;
  if (!message) throw new MailReadError("mail_event_not_found", 404);
  const row = await reader.byId(providerMessageId);
  if (!row) throw new MailReadError("mail_upstream_missing", 404);
  const normalized = await normalizeSharedMail(row);
  if (!normalized || normalized.providerMessageId !== providerMessageId) throw new MailReadError("mail_upstream_id_mismatch", 409);
  // Rebuild the indexed projection from the exact upstream message so stale
  // webhook metadata cannot leave an old category or ownership decision in
  // place. The normalized body is used only in memory by upsertMail.
  if (normalized.receivedAt) upsertMail("shared-mail-api", normalized, routingRules());
  const accountIds = [...new Set((db.prepare(`SELECT account_id FROM mail_ownership_claims
      WHERE message_id=? AND visible_to_customer=1`).all(String(message.id)) as any[])
    .map((item) => String(item.account_id)).filter(Boolean))];
  const billingChannel = normalized.billingEvidence.billingChannel;
  if (!normalized.receivedAt || !normalized.billingEvidence.confirmedPlus) {
    return { matched: false, accountIds, messageId: String(message.id), billingChannel: "" };
  }
  if (accountIds.length === 1) {
    const now = new Date().toISOString();
    db.transaction(() => persistBillingEvidence(
      accountIds[0], String(message.id), normalized, "admin-billing-recheck", now,
    ))();
  }
  return { matched: true, accountIds, messageId: String(message.id), billingChannel };
}

/** Explicit administrator review only: one known indexed ID, one budgeted read;
 * never called by polling or by duplicate webhook deliveries. */
const pendingMailReviews = new Map<string, Promise<{ inserted: boolean; claims: number; deactivated: boolean; reviewId: string; status: string }>>();

export function reprocessReviewedMail(reviewId: string, reader: Pick<D1MailReader, "byId"> = sharedMailReader) {
  const pending = pendingMailReviews.get(reviewId);
  if (pending) return pending;
  const task = performMailReview(reviewId, reader).finally(() => pendingMailReviews.delete(reviewId));
  pendingMailReviews.set(reviewId, task);
  return task;
}

async function performMailReview(reviewId: string, reader: Pick<D1MailReader, "byId">) {
  const review = db.prepare("SELECT evidence_json FROM pending_reviews WHERE id=? AND review_type='mail_ownership_ambiguous' AND status='pending'")
    .get(reviewId) as any;
  if (!review) throw new MailReadError("mail_review_not_pending", 409);
  const evidence = JSON.parse(review.evidence_json);
  const message = db.prepare("SELECT provider,provider_message_id FROM mail_messages WHERE id=?").get(evidence.messageId) as any;
  if (message?.provider !== "shared-mail-api") throw new MailReadError("mail_review_provider_unsupported", 400);
  const row = await reader.byId(message.provider_message_id);
  if (!row) throw new MailReadError("mail_upstream_missing", 404);
  const mail = await normalizeSharedMail(row);
  if (!mail?.receivedAt || mail.providerMessageId !== message.provider_message_id) throw new MailReadError("mail_review_invalid_upstream");
  return db.transaction(() => {
    if (!(db.prepare("SELECT 1 FROM pending_reviews WHERE id=? AND status='pending'").get(reviewId))) throw new MailReadError("mail_review_not_pending", 409);
    const result = upsertMail("shared-mail-api", mail, routingRules());
    const status = (db.prepare("SELECT status FROM pending_reviews WHERE id=?").get(reviewId) as any).status;
    return { ...result, reviewId, status };
  }).immediate();
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

export interface MailIngestionResult {
  inserted: boolean; claims: number; deactivated: boolean; processingStatus: string; messageId: string;
}

const INGESTION_RETRY_COOLDOWN_MS = 60_000;
const INGESTION_LEASE_MS = 90_000;

function claimIngestion(messageId: string): string {
  return db.transaction(() => {
    const state = db.prepare("SELECT attempts,status FROM mail_ingestion_state WHERE provider='shared-mail-api' AND provider_message_id=?").get(messageId) as any;
    if (!state) throw new MailReadError("mail_event_not_found", 404);
    if (state.status === "processed") return "";
    const lease = db.prepare("SELECT * FROM mail_ingestion_leases WHERE provider='shared-mail-api' AND provider_message_id=?").get(messageId) as any;
    const now = Date.now();
    if (Number(lease?.lease_until) > now) throw new MailReadError("mail_event_busy", 429);
    if (Number(state.attempts) >= 3) throw new MailReadError("mail_event_retry_exhausted", 409);
    if (Number(lease?.retry_after) > now) throw new MailReadError("mail_event_cooling_down", 429);
    const owner = crypto.randomUUID();
    db.prepare(`INSERT INTO mail_ingestion_leases(provider,provider_message_id,owner,lease_until)
      VALUES('shared-mail-api',?,?,?) ON CONFLICT(provider,provider_message_id)
      DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until`).run(messageId, owner, now + INGESTION_LEASE_MS);
    db.prepare("UPDATE mail_ingestion_state SET attempts=attempts+1,updated_at=? WHERE provider='shared-mail-api' AND provider_message_id=?")
      .run(new Date(now).toISOString(), messageId);
    return owner;
  }).immediate();
}

function processingFailure(messageId: string, owner: string, error: unknown): void {
  const code = error instanceof MailReadError ? error.code : "mail_processing_failed";
  const notAttempted = ["mail_d1_not_configured", "mail_read_busy", "mail_read_cooling_down", "mail_read_budget_exhausted"].includes(code);
  db.transaction(() => {
    const lease = db.prepare(`UPDATE mail_ingestion_leases SET retry_after=?
      WHERE provider='shared-mail-api' AND provider_message_id=? AND owner=?`)
      .run(Date.now() + INGESTION_RETRY_COOLDOWN_MS, messageId, owner);
    if (!lease.changes) return;
    db.prepare(`UPDATE mail_ingestion_state SET error_code=?, updated_at=?,
      attempts=MAX(0,attempts-?) WHERE provider='shared-mail-api' AND provider_message_id=? AND status<>'processed'`)
      .run(code, new Date().toISOString(), Number(notAttempted), messageId);
  }).immediate();
}

function commitSharedMail(mail: NormalizedMail): MailIngestionResult {
  return db.transaction(() => {
    const previous = db.prepare("SELECT status FROM mail_ingestion_state WHERE provider='shared-mail-api' AND provider_message_id=?").get(mail.providerMessageId) as any;
    if (previous?.status === "processed" || (previous?.status === "pending_time" && !mail.receivedAt)) {
      return { inserted: false, claims: 0, deactivated: false, processingStatus: previous.status, messageId: mail.providerMessageId };
    }
    const result = upsertMail("shared-mail-api", mail, routingRules());
    const now = new Date().toISOString();
    const processingStatus = mail.receivedAt ? "processed" : "pending_time";
    if (mail.receivedAt) {
      const messageId = stableId("mail-message", "shared-mail-api", mail.providerMessageId);
      const claim = db.prepare(`INSERT OR IGNORE INTO pending_mail_claims(pending_id,message_id,created_at)
        SELECT id,?,? FROM pending_mailboxes WHERE email_hash=? AND created_at<=?`);
      const baseClaim = db.prepare(`INSERT OR IGNORE INTO pending_mail_claims(pending_id,message_id,created_at)
        SELECT id,?,? FROM pending_mailboxes WHERE id=? AND created_at<=?`);
      for (const recipient of mail.recipients) {
        claim.run(messageId, now, emailHash(recipient), mail.receivedAt);
        for (const pendingId of pendingMailboxIdsForBaseRecipient(recipient)) {
          baseClaim.run(messageId, now, pendingId, mail.receivedAt);
        }
      }
    }
    db.prepare(`INSERT INTO mail_ingestion_state(provider, provider_message_id, status, discovered_at, updated_at)
      VALUES('shared-mail-api', ?, ?, ?, ?) ON CONFLICT(provider,provider_message_id)
      DO UPDATE SET status=excluded.status, error_code='', updated_at=excluded.updated_at`)
      .run(mail.providerMessageId, processingStatus, now, now);
    return { ...result, processingStatus, messageId: mail.providerMessageId };
  })();
}

export async function ingestSharedMailEvent(payload: unknown, reader: Pick<D1MailReader, "byId"> = sharedMailReader): Promise<MailIngestionResult> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new MailReadError("invalid_mail_event", 400);
  const providerMessageId = String((payload as any).id || "");
  if (!/^[1-9][0-9]{0,15}$/.test(providerMessageId) || !Number.isSafeInteger(Number(providerMessageId))) throw new MailReadError("invalid_mail_id", 400);
  const existing = db.prepare("SELECT status FROM mail_ingestion_state WHERE provider='shared-mail-api' AND provider_message_id=?").get(providerMessageId) as any;
  if (existing?.status === "processed") {
    return { inserted: false, claims: 0, deactivated: false, processingStatus: "processed", messageId: providerMessageId };
  }
  let mail: NormalizedMail | null;
  try {
    mail = await normalizeSharedMail(payload);
  } catch (error) {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO mail_ingestion_state(provider, provider_message_id, status, error_code, discovered_at, updated_at)
      VALUES('shared-mail-api', ?, 'pending_parse', 'mail_processing_failed', ?, ?)
      ON CONFLICT(provider,provider_message_id) DO NOTHING`).run(providerMessageId, now, now);
    return { inserted: false, claims: 0, deactivated: false, processingStatus: "pending_parse", messageId: providerMessageId };
  }
  if (!mail) throw new MailReadError("invalid_mail_event", 400);
  const result = commitSharedMail(mail);
  if (result.processingStatus !== "pending_time") return result;
  // Metadata-only production webhooks perform the exact-ID read immediately.
  // The reader serializes in-process D1 access; lease/budget failures remain
  // pending for the bounded worker retry path instead of delaying every mail.
  try {
    const finished = await retrySharedMailEvent(mail.providerMessageId, reader);
    return { ...finished, inserted: result.inserted, deactivated: result.deactivated || finished.deactivated };
  } catch {
    return result;
  }
}

/** Re-read one known message by exact ID and rebuild program-derived ownership
 * claims. Raw MIME and body evidence stay in request memory only. */
export async function reconcileSharedMailOwnership(
  providerMessageId: string,
  reader: Pick<D1MailReader, "byId"> = sharedMailReader,
): Promise<{ inserted: boolean; claims: number; deactivated: boolean }> {
  if (!/^[1-9][0-9]{0,15}$/.test(providerMessageId) || !Number.isSafeInteger(Number(providerMessageId))) {
    throw new MailReadError("invalid_mail_id", 400);
  }
  const indexed = db.prepare(`SELECT 1 FROM mail_messages
    WHERE provider='shared-mail-api' AND provider_message_id=?`).get(providerMessageId);
  if (!indexed) throw new MailReadError("mail_event_not_found", 404);
  const row = await reader.byId(providerMessageId);
  if (!row) throw new MailReadError("mail_upstream_missing", 404);
  const normalized = await normalizeSharedMail(row);
  if (!normalized?.receivedAt || normalized.providerMessageId !== providerMessageId) {
    throw new MailReadError("mail_upstream_id_mismatch", 409);
  }
  return upsertMail("shared-mail-api", normalized, routingRules());
}

export async function retrySharedMailEvent(messageId: string, reader: Pick<D1MailReader, "byId"> = sharedMailReader): Promise<MailIngestionResult> {
  const owner = claimIngestion(messageId);
  if (!owner) return { inserted: false, claims: 0, deactivated: false, processingStatus: "processed", messageId };
  try {
    const row = await reader.byId(messageId);
    if (!row) throw new MailReadError("mail_upstream_missing", 404);
    const normalized = await normalizeSharedMail(row);
    if (!normalized?.receivedAt) throw new MailReadError("mail_received_time_missing");
    return db.transaction(() => {
      const lease = db.prepare("SELECT owner FROM mail_ingestion_leases WHERE provider='shared-mail-api' AND provider_message_id=?").get(messageId) as any;
      if (lease?.owner !== owner) throw new MailReadError("mail_event_lease_expired", 409);
      return commitSharedMail(normalized);
    }).immediate();
  } catch (error) {
    processingFailure(messageId, owner, error);
    throw error instanceof MailReadError ? error : new MailReadError("mail_processing_failed");
  } finally {
    db.prepare(`UPDATE mail_ingestion_leases SET owner='',lease_until=0
      WHERE provider='shared-mail-api' AND provider_message_id=? AND owner=?`).run(messageId, owner);
  }
}

export async function retryPendingSharedMailEvents(): Promise<{ processed: number; errors: number }> {
  if (!config.cfAccountId || !config.cfD1DatabaseId || !config.cfD1ReadToken) return { processed: 0, errors: 0 };
  const before = new Date(Date.now() - config.pendingMailRetryDelayMs).toISOString();
  const rows = db.prepare(`SELECT s.provider_message_id FROM mail_ingestion_state s
    LEFT JOIN mail_ingestion_leases l ON l.provider=s.provider AND l.provider_message_id=s.provider_message_id
    WHERE s.provider='shared-mail-api' AND s.status IN ('pending_time','pending_parse') AND s.attempts<3 AND s.updated_at<=?
      AND COALESCE(l.lease_until,0)<=? AND COALESCE(l.retry_after,0)<=?
    ORDER BY s.updated_at ASC LIMIT ?`).all(before, Date.now(), Date.now(), config.pendingMailBatchSize) as any[];
  let processed = 0;
  let errors = 0;
  for (const row of rows) {
    try { await retrySharedMailEvent(String(row.provider_message_id)); processed += 1; }
    catch (error) {
      errors += 1;
      if (error instanceof MailReadError && /budget|busy|quota|unauthorized|cost/.test(error.code)) break;
    }
  }
  return { processed, errors };
}

export async function manualSharedMailBackfill(window: BackfillWindow, reader: Pick<D1MailReader, "backfill"> = sharedMailReader) {
  validateBackfillWindow(window);
  const page = await reader.backfill(window);
  let inserted = 0;
  let claims = 0;
  let deactivated = 0;
  for (const row of page.rows) {
    const normalized = await normalizeSharedMail(row);
    if (!normalized?.receivedAt) throw new MailReadError("mail_received_time_missing");
    const result = commitSharedMail(normalized);
    inserted += Number(result.inserted);
    claims += result.claims;
    deactivated += Number(result.deactivated);
  }
  updateSyncState("shared-mail-api", JSON.stringify(page.cursor), "", page.cursor?.createdAt || "");
  return { fetched: page.rows.length, inserted, claims, deactivated, complete: page.complete, cursor: page.cursor };
}

export async function syncSharedMail(window?: BackfillWindow) {
  if (!window) throw new MailReadError("mail_explicit_backfill_window_required", 400);
  return manualSharedMailBackfill(window);
}

function outlookMail(item: any): NormalizedMail | null {
  const id = String(item?.id || item?.detailId || "");
  if (!id) return null;
  const sender = normalizeEmail(item?.from?.emailAddress?.address || item?.from?.address || item?.from || "").slice(0, 320);
  const subject = String(item?.subject || "(无主题)").replace(/\s+/g, " ").trim().slice(0, 2048);
  const bodyText = String(item?.bodyPreview || item?.body?.content || "");
  const bodyHtml = String(item?.body?.contentType || "").toLowerCase() === "html" ? String(item?.body?.content || "") : "";
  return {
    providerMessageId: id,
    sender,
    recipients: uniqueEmails(addressValues(item?.to)).filter((value) => value.length <= 320).slice(0, 100),
    subject,
    receivedAt: iso(item?.date || item?.created_at),
    folder: ["inbox", "junkemail", "deleteditems"].includes(String(item?.folder).toLowerCase()) ? String(item.folder).toLowerCase() : "inbox",
    bodyText,
    bodyHtml,
    metadata: { source: "outlook-manager-v2", method: "graph" },
    billingEvidence: deriveBillingMailEvidence(subject, bodyText, bodyHtml, sender),
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
