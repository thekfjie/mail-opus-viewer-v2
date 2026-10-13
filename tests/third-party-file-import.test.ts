import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function jwt(email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", email, sub: `subject:${email}` })).toString("base64url");
  return `${header}.${payload}.signature`;
}


test("第三方文件入口离线识别邮箱，并把 AT/Session 加密保存为第三方注册", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-opus-third-party-file-"));
  const dropRoot = path.join(directory, "drop");
  fs.mkdirSync(dropRoot);
  process.env.PROJECT_ROOT = directory;
  process.env.V1_ENV_FILE = path.join(directory, "missing-v1.env");
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "third-party-file-session";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "third-party-file-encryption";
  process.env.PUBLIC_ORIGIN = "https://mail.example.test";
  process.env.V2_READ_ONLY = "false";
  process.env.V2_ACCOUNT_AUTHORITY = "v2";
  process.env.V2_THIRD_PARTY_DROP_ROOT = dropRoot;

  const [{ db }, repository, operations, cryptoModule, association] = await Promise.all([
    import("../src/server/db.js"),
    import("../src/server/repository.js"),
    import("../src/server/native-operations.js"),
    import("../src/server/crypto.js"),
    import("../src/server/association.js"),
  ]);
  t.after(async () => (await db.close()));

  const email = "third-party-file+oai@icloud.com";
  (await repository.importAccounts([{ email, lifecycleStatus: "third_party_pending_recovery", note: "待导入" }]));
  const filePath = path.join(dropRoot, "accounts.ndjson");
  fs.writeFileSync(filePath, [
    JSON.stringify({ user: { email, iat: 1_700_000_000, mfa: false, amr: ["otp", "urn:openai:amr:otp_email"] }, account: { planType: "free" }, accessToken: jwt(email), sessionToken: "session-secret" }),
    JSON.stringify({ WARNING_BANNER: "ignored metadata" }),
  ].join("\n"));

  const result = (await operations.importThirdPartySessionFile(filePath)) as any;
  assert.deepEqual(result, {
    ok: true, file: "accounts.ndjson", total: 1, accepted: 1, imported: 1, created: 0,
    authentication: { mfaEnabled: 0, emailOtp: 1, missingTotp: 0 }, errors: [],
  });

  const account = (await db.prepare("SELECT id,lifecycle_status,plan,note,arrived_at,openai_mfa_enabled,openai_auth_methods_json FROM gpt_accounts").get()) as any;
  assert.equal(account.lifecycle_status, "third_party_registered");
  assert.equal(account.plan, "free");
  assert.equal(account.note, "第三方注册（文件导入，邮箱 OTP）");
  assert.equal(account.arrived_at, "2023-11-14T22:13:20.000Z");
  assert.equal(account.openai_mfa_enabled, 0);
  assert.deepEqual(JSON.parse(account.openai_auth_methods_json), ["otp", "urn:openai:amr:otp_email"]);

  const stored = (await db.prepare(`SELECT cv.access_token_enc,cv.session_token_enc FROM account_current_credentials cc
    JOIN credential_versions cv ON cv.id=cc.credential_version_id WHERE cc.account_id=?`).get(account.id)) as any;
  assert.notEqual(stored.access_token_enc, jwt(email));
  assert.notEqual(stored.session_token_enc, "session-secret");
  assert.equal(cryptoModule.decryptSecret(stored.access_token_enc), jwt(email));
  assert.equal(cryptoModule.decryptSecret(stored.session_token_enc), "session-secret");

  const customerExport = (await repository.provisionCurrentCustomerExport(account.id));
  assert.equal(customerExport?.available, true);
  assert.equal(customerExport?.currentEmail, email);
  assert.match(String(customerExport?.publicUrl), /^https:\/\/mail\.example\.test\/#m=/);

  const secretFilePath = path.join(dropRoot, "account-secrets.txt");
  fs.writeFileSync(secretFilePath, `${email}----openai-password----JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`);
  assert.deepEqual((await operations.importThirdPartySessionFile(secretFilePath)), {
    ok: true, file: "account-secrets.txt", total: 1, accepted: 1, imported: 1, created: 0,
    authentication: { mfaEnabled: 1, emailOtp: 0, missingTotp: 0 }, errors: [],
  });
  const secrets = (await db.prepare("SELECT password_enc,totp_secret_enc FROM account_passwords WHERE account_id=?").get(account.id)) as any;
  assert.notEqual(secrets.password_enc, "openai-password");
  assert.notEqual(secrets.totp_secret_enc, "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  assert.equal(cryptoModule.decryptSecret(secrets.password_enc), "openai-password");
  assert.equal(cryptoModule.decryptSecret(secrets.totp_secret_enc), "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  const updated = (await db.prepare("SELECT openai_mfa_enabled,openai_auth_methods_json FROM gpt_accounts WHERE id=?").get(account.id)) as any;
  assert.equal(updated.openai_mfa_enabled, 1);
  assert.deepEqual(JSON.parse(updated.openai_auth_methods_json), ["totp"]);

  const missingSecretFilePath = path.join(dropRoot, "account-secret-missing.txt");
  fs.writeFileSync(missingSecretFilePath, `${email}----replacement-password----`);
  assert.deepEqual((await operations.importThirdPartySessionFile(missingSecretFilePath)), {
    ok: true, file: "account-secret-missing.txt", total: 1, accepted: 1, imported: 1, created: 0,
    authentication: { mfaEnabled: 0, emailOtp: 0, missingTotp: 1 }, errors: [],
  });
  const preserved = (await db.prepare("SELECT password_enc,totp_secret_enc FROM account_passwords WHERE account_id=?").get(account.id)) as any;
  assert.equal(cryptoModule.decryptSecret(preserved.password_enc), "replacement-password");
  assert.equal(cryptoModule.decryptSecret(preserved.totp_secret_enc), "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  const mfaExport = (await repository.getCurrentCustomerExport(account.id));
  assert.match(String(mfaExport?.text), /账号：third-party-file\+oai@icloud\.com/);
  assert.match(String(mfaExport?.text), /密码：replacement-password/);
  assert.match(String(mfaExport?.text), /2FA：JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP/);
  assert.match(String(mfaExport?.text), /2FA地址：https:\/\/2fa\.vip/);
  assert.doesNotMatch(String(mfaExport?.text), /邮箱验证码：/);

  const standalonePassword = path.join(dropRoot, "standalone-password.txt");
  fs.writeFileSync(standalonePassword, "standalone-password@icloud.com----pw-only\n");
  const passwordResult = (await operations.importThirdPartySessionFile(standalonePassword)) as any;
  assert.equal(passwordResult.accepted, 1);
  assert.equal(passwordResult.errors.length, 0);
  assert.equal(((await db.prepare("SELECT lifecycle_status FROM gpt_accounts WHERE id=(SELECT account_id FROM email_bindings WHERE email_hash=? AND is_current=1)").get(association.emailHash("standalone-password@icloud.com"))) as any).lifecycle_status, "third_party_pending_recovery");

  const standaloneSession = path.join(dropRoot, "standalone-session.ndjson");
  const standaloneSessionEmail = "standalone-session@icloud.com";
  fs.writeFileSync(standaloneSession, JSON.stringify({ user: { email: standaloneSessionEmail, iat: 1_700_000_001 }, accessToken: jwt(standaloneSessionEmail), sessionToken: "session-only" }));
  const sessionResult = (await operations.importThirdPartySessionFile(standaloneSession)) as any;
  assert.equal(sessionResult.accepted, 1);
  assert.equal(sessionResult.errors.length, 0);

});
