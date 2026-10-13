import type { Database } from "./storage/types.js";

export const TRIAL_ONLY_CORRECTION_EVENT = "plus_trial_only_corrected";

/** A reviewed zero-charge trial suppresses legacy/token Plus projections until
 * a later full-body billing event proves that a paid subscription activated. */
export async function hasActiveTrialOnlyCorrection(database: Database, accountId: string): Promise<boolean> {
  const row = (await database.prepare(`SELECT
      COALESCE(MAX(CASE WHEN event_type=? THEN created_at END),'') correction_at,
      COALESCE(MAX(CASE WHEN event_type='plus_activated_by_mail' THEN created_at END),'') activation_at
    FROM lifecycle_events WHERE account_id=?`).get(TRIAL_ONLY_CORRECTION_EVENT, accountId)) as any;
  const correctionAt = Date.parse(String(row?.correction_at || ""));
  if (!Number.isFinite(correctionAt)) return false;
  const activationAt = Date.parse(String(row?.activation_at || ""));
  return !Number.isFinite(activationAt) || activationAt <= correctionAt;
}
