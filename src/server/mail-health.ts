import type { MailHealth } from "../shared/mail-health.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { MAIL_READ_LIMITS } from "./cf-mail.js";

function timestamp(value: unknown): string | null {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function blockedCategory(value: string): MailHealth["d1"]["blockedReason"] {
  if (!value) return null;
  if (["mail_d1_unauthorized", "mail_d1_forbidden", "mail_d1_http_401", "mail_d1_http_403"].includes(value)) return "authentication";
  if (["mail_d1_quota_exhausted", "mail_d1_rate_limited", "mail_d1_http_429"].includes(value)) return "quota";
  if (value === "mail_d1_query_rejected") return "query";
  if (["mail_d1_missing_cost", "mail_d1_query_cost_exceeded"].includes(value)) return "cost";
  return "other";
}

/** Reads only local aggregate state. Opening or refreshing diagnostics cannot read upstream mail. */
export async function mailHealth(now = Date.now()): Promise<MailHealth> {
  const ingestion = (await db.prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(status='processed'),0) processed,
    COALESCE(SUM(status IN ('pending_time','pending_parse') AND attempts<3),0) pending,
    COALESCE(SUM(status<>'processed' AND (attempts>=3 OR status NOT IN ('pending_time','pending_parse'))),0) failed,
    COALESCE(SUM(status IN ('pending_time','pending_parse') AND attempts BETWEEN 1 AND 2),0) retrying,
    MAX(discovered_at) last_event_at, MAX(CASE WHEN status='processed' THEN updated_at END) last_processed_at
    FROM mail_ingestion_state WHERE provider='shared-mail-api'`).get()) as Record<string, any>;
  const reads = (await db.prepare(`SELECT COUNT(*) day_requests,
    COALESCE(SUM(started_at>?),0) minute_requests, COALESCE(SUM(rows_read),0) day_rows_read
    FROM mail_read_requests WHERE started_at>?`).get(now - 60_000, now - 86_400_000)) as Record<string, number>;
  const control = (await db.prepare("SELECT lease_until,blocked_reason,backfill_at FROM mail_read_control WHERE id=1").get()) as Record<string, any>;
  const blockedReason = blockedCategory(String(control?.blocked_reason || ""));
  const backfillAvailable = Number(control?.backfill_at || 0) + MAIL_READ_LIMITS.backfillCooldownMs;
  const notices = (await db.prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(NOT EXISTS(SELECT 1 FROM mail_ownership_claims c WHERE c.message_id=m.id)),0) unassigned
    FROM mail_messages m WHERE m.category='deactivation'`).get()) as { total: number; unassigned: number };
  const pendingNotices = (await db.prepare(`SELECT COUNT(*) n FROM pending_reviews
    WHERE review_type='mail_ownership_ambiguous' AND status='pending'`).get()) as { n: number };
  return {
    notices: { ...notices, pendingReviews: pendingNotices.n },
    checkedAt: new Date(now).toISOString(), independent: true, readOnly: config.readOnly,
    webhook: { configured: Boolean(config.mailWebhookSecret), lastEventAt: timestamp(ingestion.last_event_at), lastProcessedAt: timestamp(ingestion.last_processed_at) },
    ingestion: { total: ingestion.total, processed: ingestion.processed, pending: ingestion.pending, failed: ingestion.failed, retrying: ingestion.retrying },
    d1: {
      configured: Boolean(config.cfAccountId && config.cfD1DatabaseId && config.cfD1ReadToken),
      minuteRequests: reads.minute_requests, dayRequests: reads.day_requests, dayRowsRead: reads.day_rows_read,
      activeRequest: Number(control?.lease_until || 0) > now,
      blocked: Boolean(blockedReason), blockedReason,
      manualBackfillReady: Boolean(config.cfD1TimeIndex),
      backfillAvailableAt: backfillAvailable > now ? new Date(backfillAvailable).toISOString() : null,
      limits: { ...MAIL_READ_LIMITS },
    },
    storage: { mode: "lightweight-index", bodyRead: "upstream-by-id" },
    background: { mailLeases: db.dialect, workerMutex: "in-process", rateLimiter: db.dialect === "mysql" ? "redis" : "memory-test" },
  };
}
