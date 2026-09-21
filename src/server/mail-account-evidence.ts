import crypto from "node:crypto";
import { db } from "./db.js";
import { decryptSecret } from "./crypto.js";
import { normalizeEmail } from "./association.js";
import { isDeactivationSubject } from "./mail-classification.js";

export interface NoticeEvidence {
  emails: string[];
  associatedEmails: string[];
  identityHashes: string[];
}

const address = "[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\\.[a-z]{2,}";
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");

/** V1's associated-account phrases, plus a corroborated identity for translated notices.
 * The input and extracted evidence are request memory only, never mail metadata. */
export function noticeEvidence(subject: string, sender: string, text: string): NoticeEvidence | undefined {
  const trusted = /@(?:[a-z0-9-]+\.)*openai\.com$/i.test(sender)
    || /^[a-z]+_at_tm[a-z0-9]*_openai_com_[a-z0-9]+_[a-z0-9]+@icloud\.com$/i.test(sender);
  if (!trusted || !isDeactivationSubject(subject) || !text) return undefined;
  const bounded = text.slice(0, 65_536);
  const phrases = [
    `\\b(?:ChatGPT|OpenAI)?\\s*account\\s+associated\\s+with\\s+(?:the\\s+email\\s+address\\s+)?<?(${address})>?`,
    `(?:與|与)\\s*<?(${address})>?\\s*(?:（|\\(|，|,|。|\\.|；|;|綁定|绑定|關聯|关联|用户|用戶|user)`,
    `(?:綁定|绑定|關聯|关联)(?:的|之)?(?:電子郵件|电子邮件|郵箱|邮箱)?[：:\\s]*<?(${address})>?`,
    `(?:就|已)?(?:與|与)\\s*<?(${address})>?`,
  ];
  return {
    emails: [...new Set((bounded.match(new RegExp(address, "gi")) || []).map(normalizeEmail))].slice(0, 32),
    associatedEmails: [...new Set(phrases.flatMap((pattern) => [...bounded.matchAll(new RegExp(pattern, "gi"))]
      .map((match) => normalizeEmail(match[1]))))].slice(0, 16),
    identityHashes: [...new Set((bounded.match(/\b(?:user-[A-Za-z0-9_-]{4,128}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi) || [])
      .map(digest))].slice(0, 32),
  };
}

export function resolveNoticeEvidence(evidence: NoticeEvidence | undefined, candidateIds: string[], receivedAt = "") {
  const unresolved = { accountId: "", bindingId: "", conflict: false };
  if (!evidence || !candidateIds.length || candidateIds.length > 32) return unresolved;
  const placeholders = candidateIds.map(() => "?").join(",");
  const bindings = (db.prepare(`SELECT id,account_id,email_enc,valid_from,valid_to,is_current FROM email_bindings
    WHERE account_id IN (${placeholders}) ORDER BY valid_from DESC,id`).all(...candidateIds) as any[])
    .map((binding) => ({ ...binding, email: normalizeEmail(decryptSecret(binding.email_enc)) }));
  const emailOwners = new Set(bindings.filter((b) => evidence.emails.includes(b.email)).map((b) => b.account_id as string));
  const phraseOwners = new Set(bindings.filter((b) => evidence.associatedEmails.includes(b.email)).map((b) => b.account_id as string));
  const identityOwners = new Set<string>();
  for (const accountId of candidateIds) {
    // Rejected credentials remain in the version log for recovery. They must
    // never become evidence that the disputed identity owns this account.
    // Expired/superseded credentials are still useful when their subject was
    // independently confirmed; expiration does not change historical identity.
    const versions = db.prepare(`SELECT v.subject_hash,v.access_token_enc,v.id_token_enc FROM credential_versions v
      WHERE v.account_id=? AND v.subject_hash!='' AND v.validity_status!='conflict'
        AND v.retired_reason NOT IN ('identity_conflict','subject_conflict')
        AND (EXISTS(SELECT 1 FROM credentials c WHERE c.account_id=v.account_id AND c.openai_subject_hash=v.subject_hash)
          OR EXISTS(SELECT 1 FROM openai_identity_observations o WHERE o.account_id=v.account_id
            AND o.subject_hash=v.subject_hash AND o.status='confirmed'))
      ORDER BY v.last_seen_at DESC LIMIT 32`).all(accountId) as any[];
    for (const version of versions) {
      if (evidence.identityHashes.includes(version.subject_hash)) identityOwners.add(accountId);
      for (const encrypted of [version.access_token_enc, version.id_token_enc]) {
        try {
          const token = decryptSecret(encrypted || "");
          if (token.length > 65_536) continue;
          const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
          const auth = payload["https://api.openai.com/auth"] || {};
          if ([payload.sub, auth.chatgpt_user_id, auth.chatgpt_account_user_id]
            .some((value) => typeof value === "string" && evidence.identityHashes.includes(digest(value)))) identityOwners.add(accountId);
        } catch { /* Missing or opaque tokens cannot establish identity. */ }
      }
    }
  }
  // An explicit user identifier is a constraint. A matching email phrase
  // cannot silently override a missing, rejected or contradictory identity.
  if (evidence.identityHashes.length && identityOwners.size === 0) return { ...unresolved, conflict: true };
  if (identityOwners.size > 1 || phraseOwners.size > 1) return { ...unresolved, conflict: true };
  const identityOwner = [...identityOwners][0];
  const phraseOwner = [...phraseOwners][0];
  if (identityOwner && (!emailOwners.has(identityOwner) || (phraseOwner && phraseOwner !== identityOwner))) {
    return { ...unresolved, conflict: true };
  }
  const accountId = identityOwner || phraseOwner || "";
  if (!accountId) return unresolved;
  const phrases = bindings.filter((b) => b.account_id === accountId && evidence.associatedEmails.includes(b.email));
  const exact = phrases.length ? phrases : bindings.filter((b) => b.account_id === accountId && evidence.emails.includes(b.email));
  if (!exact.length) return { ...unresolved, conflict: true };
  // Rebinding the same address within one account is one ownership chain, not
  // competing owners. Pick the stage active at receipt time. If old imported
  // windows overlap, use the newest matching stage deterministically.
  const received = Date.parse(receivedAt);
  const active = Number.isFinite(received) ? exact.filter((binding) => {
    const from = Date.parse(String(binding.valid_from || ""));
    const to = Date.parse(String(binding.valid_to || ""));
    return (!Number.isFinite(from) || received >= from) && (!Number.isFinite(to) || received < to);
  }) : [];
  const selectable = active.length ? active : exact.filter((binding) => Number(binding.is_current));
  const binding = (selectable.length ? selectable : exact)[0];
  return { accountId, bindingId: String(binding?.id || ""), conflict: false };
}
