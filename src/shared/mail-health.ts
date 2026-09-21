/** Aggregate administrator diagnostics. Never add message payloads or configuration values. */
export interface MailHealth {
  checkedAt: string;
  independent: true;
  readOnly: boolean;
  webhook: { configured: boolean; lastEventAt: string | null; lastProcessedAt: string | null };
  ingestion: { total: number; processed: number; pending: number; failed: number; retrying: number };
  notices: { total: number; unassigned: number; pendingReviews: number };
  d1: {
    configured: boolean;
    minuteRequests: number;
    dayRequests: number;
    dayRowsRead: number;
    activeRequest: boolean;
    blocked: boolean;
    blockedReason: "authentication" | "quota" | "query" | "cost" | "other" | null;
    manualBackfillReady: boolean;
    backfillAvailableAt: string | null;
    limits: {
      perMinute: number; perDay: number; attempts: number; timeoutMs: number;
      backfillPage: number; backfillWindowMs: number; backfillCooldownMs: number;
      failureCooldownMs: number; maxRowsRead: number; maxRowsReadPerDay: number;
    };
  };
  storage: { mode: "lightweight-index"; bodyRead: "upstream-by-id" };
  background: { mailLeases: "sqlite"; workerMutex: "in-process"; redisConnected: false; learningDocument: "docs/redis-learning.md" };
}
