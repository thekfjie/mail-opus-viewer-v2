import { asyncMap } from './async-collections.js';
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { emailHash, normalizeEmail, parseJwtSubject } from "./association.js";
import { resolveAccountMatch } from "./account-transitions.js";
import { config } from "./config.js";
import { observeCredentialVersion } from "./credential-versions.js";
import { decryptSecret, digestToken, encryptSecret, hashPassword } from "./crypto.js";
import { db } from "./db.js";
import { importAccounts, type ImportAccountInput } from "./repository.js";
import { listOutlookManagerAccounts, outlookManagerFetch } from "./upstream-mail.js";
import { probeOAuth, type OAuthProbe } from "./oauth-health.js";
import { isAccountActivitySubject } from "./business-evidence.js";
import { isPlanOrderSubject, isStrictPlusEvidenceSubject } from "./plus-evidence.js";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function validEmail(value: unknown): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizeEmail(value));
}

function jwtPayload(token: string): Record<string, any> {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1] || "", "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function jwtEmail(token: string): string {
  const payload = jwtPayload(token);
  const profile = payload["https://api.openai.com/profile"] || {};
  const auth = payload["https://api.openai.com/auth"] || {};
  return normalizeEmail(payload.email || payload.email_address || payload.emailAddress || payload["https://api.openai.com/profile.email"]
    || payload["https://api.openai.com/auth.email"] || profile.email || auth.email || payload.user?.email || payload.profile?.email
    || payload.account?.email || payload.preferred_username || "");
}

function openAiJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return false;
  try { if (!JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))) return false; } catch { return false; }
  const payload = jwtPayload(token);
  if (!Object.keys(payload).length) return false;
  const issuer = String(payload.iss || "").toLowerCase();
  const audience = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).map(String).join(" ").toLowerCase();
  return issuer.includes("openai.com") || audience.includes("openai.com") || Object.keys(payload).some((key) => key.includes("openai.com"));
}

function findJson(value: string): Record<string, any> | null {
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < value.length; end += 1) {
      const char = value[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(value.slice(start, end + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

interface ParsedCredential {
  line: number;
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  sessionToken: string;
  openaiPassword: string;
  error: string;
}

function addCredentialToken(result: ParsedCredential, field: "accessToken" | "refreshToken", value: string): void {
  const token = value.trim().replace(/^Bearer\s+/i, "").replace(/^['"]|['"]$/g, "").trim();
  if (field === "accessToken" && !openAiJwt(token)) result.error ||= "AT 不是有效的 OpenAI JWT";
  if (field === "refreshToken" && (openAiJwt(token) || token.length < 8 || token.length > 128 * 1024 || /\s/.test(token))) result.error ||= "RT 不是有效的不透明凭证";
  if (result[field] && result[field] !== token) result.error ||= `同一行包含不同的 ${field === "accessToken" ? "AT" : "RT"}`;
  else result[field] = token;
}

function collectCredentialObject(value: any, result: ParsedCredential, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialObject(item, result, depth + 1);
    return;
  }
  for (const [rawKey, item] of Object.entries(value)) {
    const key = rawKey.replace(/[\s-]/g, "_").toLowerCase();
    if (["email", "login", "username"].includes(key) && validEmail(item) && !result.email) result.email = normalizeEmail(item);
    else if (["accesstoken", "access_token", "at"].includes(key) && typeof item === "string") addCredentialToken(result, "accessToken", item);
    else if (["refreshtoken", "refresh_token", "rt"].includes(key) && typeof item === "string") addCredentialToken(result, "refreshToken", item);
    else if (["idtoken", "id_token"].includes(key) && typeof item === "string") result.idToken ||= item.trim();
    else if (["sessiontoken", "session_token"].includes(key) && typeof item === "string") result.sessionToken ||= item.trim();
    else if (["password", "openaipassword", "openai_password"].includes(key) && typeof item === "string") result.openaiPassword ||= item;
    if (item && typeof item === "object") collectCredentialObject(item, result, depth + 1);
  }
}

function parseCredentialLine(raw: string, line: number): ParsedCredential | null {
  const source = raw.trim();
  if (!source) return null;
  const result: ParsedCredential = { line, email: "", accessToken: "", refreshToken: "", idToken: "", sessionToken: "", openaiPassword: "", error: "" };
  const json = findJson(source);
  if (json) collectCredentialObject(json, result);
  const email = source.match(/[^\s<>|,;]+@[^\s<>|,;]+\.[^\s<>|,;]+/i)?.[0];
  if (!result.email && validEmail(email)) result.email = normalizeEmail(email);
  for (const match of source.matchAll(/(?:^|\s)(at|access[_ -]?token|rt|refresh[_ -]?token)\s*[:=]\s*(\S+)/ig)) {
    if (/^(?:at|access)/i.test(match[1])) addCredentialToken(result, "accessToken", match[2]);
    else addCredentialToken(result, "refreshToken", match[2]);
  }
  if (!result.accessToken && !result.refreshToken && !result.sessionToken && !json) {
    const chunks = source.split(/\s*----+\s*|\s+/).filter(Boolean).filter((item) => !validEmail(item));
    for (const chunk of chunks) {
      if (openAiJwt(chunk)) addCredentialToken(result, "accessToken", chunk);
      else addCredentialToken(result, "refreshToken", chunk);
    }
  }
  if (result.accessToken && !openAiJwt(result.accessToken)) result.error = "AT 不是有效的 OpenAI JWT";
  if (!result.accessToken && !result.refreshToken && !result.sessionToken) result.error ||= "这一行没有找到 AT、RT 或 Session Token";
  return result;
}

function parseCredentials(text: string): ParsedCredential[] {
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("凭据文本过大");
  try {
    const json = JSON.parse(text);
    if (json && typeof json === "object") {
      const item: ParsedCredential = { line: 1, email: "", accessToken: "", refreshToken: "", idToken: "", sessionToken: "", openaiPassword: "", error: "" };
      collectCredentialObject(json, item);
      if (!item.accessToken && !item.refreshToken && !item.sessionToken) item.error = "JSON 中没有可识别的凭证";
      return [item];
    }
  } catch { /* Non-JSON input is parsed as one credential bundle per line. */ }
  const results = text.split(/\r?\n/).map(parseCredentialLine).filter((item): item is ParsedCredential => Boolean(item));
  if (!results.length) throw new Error("没有找到可处理的凭据行");
  if (results.length > 500) throw new Error("单次最多处理 500 行凭据");
  return results;
}

const THIRD_PARTY_DROP_ROOT = path.resolve(process.env.V2_THIRD_PARTY_DROP_ROOT || "/var/lib/drop/files");

type ThirdPartyMaterialKind = "password" | "session" | "registration-export" | "decryption-key";

interface ThirdPartyMaterialAccount extends ImportAccountInput {
  email: string;
  hasIdentityCredential: boolean;
  emailOtp: boolean;
  missingTotp: boolean;
  sources: Set<ThirdPartyMaterialKind>;
}

interface ThirdPartyEnvelope {
  algorithm: string;
  aad: string;
  nonce_b64: string;
  ciphertext_b64: string;
}

function add32(left: number, right: number): number {
  return (left + right) >>> 0;
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function quarterRound(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  state[a] = add32(state[a], state[b]); state[d] = rotateLeft(state[d] ^ state[a], 16);
  state[c] = add32(state[c], state[d]); state[b] = rotateLeft(state[b] ^ state[c], 12);
  state[a] = add32(state[a], state[b]); state[d] = rotateLeft(state[d] ^ state[a], 8);
  state[c] = add32(state[c], state[d]); state[b] = rotateLeft(state[b] ^ state[c], 7);
}

function hChaCha20(key: Buffer, nonce: Buffer): Buffer {
  if (key.length !== 32 || nonce.length !== 16) throw new Error("XChaCha20 密钥或 nonce 长度无效");
  const state = new Uint32Array(16);
  state.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let index = 0; index < 8; index += 1) state[4 + index] = key.readUInt32LE(index * 4);
  for (let index = 0; index < 4; index += 1) state[12 + index] = nonce.readUInt32LE(index * 4);
  for (let round = 0; round < 10; round += 1) {
    quarterRound(state, 0, 4, 8, 12); quarterRound(state, 1, 5, 9, 13);
    quarterRound(state, 2, 6, 10, 14); quarterRound(state, 3, 7, 11, 15);
    quarterRound(state, 0, 5, 10, 15); quarterRound(state, 1, 6, 11, 12);
    quarterRound(state, 2, 7, 8, 13); quarterRound(state, 3, 4, 9, 14);
  }
  const output = Buffer.alloc(32);
  [state[0], state[1], state[2], state[3], state[12], state[13], state[14], state[15]]
    .forEach((value, index) => output.writeUInt32LE(value, index * 4));
  return output;
}

function strictBase64(value: unknown): Buffer {
  const text = String(value || "").trim();
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error("Base64 内容无效");
  return Buffer.from(text, "base64");
}

function decryptRegistrationEnvelope(envelope: ThirdPartyEnvelope, key: Buffer): string {
  if (envelope.algorithm !== "XChaCha20-Poly1305-IETF") throw new Error(`不支持的注册导出算法：${envelope.algorithm || "未知"}`);
  if (key.length !== 32) throw new Error("注册导出解密密钥必须是 32 字节");
  const nonce = strictBase64(envelope.nonce_b64);
  const ciphertext = strictBase64(envelope.ciphertext_b64);
  if (nonce.length !== 24 || ciphertext.length <= 16) throw new Error("注册导出的 nonce 或密文长度无效");
  const subkey = hChaCha20(key, nonce.subarray(0, 16));
  const chachaNonce = Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]);
  const encrypted = ciphertext.subarray(0, -16);
  const tag = ciphertext.subarray(-16);
  try {
    const decipher = crypto.createDecipheriv("chacha20-poly1305", subkey, chachaNonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(String(envelope.aad || ""), "utf8"), { plaintextLength: encrypted.length });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("注册导出解密失败：密钥不匹配或文件已损坏");
  }
}

function thirdPartyPaths(value: unknown): string[] {
  const inputs = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  const paths = [...new Set(inputs.map((item) => String(item || "").trim()).filter(Boolean))];
  if (!paths.length) throw new Error("请至少提供一个第三方注册材料路径");
  if (paths.length > 12) throw new Error("单次最多导入 12 个材料文件");
  return paths;
}

function readThirdPartyFile(requested: string): { path: string; name: string; text: string } {
  if (!path.isAbsolute(requested)) throw new Error("第三方注册材料必须是绝对路径");
  const root = THIRD_PARTY_DROP_ROOT;
  const resolved = path.resolve(requested);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`第三方注册材料必须位于 ${root}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw new Error("第三方注册材料无效或过大");
  return { path: resolved, name: path.basename(resolved), text: fs.readFileSync(resolved, "utf8") };
}

function materialAccountFromSession(session: Record<string, any>, line: number): ThirdPartyMaterialAccount {
  const credential: ParsedCredential = { line, email: "", accessToken: "", refreshToken: "", idToken: "", sessionToken: "", openaiPassword: "", error: "" };
  collectCredentialObject(session, credential);
  credential.email ||= normalizeEmail(session.user?.email || "");
  const email = normalizeEmail(credential.email || jwtEmail(credential.accessToken));
  if (credential.error || !validEmail(email)) throw new Error(credential.error || "没有有效邮箱");
  if (!credential.accessToken && !credential.sessionToken) throw new Error("没有 AT 或 Session Token");
  const tokenEmail = credential.accessToken ? jwtEmail(credential.accessToken) : "";
  if (tokenEmail && tokenEmail !== email) throw new Error("user.email 与 AT 邮箱不一致");
  const authMethods: string[] = Array.isArray(session.user?.amr) ? session.user.amr.map(String).filter(Boolean) : [];
  const mfaEnabled = session.user?.mfa === true;
  const emailOtp = authMethods.some((method) => /(?:^otp$|otp_email)/i.test(method));
  const issuedAt = Number(session.user?.iat || 0);
  return {
    email, lifecycleStatus: "third_party_registered", plan: String(session.account?.planType || "free").trim().toLowerCase(),
    note: mfaEnabled ? "第三方注册（文件导入，MFA）" : emailOtp ? "第三方注册（文件导入，邮箱 OTP）" : "第三方注册（文件导入）",
    mfaEnabled, authMethods, accessToken: credential.accessToken, refreshToken: credential.refreshToken,
    idToken: credential.idToken, sessionToken: credential.sessionToken,
    arrivedAt: issuedAt > 0 ? new Date(issuedAt * 1000).toISOString() : undefined,
    hasIdentityCredential: true, emailOtp, missingTotp: false, sources: new Set(["session"]),
  };
}

function mergeMaterialAccount(target: ThirdPartyMaterialAccount | undefined, incoming: ThirdPartyMaterialAccount): ThirdPartyMaterialAccount {
  if (!target) return incoming;
  const merged: ThirdPartyMaterialAccount = { ...target, sources: new Set([...target.sources, ...incoming.sources]) };
  for (const field of ["accessToken", "refreshToken", "idToken", "sessionToken", "openaiPassword", "totpSecret", "arrivedAt"] as const) {
    if (incoming[field]) merged[field] = incoming[field] as never;
  }
  if (incoming.hasIdentityCredential) {
    merged.hasIdentityCredential = true;
    merged.lifecycleStatus = "third_party_registered";
    merged.plan = incoming.plan || merged.plan;
    merged.note = incoming.note || merged.note;
    merged.mfaEnabled = incoming.mfaEnabled;
    merged.authMethods = incoming.authMethods;
    merged.emailOtp = incoming.emailOtp;
  }
  if (incoming.totpSecret) {
    merged.mfaEnabled = true;
    merged.authMethods = ["totp"];
    merged.missingTotp = false;
  } else if (incoming.missingTotp) merged.missingTotp = true;
  return merged;
}

function passwordMaterial(parts: string[]): ThirdPartyMaterialAccount {
  const email = normalizeEmail(parts[0]);
  const openaiPassword = String(parts[1] || "");
  const totpSecret = String(parts[2] || "").replace(/\s+/g, "").toUpperCase();
  if (!validEmail(email) || !openaiPassword || openaiPassword.length > 1_024 || (totpSecret && !/^[A-Z2-7]{16,128}=*$/.test(totpSecret))) {
    throw new Error("邮箱、密码或 TOTP/2FA 密钥格式无效");
  }
  return {
    email, openaiPassword, ...(totpSecret ? { totpSecret, mfaEnabled: true, authMethods: ["totp"] } : {}),
    hasIdentityCredential: false, emailOtp: false, missingTotp: !totpSecret, sources: new Set(["password"]),
  };
}

function registrationResultMaterial(value: Record<string, any>, line: number): ThirdPartyMaterialAccount {
  const result = value.result && typeof value.result === "object" ? value.result : value;
  const session = result.session && typeof result.session === "object" ? result.session : null;
  const base = session ? materialAccountFromSession(session, line) : passwordMaterial([String(result.email || ""), String(result.password || ""), String(result.totpSecret || "")]);
  if (validEmail(result.email)) {
    const resultEmail = normalizeEmail(result.email);
    if (base.hasIdentityCredential && base.accessToken && jwtEmail(base.accessToken) && jwtEmail(base.accessToken) !== resultEmail) {
      throw new Error("注册结果邮箱与 Session 身份不一致");
    }
    base.email = resultEmail;
  }
  if (typeof result.password === "string" && result.password) base.openaiPassword = result.password;
  base.sources.add("registration-export");
  return base;
}

async function importMaterialAccounts(accounts: ThirdPartyMaterialAccount[]): Promise<{ imported: number; created: number; errors: Array<{ index: number; error: string }> }> {
  let imported = 0;
  let created = 0;
  const errors: Array<{ index: number; error: string }> = [];
  for (let offset = 0; offset < accounts.length; offset += 200) {
    const result = (await importAccounts(accounts.slice(offset, offset + 200)));
    imported += result.imported;
    created += result.created;
    errors.push(...result.errors.map((item) => ({ index: item.index + offset, error: item.error })));
  }
  return { imported, created, errors };
}

/** Import third-party OpenAI session exports without any network request.
 * The existing encrypted credential-version store owns AT/session persistence. */
export async function importThirdPartySessionFile(inputPath: unknown): Promise<Record<string, unknown>> {
  const files = thirdPartyPaths(inputPath).map(readThirdPartyFile);
  const envelopes: Array<{ file: string; value: ThirdPartyEnvelope }> = [];
  const keys: Array<{ file: string; value: Buffer }> = [];
  const plaintexts: Array<{ file: string; text: string; encrypted: boolean }> = [];
  const invalid: Array<Record<string, unknown>> = [];
  for (const file of files) {
    let parsed: any = null;
    try { parsed = JSON.parse(file.text); } catch { /* JSONL and password lists are handled below. */ }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && parsed.algorithm && parsed.aad && parsed.nonce_b64 && parsed.ciphertext_b64) {
      envelopes.push({ file: file.name, value: parsed as ThirdPartyEnvelope });
      continue;
    }
    try {
      const possibleKey = strictBase64(file.text);
      if (possibleKey.length === 32) { keys.push({ file: file.name, value: possibleKey }); continue; }
    } catch { /* Normal text material. */ }
    plaintexts.push({ file: file.name, text: file.text, encrypted: false });
  }
  for (const envelope of envelopes) {
    let plaintext = "";
    for (const key of keys) {
      try { plaintext = decryptRegistrationEnvelope(envelope.value, key.value); break; } catch { /* Try another supplied key. */ }
    }
    if (!plaintext) {
      invalid.push({ file: envelope.file, line: 0, email: "", reason: keys.length ? "没有匹配的解密密钥或文件已损坏" : "缺少 32 字节 Base64 解密密钥文件" });
    } else plaintexts.push({ file: envelope.file, text: plaintext, encrypted: true });
  }
  const merged = new Map<string, ThirdPartyMaterialAccount>();
  for (const material of plaintexts) {
    const rawLines = material.text.split(/\r?\n/).filter((line) => line.trim());
    if (rawLines.length > 500) throw new Error(`${material.file} 超过单文件 500 条账号限制`);
    for (let index = 0; index < rawLines.length; index += 1) {
      const rawLine = rawLines[index];
      try {
        const secretParts = rawLine.split(/\s*----+\s*/);
        let account: ThirdPartyMaterialAccount;
        if ((secretParts.length === 2 || secretParts.length === 3) && validEmail(secretParts[0])) {
          account = passwordMaterial(secretParts);
        } else {
          const value = JSON.parse(rawLine);
          if (value.WARNING_BANNER && !value.user && !value.accessToken && !value.sessionToken) continue;
          account = value.result && typeof value.result === "object"
            ? registrationResultMaterial(value, index + 1)
            : materialAccountFromSession(value, index + 1);
          if (material.encrypted) account.sources.add("registration-export");
        }
        merged.set(account.email, mergeMaterialAccount(merged.get(account.email), account));
      } catch (error) {
        invalid.push({ file: material.file, line: index + 1, email: "", reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const accounts = [...merged.values()];
  for (const account of accounts) {
    if (account.hasIdentityCredential) account.lifecycleStatus = "third_party_registered";
    else {
      const existing = (await db.prepare(`SELECT a.lifecycle_status FROM email_bindings b JOIN gpt_accounts a ON a.id=b.account_id
        WHERE b.email_hash=? AND b.is_current=1 AND a.deleted_at='' LIMIT 1`).get(emailHash(account.email))) as any;
      const status = String(existing?.lifecycle_status || "");
      account.lifecycleStatus = status === "third_party_registered" ? "third_party_registered"
        : status === "active" ? undefined : "third_party_pending_recovery";
    }
  }
  const result = (await importMaterialAccounts(accounts));
  const mfaEnabledCount = accounts.filter((account) => account.mfaEnabled).length;
  const emailOtpCount = accounts.filter((account) => account.emailOtp).length;
  const missingTotpCount = accounts.filter((account) => account.missingTotp && !account.totpSecret).length;
  const materialCounts = {
    password: accounts.filter((account) => account.sources.has("password") || Boolean(account.openaiPassword)).length,
    session: accounts.filter((account) => account.sources.has("session")).length,
    registrationExport: accounts.filter((account) => account.sources.has("registration-export")).length,
  };
  return {
    ok: invalid.length === 0 && result.errors.length === 0,
    file: files.length === 1 ? files[0].name : files.map((file) => file.name).join(", "),
    ...(files.length > 1 ? { files: files.map((file) => file.name), materials: materialCounts } : {}),
    total: accounts.length + invalid.length, accepted: accounts.length,
    imported: result.imported, created: result.created,
    authentication: { mfaEnabled: mfaEnabledCount, emailOtp: emailOtpCount, missingTotp: missingTotpCount },
    errors: [...invalid, ...result.errors],
  };
}

async function resolveCredential(item: ParsedCredential): Promise<{ status: string; reason: string; accountId: string; email: string; subjectHash: string }> {
  if (item.error) return { status: "invalid", reason: item.error, accountId: "", email: item.email, subjectHash: "" };
  const tokenEmail = item.accessToken ? jwtEmail(item.accessToken) : "";
  const subject = item.accessToken ? parseJwtSubject(item.accessToken) : "";
  const subjectHash = subject ? sha256(subject) : "";
  if (item.email && tokenEmail && item.email !== tokenEmail) {
    const explicit = (await db.prepare("SELECT account_id FROM email_bindings WHERE email_hash=? ORDER BY is_current DESC LIMIT 1").get(emailHash(item.email))) as any;
    const byIdentity = subjectHash ? (await resolveAccountMatch(subjectHash, "")) : null;
    if (!explicit || !byIdentity?.accountId || String(explicit.account_id) !== byIdentity.accountId) {
      return { status: "conflict", reason: "行内邮箱与 AT 身份指向不同账号", accountId: "", email: item.email, subjectHash };
    }
  }
  const email = item.email || tokenEmail;
  const match = (await resolveAccountMatch(subjectHash, email));
  if (match.kind === "conflict") return { status: "conflict", reason: match.reason, accountId: match.accountId, email, subjectHash };
  if (match.kind !== "account" || !match.accountId) {
    const candidates = ((await db.prepare(`SELECT cv.account_id,cv.access_token_enc,cv.refresh_token_enc
      FROM credential_versions cv JOIN gpt_accounts a ON a.id=cv.account_id WHERE a.deleted_at=''`).all()) as any[])
      .filter((row) => item.accessToken ? decryptSecret(row.access_token_enc) === item.accessToken
        : item.refreshToken && decryptSecret(row.refresh_token_enc) === item.refreshToken);
    const owners = [...new Set<string>(candidates.map((row) => row.account_id))];
    if (owners.length > 1) return { status: "conflict", reason: "凭据对应多个不同身份", accountId: "", email, subjectHash };
    if (owners.length === 1 && !email) return { status: "ready", reason: "", accountId: owners[0], email, subjectHash };
    return { status: "unresolved", reason: "凭证未匹配现有 GPT 身份", accountId: "", email, subjectHash };
  }
  return { status: "ready", reason: "", accountId: match.accountId, email, subjectHash };
}

async function resolvedCredentialBatch(text: string) {
  const items = (await asyncMap(parseCredentials(text), async (credential) => ({ credential, resolution: (await resolveCredential(credential)) })));
  const groups = new Map<string, typeof items>();
  for (const item of items) if (item.resolution.status === "ready") {
    const group = groups.get(item.resolution.accountId) || [];
    group.push(item);
    groups.set(item.resolution.accountId, group);
  }
  for (const group of groups.values()) {
    for (const field of ["accessToken", "refreshToken"] as const) {
      if (new Set(group.map((item) => item.credential[field]).filter(Boolean)).size > 1) {
        for (const item of group) item.resolution = { ...item.resolution, status: "conflict", reason: `同一账号收到不同的 ${field === "accessToken" ? "AT" : "RT"}` };
      }
    }
  }
  return items;
}

export async function previewOauthBatch(textInput: unknown): Promise<Record<string, unknown>> {
  const text = String(textInput || "").trim();
  const items = (await resolvedCredentialBatch(text)).map(({ credential, resolution }) => {
    return {
      line: credential.line, email: resolution.email, status: resolution.status, reason: resolution.reason,
      targetId: resolution.accountId, hasAccessToken: Boolean(credential.accessToken), hasRefreshToken: Boolean(credential.refreshToken),
    };
  });
  return {
    ok: true, batchHash: sha256(text), total: items.length,
    ready: items.filter((item) => item.status === "ready").length,
    conflicts: items.filter((item) => item.status === "conflict").length,
    unresolved: items.filter((item) => item.status === "unresolved").length,
    invalid: items.filter((item) => item.status === "invalid").length,
    items,
  };
}

export async function applyOauthBatch(textInput: unknown, previewHash: unknown, confirmed: unknown): Promise<Record<string, unknown>> {
  const text = String(textInput || "").trim();
  if (!confirmed || String(previewHash || "") !== sha256(text)) throw new Error("预览已变化，请重新预览后确认");
  const credentials = (await resolvedCredentialBatch(text));
  let applied = 0;
  const observedByAccount = new Map<string, Awaited<ReturnType<typeof observeCredentialVersion>>>();
  const results = (await db.transaction(async () => (await asyncMap(credentials, async ({ credential, resolution }) => {
    if (resolution.status !== "ready") return { line: credential.line, status: resolution.status, reason: resolution.reason };
    const prior = observedByAccount.get(resolution.accountId);
    if (prior) return { line: credential.line, status: prior.conflict ? "conflict" : "applied", targetId: resolution.accountId, changed: prior.changed };
    const combined = credentials.filter((item) => item.resolution.status === "ready" && item.resolution.accountId === resolution.accountId)
      .reduce((bundle, item) => ({ ...bundle,
        accessToken: item.credential.accessToken || bundle.accessToken, refreshToken: item.credential.refreshToken || bundle.refreshToken,
        idToken: item.credential.idToken || bundle.idToken, sessionToken: item.credential.sessionToken || bundle.sessionToken,
        openaiPassword: item.credential.openaiPassword || bundle.openaiPassword }), credential);
    const existing = (await db.prepare(`SELECT cv.* FROM account_current_credentials cc JOIN credential_versions cv ON cv.id=cc.credential_version_id
      WHERE cc.account_id=?`).get(resolution.accountId)) as any;
    const binding = (await db.prepare("SELECT id FROM email_bindings WHERE account_id=? AND is_current=1").get(resolution.accountId)) as any;
    const observed = (await observeCredentialVersion({
      accountId: resolution.accountId, bindingId: String(binding?.id || "") || null,
      accessToken: combined.accessToken, refreshToken: combined.refreshToken,
      idToken: combined.idToken || decryptSecret(String(existing?.id_token_enc || "")),
      sessionToken: combined.sessionToken || decryptSecret(String(existing?.session_token_enc || "")),
      openaiPassword: combined.openaiPassword || decryptSecret(String(existing?.openai_password_enc || "")),
      subjectHash: resolution.subjectHash || (parseJwtSubject(combined.accessToken) ? sha256(parseJwtSubject(combined.accessToken)) : ""),
      source: "v2-oauth-batch", validityStatus: combined.accessToken ? "alive" : "unknown",
      evidence: { batchHash: sha256(text), line: credential.line },
    }));
    observedByAccount.set(resolution.accountId, observed);
    if (!observed.conflict) applied += 1;
    return { line: credential.line, status: observed.conflict ? "conflict" : "applied", targetId: resolution.accountId, changed: observed.changed };
  })))());
  return { ok: true, applied, total: results.length, results };
}

let oauthHealthRun: Promise<void> | null = null;

export async function runOauthHealth(jobId: string, probe: OAuthProbe = probeOAuth): Promise<void> {
  const startedAt = new Date().toISOString();
  (await db.prepare("UPDATE oauth_health_jobs SET status='running', started_at=?, updated_at=? WHERE id=?").run(startedAt, startedAt, jobId));
  try {
    const rows = (await db.prepare(`SELECT a.id account_id, cc.credential_version_id, cv.*
      FROM gpt_accounts a JOIN account_current_credentials cc ON cc.account_id=a.id
      JOIN credential_versions cv ON cv.id=cc.credential_version_id
      WHERE a.deleted_at='' AND a.lifecycle_status='active' AND a.deactivation_locked=0
        AND a.plan NOT IN ('plus','pro','team','business','enterprise','edu')
        AND cv.validity_status NOT IN ('invalid','conflict')
        AND (cv.access_token_enc!='' OR cv.refresh_token_enc!='') ORDER BY a.arrived_at,a.id`).all()) as any[];
    (await db.prepare("UPDATE oauth_health_jobs SET total_count=? WHERE id=?").run(rows.length, jobId));
    let completed = 0;
    let errors = 0;
    for (const row of rows) {
      let result;
      try {
        result = await probe({ accessToken: decryptSecret(row.access_token_enc), refreshToken: decryptSecret(row.refresh_token_enc), idToken: decryptSecret(row.id_token_enc) });
      } catch {
        result = { status: "error", accessStatus: "unknown", refreshStatus: "unknown", detail: "oauth_probe_failed" } as const;
      }
      const now = new Date().toISOString();
      (await db.transaction(async () => {
        const selected = (await db.prepare(`SELECT cc.credential_version_id, a.lifecycle_status, a.deactivation_locked,
            cv.updated_at credential_updated_at FROM account_current_credentials cc JOIN gpt_accounts a ON a.id=cc.account_id
            JOIN credential_versions cv ON cv.id=cc.credential_version_id WHERE cc.account_id=? AND a.deleted_at=''`).get(row.account_id)) as any;
        const unchanged = selected?.credential_version_id === row.credential_version_id && selected?.credential_updated_at === row.updated_at
          && selected?.lifecycle_status === "active" && !selected?.deactivation_locked;
        let detail = unchanged ? result.detail : "credential_changed_during_probe";
        if (unchanged && result.status === "alive" && result.rotatedTokens) {
          const subject = parseJwtSubject(result.rotatedTokens.accessToken || result.rotatedTokens.idToken);
          const observed = (await observeCredentialVersion({ accountId: row.account_id,
            ...result.rotatedTokens, sessionToken: decryptSecret(row.session_token_enc), openaiPassword: decryptSecret(row.openai_password_enc),
            subjectHash: subject ? sha256(subject) : String(row.subject_hash || ""), source: "v2-oauth-health", validityStatus: "alive",
            evidence: { jobId, previousCredentialVersionId: row.credential_version_id } }));
          if (observed.conflict) { detail = "refreshed_identity_conflict"; errors += 1; }
        } else if (unchanged && result.status !== "error") {
          (await db.prepare("UPDATE credential_versions SET validity_status=?,validity_checked_at=?,updated_at=? WHERE id=?")
            .run(result.status === "alive" ? "alive" : "invalid", now, now, row.credential_version_id));
          (await db.prepare(`UPDATE credentials SET access_token_alive=?,
            refresh_token_alive=CASE WHEN ?='alive' THEN 1 WHEN ? IN ('invalid','missing') THEN 0 ELSE refresh_token_alive END,
            updated_at=? WHERE account_id=?`).run(result.status === "alive" ? 1 : 0, result.refreshStatus, result.refreshStatus, now, row.account_id));
        }
        (await db.prepare(`INSERT INTO oauth_health_results(id, job_id, account_id, credential_version_id, access_status, refresh_status, detail, checked_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
          crypto.randomUUID(), jobId, row.account_id, row.credential_version_id, result.accessStatus,
          result.refreshStatus, detail, now,
        ));
        completed += 1;
        if (result.status !== "alive" || !unchanged) errors += 1;
        (await db.prepare("UPDATE oauth_health_jobs SET completed_count=?,error_count=?,updated_at=? WHERE id=?").run(completed, errors, now, jobId));
      })());
    }
    const now = new Date().toISOString();
    (await db.prepare("UPDATE oauth_health_jobs SET status='completed',finished_at=?,updated_at=? WHERE id=?").run(now, now, jobId));
  } catch (error) {
    const now = new Date().toISOString();
    (await db.prepare("UPDATE oauth_health_jobs SET status='failed', error_count=1, finished_at=?, updated_at=? WHERE id=?").run(now, now, jobId));
    (await db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('oauth_health_last_error',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run("oauth_health_job_failed", now));
  }
}

export async function startOauthHealth(): Promise<Record<string, unknown>> {
  const active = (await db.prepare("SELECT * FROM oauth_health_jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get()) as any;
  if (active) return (await oauthHealthStatus(String(active.id)));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  (await db.prepare("INSERT INTO oauth_health_jobs(id,status,created_at,updated_at) VALUES(?,'queued',?,?)").run(id, now, now));
  oauthHealthRun = runOauthHealth(id).finally(() => { oauthHealthRun = null; });
  return (await oauthHealthStatus(id));
}

export async function oauthHealthStatus(id = ""): Promise<Record<string, unknown>> {
  const row = id ? (await db.prepare("SELECT * FROM oauth_health_jobs WHERE id=?").get(id)) as any
    : (await db.prepare("SELECT * FROM oauth_health_jobs ORDER BY created_at DESC LIMIT 1").get()) as any;
  if (!row) return { status: "idle", total: 0, completed: 0, errors: 0 };
  return {
    id: row.id, status: row.status, total: Number(row.total_count || 0), completed: Number(row.completed_count || 0),
    errors: Number(row.error_count || 0), createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

interface OutlookImportItem {
  email: string;
  openaiPassword: string;
  mailboxPassword: string;
  clientId: string;
  mailboxRefreshToken: string;
  accessToken: string;
  raw: string;
}

function parseOutlookLines(input: unknown): OutlookImportItem[] {
  const rows = String(input || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!rows.length) throw new Error("请粘贴至少一行账号");
  const output: OutlookImportItem[] = [];
  const invalid: number[] = [];
  const seen = new Set<string>();
  rows.forEach((line, index) => {
    const parts = line.split("----").map((part) => part.trim());
    const email = normalizeEmail(parts[0]);
    if (!validEmail(email) || ![4, 6].includes(parts.length) || parts.slice(1).some((part) => !part)) { invalid.push(index + 1); return; }
    if (seen.has(email)) return;
    seen.add(email);
    const item = parts.length === 4
      ? { email, openaiPassword: "", mailboxPassword: parts[1], clientId: parts[2], mailboxRefreshToken: parts[3], accessToken: "" }
      : { email, openaiPassword: parts[1], mailboxPassword: parts[2], clientId: parts[3], mailboxRefreshToken: parts[4], accessToken: parts[5] };
    output.push({ ...item, raw: [email, item.mailboxPassword, item.clientId, item.mailboxRefreshToken].join("----") });
  });
  if (invalid.length) throw new Error(`第 ${invalid.slice(0, 20).join("、")} 行格式不正确，只支持 Outlook 4 段或 6 段格式`);
  return output.slice(0, 500);
}

async function accountForEmail(email: string): Promise<{ accountId: string; bindingId: string } | null> {
  const row = (await db.prepare(`SELECT b.account_id, b.id binding_id FROM email_bindings b
    JOIN gpt_accounts a ON a.id=b.account_id WHERE b.email_hash=? AND b.is_current=1 AND a.deleted_at=''`).get(emailHash(email))) as any;
  return row ? { accountId: String(row.account_id), bindingId: String(row.binding_id) } : null;
}

async function saveOutlookConnection(item: OutlookImportItem, groupId: unknown = ""): Promise<void> {
  const owner = (await accountForEmail(item.email));
  if (!owner) throw new Error("Outlook 邮箱导入后没有当前绑定");
  const now = new Date().toISOString();
  const id = sha256(`outlook-manager:${owner.bindingId}`).slice(0, 32);
  const secret = encryptSecret(JSON.stringify({ password: item.mailboxPassword, clientId: item.clientId, refreshToken: item.mailboxRefreshToken }));
  (await db.prepare(`INSERT INTO mailbox_connections(id,binding_id,provider,external_account_id,external_group_id,secret_ref,status,last_checked_at,
      metadata_json,created_at,updated_at,manager_email_enc,credentials_enc)
    VALUES(?,?,'outlook-manager',?,?,?,'active','',?, ?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET external_account_id=excluded.external_account_id,external_group_id=excluded.external_group_id,
      status='active',metadata_json=excluded.metadata_json,manager_email_enc=excluded.manager_email_enc,
      credentials_enc=excluded.credentials_enc,updated_at=excluded.updated_at`).run(
    id, owner.bindingId, emailHash(item.email), String(groupId || ""), `v2:${owner.bindingId}:mailbox`,
    JSON.stringify({ mailSource: "outlook-manager", importedBy: "v2" }), now, now, encryptSecret(item.email), secret,
  ));
}

export async function importOutlook(input: unknown): Promise<Record<string, unknown>> {
  const parsed = parseOutlookLines(input);
  const managerResult = await outlookManagerFetch("/api/accounts", { method: "POST", csrf: true, body: {
    account_string: parsed.map((item) => item.raw).join("\n"), account_format: "client_id_refresh_token", provider: "outlook",
    forward_enabled: false, remark: "Cloud Opus V2 Imported", status: "active", tag_ids: [],
  } });
  let imported = 0;
  let created = 0;
  let errors = 0;
  for (let index = 0; index < parsed.length; index += 200) {
    const chunk = parsed.slice(index, index + 200);
    const result = (await importAccounts(chunk.map((item) => ({
      email: item.email, accessToken: item.accessToken, openaiPassword: item.openaiPassword, plan: "free", note: "",
    }))));
    imported += result.imported;
    created += result.created;
    errors += result.errors.length;
  }
  for (const item of parsed) if ((await accountForEmail(item.email))) (await saveOutlookConnection(item, managerResult?.group_id || ""));
  return { ok: true, added: created, updated: imported - created, skipped: parsed.length - imported, errors, managerAdded: Number(managerResult?.added_count || 0), managerSkipped: Number(managerResult?.skipped_count || 0) };
}

function transferEmails(input: unknown): string[] {
  const text = String(input || "");
  const json = findJson(text);
  const candidates = [normalizeEmail(json?.user?.email || ""), ...(text.match(/[^\s<>|,;]+@[^\s<>|,;]+\.[^\s<>|,;]+/gi) || []).map(normalizeEmail)];
  return [...new Set(candidates.filter(validEmail))].slice(0, 500);
}

export async function previewOutlookTransfer(input: unknown): Promise<Record<string, unknown>> {
  const emails = transferEmails(input);
  if (!emails.length) throw new Error("请粘贴至少一个邮箱");
  const manager = new Map((await listOutlookManagerAccounts()).map((item) => [normalizeEmail(item.email), item]));
  const results = (await asyncMap(emails, async (email) => {
    const listed = manager.get(email);
    const local = (await accountForEmail(email));
    return { email, exists: Boolean(listed), transferable: Boolean(listed), alreadyInViewer: Boolean(local), status: !listed ? "missing" : local ? "existing" : "ready", reason: !listed ? "Outlook 管理库未找到" : local ? "V2 已有账号" : "可转移" };
  }));
  return { ok: true, total: results.length, transferable: results.filter((item) => item.transferable).length, results };
}

export async function applyOutlookTransfer(input: unknown): Promise<Record<string, unknown>> {
  const emails = transferEmails(input);
  if (!emails.length) throw new Error("请粘贴至少一个邮箱");
  const manager = new Map((await listOutlookManagerAccounts()).map((item) => [normalizeEmail(item.email), item]));
  let added = 0;
  let updated = 0;
  const failed: Array<Record<string, unknown>> = [];
  for (const email of emails) {
    const listed = manager.get(email);
    if (!listed) { failed.push({ email, error: "Outlook 管理库未找到" }); continue; }
    try {
      const detailPayload = await outlookManagerFetch(`/api/accounts/${listed.id}`);
      const detail = detailPayload?.account || detailPayload;
      const result = (await importAccounts([{ email, plan: "free" }]));
      added += result.created;
      updated += result.imported - result.created;
      (await saveOutlookConnection({
        email, openaiPassword: "", accessToken: "", mailboxPassword: String(detail.password || ""),
        clientId: String(detail.client_id || ""), mailboxRefreshToken: String(detail.refresh_token || ""), raw: "",
      }, detail.group_id || listed.group_id || ""));
    } catch (error) {
      failed.push({ email, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: true, added, updated, failed: failed.length, failedItems: failed };
}

export async function importSession(input: unknown): Promise<Record<string, unknown>> {
  const text = String(input || "");
  const session = findJson(text);
  if (!session) throw new Error("会话 JSON 无法解析，请完整复制后重试");
  const credential: ParsedCredential = { line: 1, email: "", accessToken: "", refreshToken: "", idToken: "", sessionToken: "", openaiPassword: "", error: "" };
  collectCredentialObject(session, credential);
  credential.email ||= normalizeEmail(session.user?.email || "");
  if (!validEmail(credential.email)) throw new Error("会话 JSON 中没有有效的账号邮箱");
  if (!credential.accessToken && !credential.sessionToken) throw new Error("会话 JSON 中没有可识别的 Token");
  const result = (await importAccounts([credential]));
  return { ok: result.errors.length === 0, added: result.created, updated: result.imported - result.created, skipped: result.imported ? 0 : 1, errors: result.errors };
}

export async function runUsageAudit(): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const candidates = (await db.prepare(`SELECT a.id,a.mark_color,
    (SELECT b.id FROM email_bindings b WHERE b.account_id=a.id ORDER BY b.is_current DESC,b.valid_from DESC LIMIT 1) binding_id,
    e.billing_started_at,e.last_activity_at,e.newest_mail_at,e.audit_binding_id
    FROM gpt_accounts a LEFT JOIN account_business_evidence e ON e.account_id=a.id WHERE a.deleted_at=''`).all()) as any[];
  let suspected = 0;
  (await db.transaction(async () => {
    for (const row of candidates) {
      const sameBinding = row.audit_binding_id === row.binding_id;
      let billingAt = Date.parse(String(row.billing_started_at || "")) || 0;
      let activityAt = sameBinding ? Date.parse(String(row.last_activity_at || "")) || 0 : 0;
      let newestAt = sameBinding ? Date.parse(String(row.newest_mail_at || "")) || 0 : 0;
      const mails = (await db.prepare(`SELECT DISTINCT m.subject,m.received_at,oc.binding_id
        FROM mail_messages m JOIN mail_ownership_claims oc ON oc.message_id=m.id WHERE oc.account_id=?`).all(row.id)) as any[];
      for (const mail of mails) {
        const at = Date.parse(String(mail.received_at || ""));
        if (!Number.isFinite(at)) continue;
        if (isPlanOrderSubject(mail.subject) || isStrictPlusEvidenceSubject(mail.subject)) billingAt = billingAt ? Math.min(billingAt, at) : at;
        if (mail.binding_id === row.binding_id) {
          newestAt = Math.max(newestAt, at);
          if (isAccountActivitySubject(mail.subject)) activityAt = Math.max(activityAt, at);
        }
      }
      const unused = row.mark_color !== "purple" && Boolean(billingAt) && !(activityAt > billingAt);
      const iso = (at: number) => at ? new Date(at).toISOString() : "";
      (await db.prepare(`INSERT INTO account_business_evidence(account_id,billing_started_at,last_activity_at,newest_mail_at,audit_binding_id,audited_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET billing_started_at=excluded.billing_started_at,
        last_activity_at=excluded.last_activity_at,newest_mail_at=excluded.newest_mail_at,audit_binding_id=excluded.audit_binding_id,
        audited_at=excluded.audited_at,updated_at=excluded.updated_at`).run(row.id, iso(billingAt), iso(activityAt), iso(newestAt), row.binding_id || "", now, now));
      (await db.prepare("UPDATE gpt_accounts SET suspected_unused=?, updated_at=? WHERE id=?").run(unused ? 1 : 0, now, row.id));
      if (unused) suspected += 1;
    }
    (await db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('usage_audit_last_result',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(JSON.stringify({ checked: candidates.length, suspected }), now));
  })());
  return { ok: true, checked: candidates.length, suspectedUnused: suspected, finishedAt: now };
}

interface ShareFilters { sold: string; channel: string; plusOnly: boolean }

function shareFilters(input: any): ShareFilters {
  return {
    sold: ["all", "sold", "unsold"].includes(String(input?.sold || "all")) ? String(input?.sold || "all") : "all",
    channel: String(input?.channel || "").slice(0, 80), plusOnly: Boolean(input?.plusOnly),
  };
}

function publicShare(row: any): Record<string, unknown> {
  const token = decryptSecret(String(row.token_enc || ""));
  const active = !row.revoked_at && Date.parse(String(row.expires_at || "")) > Date.now() && Number(row.views) < Number(row.max_views);
  return {
    id: row.id, label: row.label, createdAt: row.created_at, expiresAt: row.expires_at,
    maxViews: Number(row.max_views), views: Number(row.views), remainingViews: Math.max(0, Number(row.max_views) - Number(row.views)),
    revoked: Boolean(row.revoked_at), active, filters: JSON.parse(String(row.filters_json || "{}")),
    url: `${config.publicOrigin}/adminshare#t=${encodeURIComponent(token)}`,
  };
}

export async function listShareLinks(): Promise<Record<string, unknown>> {
  return { results: ((await db.prepare("SELECT * FROM share_links ORDER BY created_at DESC").all()) as any[]).map(publicShare) };
}

export async function createShareLink(input: any): Promise<Record<string, unknown>> {
  const ttlHours = Math.max(1, Math.min(168, Number(input?.ttlHours || 24)));
  const maxViews = Math.max(1, Math.min(50, Number(input?.maxViews || 5)));
  const token = crypto.randomBytes(24).toString("base64url");
  const id = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + ttlHours * 60 * 60 * 1_000).toISOString();
  (await db.prepare(`INSERT INTO share_links(id,token_hash,token_enc,label,expires_at,max_views,filters_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, digestToken(token), encryptSecret(token), String(input?.label || "").slice(0, 80), expires, maxViews, JSON.stringify(shareFilters(input)), now.toISOString(), now.toISOString()));
  return { ok: true, link: publicShare((await db.prepare("SELECT * FROM share_links WHERE id=?").get(id))) };
}

export async function revokeShareLink(id: string): Promise<boolean> {
  return (await db.prepare("UPDATE share_links SET revoked_at=?,updated_at=? WHERE id=? AND revoked_at=''").run(new Date().toISOString(), new Date().toISOString(), id)).changes > 0;
}

function maskEmail(email: string): string {
  const [local, domain] = normalizeEmail(email).split("@");
  if (!local || !domain) return "***";
  if (local.length < 3) return `${local[0] || "*"}*@${domain}`;
  const count = Math.min(4, local.length - 2);
  const start = Math.floor((local.length - count) / 2);
  return `${local.slice(0, start)}${"*".repeat(count)}${local.slice(start + count)}@${domain}`;
}

export async function readShareSnapshot(token: string, visitor: string): Promise<Record<string, unknown> | null> {
  const row = (await db.prepare("SELECT * FROM share_links WHERE token_hash=?").get(digestToken(token))) as any;
  if (!row || row.revoked_at || Date.parse(String(row.expires_at || "")) <= Date.now() || Number(row.views) >= Number(row.max_views)) return null;
  const now = new Date().toISOString();
  const visitorHash = sha256(`${visitor}:${token}`);
  const dedupe = (await db.prepare("SELECT expires_at FROM share_view_dedup WHERE link_id=? AND visitor_hash=?").get(row.id, visitorHash)) as any;
  const counted = !dedupe || Date.parse(String(dedupe.expires_at || "")) <= Date.now();
  (await db.transaction(async () => {
    if (counted) {
      (await db.prepare("UPDATE share_links SET views=views+1,last_view_at=?,updated_at=? WHERE id=?").run(now, now, row.id));
      (await db.prepare(`INSERT INTO share_view_dedup(link_id,visitor_hash,expires_at) VALUES(?,?,?)
        ON CONFLICT(link_id,visitor_hash) DO UPDATE SET expires_at=excluded.expires_at`).run(row.id, visitorHash, new Date(Date.now() + 10 * 60_000).toISOString()));
    } else (await db.prepare("UPDATE share_links SET last_view_at=?,updated_at=? WHERE id=?").run(now, now, row.id));
  })());
  const filters = shareFilters(JSON.parse(String(row.filters_json || "{}")));
  const rows = (await db.prepare(`SELECT a.plan,a.billing_channel,a.deactivation_locked,a.mark_color,b.email_enc,b.provider
    FROM gpt_accounts a JOIN email_bindings b ON b.account_id=a.id AND b.is_current=1
    WHERE a.deleted_at='' AND a.lifecycle_status!='retired'
      AND (?='all' OR (?='sold' AND a.sold=1) OR (?='unsold' AND a.sold=0))
      AND (?='' OR a.billing_channel=?) AND (?=0 OR a.plan='plus')
    ORDER BY a.arrived_at DESC,a.id DESC`).all(filters.sold, filters.sold, filters.sold, filters.channel, filters.channel, filters.plusOnly ? 1 : 0)) as any[];
  const current = (await db.prepare("SELECT * FROM share_links WHERE id=?").get(row.id)) as any;
  return {
    ok: true, label: row.label || "账号概览", generatedAt: now, expiresAt: row.expires_at,
    maxViews: Number(row.max_views), remainingViews: Math.max(0, Number(row.max_views) - Number(current.views)), count: rows.length,
    results: rows.map((item) => ({
      emailMasked: maskEmail(decryptSecret(String(item.email_enc || ""))), hasPlus: String(item.plan) === "plus",
      hasDeactivation: Boolean(item.deactivation_locked), billingChannel: String(item.billing_channel || ""),
      mailboxType: String(item.provider || ""), markColor: String(item.mark_color || ""),
    })),
  };
}

export async function changeCustomerPassword(grantId: string, password: unknown): Promise<void> {
  const value = String(password || "");
  if (value.length < 6 || value.length > 256) throw new Error("新密码长度应为 6 到 256 个字符");
  const now = new Date().toISOString();
  const result = (await db.prepare(`UPDATE access_grants SET password_hash=?,password_plain_enc=?,updated_at=?
    WHERE id=? AND active=1 AND scope!='admin_only'`).run(hashPassword(value), encryptSecret(value), now, grantId));
  if (!result.changes) throw new Error("当前授权已失效");
}
