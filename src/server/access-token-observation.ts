import crypto from "node:crypto";

export interface AccessTokenObservation {
  fingerprint: string;
  firstSeenAt: string;
}

/** Store only a one-way identifier for an AT so scheduling never persists the token itself. */
export function fingerprintAccessToken(accessToken: string): string {
  const value = String(accessToken || "");
  return value ? crypto.createHash("sha256").update(value).digest("base64url") : "";
}

function validIso(value: unknown): string {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

/** Keep the original discovery time when the same token is refreshed. */
export function observeAccessToken(
  accessToken: string,
  existing: Partial<AccessTokenObservation> | null | undefined,
  seenAt: string,
): AccessTokenObservation {
  const value = String(accessToken || "");
  const fingerprint = value ? fingerprintAccessToken(value) : String(existing?.fingerprint || "");
  if (!value) return { fingerprint, firstSeenAt: validIso(existing?.firstSeenAt) };
  const previousFingerprint = String(existing?.fingerprint || "");
  const previousFirstSeen = validIso(existing?.firstSeenAt);
  if (fingerprint && previousFingerprint === fingerprint && previousFirstSeen) {
    return { fingerprint, firstSeenAt: previousFirstSeen };
  }
  return { fingerprint, firstSeenAt: validIso(seenAt) || new Date().toISOString() };
}

