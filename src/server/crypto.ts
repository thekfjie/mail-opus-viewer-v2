import crypto from "node:crypto";
import { config } from "./config.js";

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.pbkdf2Sync(String(password), salt, 120_000, 32, "sha256").toString("base64url");
  return `pbkdf2:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  if (stored.startsWith("pbkdf2:")) {
    const [, salt, expected] = stored.split(":");
    if (!salt || !expected) return false;
    const actual = crypto.pbkdf2Sync(String(password), salt, 120_000, 32, "sha256").toString("base64url");
    return constantTimeEqual(actual, expected);
  }
  return constantTimeEqual(password, stored);
}

export function digestToken(token: string): string {
  return crypto.createHmac("sha256", config.sessionSecret).update(token).digest("base64url");
}

export function encryptSecret(value: string): string {
  if (!value) return "";
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config.encryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${nonce.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(value: string): string {
  if (!value) return "";
  const [version, nonceText, tagText, ciphertextText] = value.split(".");
  if (version !== "v1" || !nonceText || !tagText || !ciphertextText) return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", config.encryptionKey, Buffer.from(nonceText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}

export function signSession(type: "admin" | "customer", id: string, ttlMs = 12 * 60 * 60 * 1000): string {
  const expiresAt = Date.now() + ttlMs;
  const payload = Buffer.from(JSON.stringify({ type, id, expiresAt })).toString("base64url");
  const signature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySession(token: string): { type: "admin" | "customer"; id: string } | null {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed.id || !["admin", "customer"].includes(parsed.type) || Number(parsed.expiresAt) < Date.now()) return null;
    return { type: parsed.type, id: String(parsed.id) };
  } catch {
    return null;
  }
}
