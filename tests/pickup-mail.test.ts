import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("公开取件覆盖未注册邮箱、多语言、历史索引和收件人隔离", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-pickup-mail-"));
  Object.assign(process.env, {
    PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "test.sqlite"), ENV_FILE: "/dev/null",
    V2_SESSION_SECRET: "fake-pickup-session", CREDENTIAL_ENCRYPTION_KEY: "fake-pickup-encryption",
    VIEWER_ADMIN_PASSWORD: "fake-pickup-admin", V2_CF_D1_READ_TOKEN: "", V2_READ_ONLY: "false",
    V2_AUTO_TRIAL_ENABLED: "false", PUBLIC_ORIGIN: "https://mail.example.test",
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected external request"); });
  const [{ db }, { buildApp }, { ingestSharedMailEvent }, upstream, pickup, classification, { runMigrations }, { MailReadError }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/server.js"), import("../src/server/mail-sync.js"),
    import("../src/server/upstream-mail.js"), import("../src/server/pickup-mail.js"),
    import("../src/server/mail-classification.js"), import("../src/server/migrations.js"), import("../src/server/cf-mail.js"),
  ]);
  const app = await buildApp();
  t.after(async () => { await app.close(); (await db.close()); fs.rmSync(directory, { recursive: true }); });
  const mailRows = new Map<string, any>();
  const reads: string[] = [];
  let readFailure = false;
  const reader = { byId: async (id: string) => {
    reads.push(id);
    if (readFailure) throw new MailReadError("mail_d1_unavailable");
    await new Promise((resolve) => setTimeout(resolve, 5));
    return mailRows.get(id) || null;
  } };
  t.mock.method(upstream.sharedMailReader, "byId", reader.byId);
  const now = Date.now() - 60_000;
  const since = new Date(now - 1_800_000).toISOString();
  const subject = "Mã xác minh tạm thời của bạn cho ChatGPT";
  const canary = "MAIL-BODY-CANARY-NOT-FOR-STORAGE";
  let nextId = 1000;

  /** 构造内存邮件；摄取只能保存元数据，取正文必须经过指定 ID。 */
  async function addMail(source: string, to: string, code: string, at = now, title = subject): Promise<string> {
    const id = String(++nextId);
    const raw = [
      "From: OpenAI <noreply_at_tm_openai_com_test_tag@icloud.com>", `To: ${to}`, `Delivered-To: ${source}`,
      `Subject: ${title}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", `${canary} ${code}`,
    ].join("\r\n");
    const row = { id, raw, address: source, created_at: new Date(at).toISOString() };
    mailRows.set(id, row);
    await ingestSharedMailEvent(row, reader);
    return id;
  }

  await t.test("常见本地化验证码标题共用分类与取码规则", () => {
    for (const title of [
      subject, "Your ChatGPT code is 123456", "Your temporary ChatGPT login code", "ChatGPT 验证码",
      "ChatGPT の一時的な認証コード", "ChatGPT 인증 코드", "Tu código temporal de ChatGPT",
      "Seu código de verificação do ChatGPT", "Votre code temporaire pour ChatGPT", "Dein ChatGPT-Bestätigungscode",
      "Il tuo codice di verifica per ChatGPT", "Twój kod weryfikacyjny ChatGPT", "ChatGPT doğrulama kodu",
      "Ваш временный код ChatGPT", "رمز التحقق من ChatGPT", "Kode verifikasi ChatGPT", "ChatGPT verificatiecode",
      "ChatGPT 用の一時ログインコード", "आपका टेम्पररी ChatGPT लॉग इन कोड", "Je tijdelijke aanmeldcode voor ChatGPT is",
      "임시 ChatGPT 로그인 코드", "Kod log masuk sementara anda bagi ChatGPT", "Seu código do OpenAI é 123456", "Kode masuk ChatGPT sementara Anda",
    ]) {
      assert.equal(classification.isVerificationMail(title, "relay@icloud.com"), true, title);
      assert.equal(classification.classifyMail(title, "relay@icloud.com").category, "security", title);
    }
    assert.equal(classification.isVerificationMail("ChatGPT - Your new plan", "OpenAI"), false);
    assert.equal(classification.isVerificationMail("Invoice 123456", "OpenAI"), false);
    assert.equal(classification.isVerificationMail("Mã xác minh tạm thời của bạn", "unrelated@example.test"), false);
  });

  const email = "unregistered+oai123@icloud.com";
  const sourceEmail = "unregistered@icloud.com";
  const options = { sourceEmail, since, allowBaseRecipient: true };
  const oldId = await addMail(sourceEmail, sourceEmail, "111111", now - 7_200_000);
  const firstId = await addMail(sourceEmail, sourceEmail, "123456");
  await addMail(sourceEmail, sourceEmail, "999999", now + 1_000, "ChatGPT - Your new plan");

  await t.test("未创建账号或 pending 时也能读取越南语验证码，并合并并发请求", async () => {
    assert.equal(((await db.prepare("SELECT count(*) n FROM gpt_accounts").get()) as any).n, 0);
    assert.equal(((await db.prepare("SELECT count(*) n FROM pending_mailboxes").get()) as any).n, 0);
    const before = reads.length;
    const result = await Promise.all(Array.from({ length: 8 }, () => pickup.pickupMailboxVerificationCode(email, options, reader)));
    assert.ok(result.every((item: any) => item.item.verificationCode === "123456"));
    assert.deepEqual(reads.slice(before), [firstId]);
    await pickup.pickupMailboxVerificationCode(email, options, reader);
    assert.equal(reads.length, before + 1);
    assert.equal(reads.includes(oldId), false);
  });

  await t.test("新邮件到达立即使验证码缓存失效，取最新一封", async () => {
    const newId = await addMail(sourceEmail, sourceEmail, "654321", now + 2_000);
    const before = reads.length;
    const result = await pickup.pickupMailboxVerificationCode(email, options, reader) as any;
    assert.equal(result.item.verificationCode, "654321");
    assert.deepEqual(reads.slice(before), [newId]);
  });

  await t.test("已有索引离线补全收件人查询和多语言分类，迁移可重复执行", async () => {
    (await db.prepare("DELETE FROM mail_recipient_index").run());
    (await db.prepare("UPDATE mail_messages SET category='general',is_security=0 WHERE provider_message_id=?").run(firstId));
    (await db.prepare("DELETE FROM schema_meta WHERE version>=16").run());
    assert.deepEqual((await runMigrations(db)).map((entry) => entry.version), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 29]);
    assert.equal(((await db.prepare("SELECT category FROM mail_messages WHERE provider_message_id=?").get(firstId)) as any).category, "security");
    assert.ok(((await db.prepare("SELECT count(*) n FROM mail_recipient_index").get()) as any).n > 0);
    assert.deepEqual((await runMigrations(db)), []);
  });

  await t.test("V16 升级到 V17 修复已有日语登录码，不改已确认邮件归属", async () => {
    const id = await addMail("japanese@icloud.com", "japanese@icloud.com", "445566", now, "ChatGPT 用の一時ログインコード");
    (await db.prepare("UPDATE mail_messages SET category='general',is_security=0 WHERE provider_message_id=?").run(id));
    (await db.prepare("DELETE FROM schema_meta WHERE version>=17").run());
    const claims = JSON.stringify((await db.prepare("SELECT * FROM mail_ownership_claims ORDER BY message_id,binding_id").all()));
    assert.deepEqual((await runMigrations(db)).map((entry) => entry.version), [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 29]);
    assert.equal(((await db.prepare("SELECT category FROM mail_messages WHERE provider_message_id=?").get(id)) as any).category, "security");
    assert.equal(JSON.stringify((await db.prepare("SELECT * FROM mail_ownership_claims ORDER BY message_id,binding_id").all())), claims);
    const result = await pickup.pickupMailboxVerificationCode("japanese+oai123@icloud.com", {
      sourceEmail: "japanese@icloud.com", since, allowBaseRecipient: true,
    }, reader) as any;
    assert.equal(result.item.verificationCode, "445566");
  });

  await t.test("公开适配器的本地 OTP 入口需要管理员认证，并禁用响应缓存", async () => {
    const query = new URLSearchParams({ email, sourceEmail, since, allowBaseRecipient: "1" });
    const url = `/api/admin/pickup-verification-code?${query}`;
    const before = reads.length;
    assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal(reads.length, before);
    const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: "fake-pickup-admin" } });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const response = await app.inject({ url, headers: { cookie } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().item.verificationCode, "654321");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.body.includes(canary), false);
  });

  await t.test("不同显式子邮箱的验证码不能通过公共源邮箱串取", async () => {
    const source = "siblings@icloud.com";
    await addMail(source, "siblings+oaiother@icloud.com", "335566");
    const result = await pickup.pickupMailboxVerificationCode("siblings+oaiwanted@icloud.com", {
      sourceEmail: source, since, allowBaseRecipient: true,
    }, reader) as any;
    assert.equal(result.item, null);
  });

  await t.test("多子邮箱的折叠收件人明确报告歧义，显式收件人仍可取码", async () => {
    const source = "ambiguous@icloud.com";
    const alias = "ambiguous+oaiwanted@icloud.com";
    await addMail(source, source, "335566");
    const strict = { sourceEmail: source, since, allowBaseRecipient: false };
    await assert.rejects(pickup.pickupMailboxVerificationCode(alias, strict, reader), { code: "mail_recipient_ambiguous" });
    await addMail(source, alias, "112233", now + 3_000);
    const result = await pickup.pickupMailboxVerificationCode(alias, strict, reader) as any;
    assert.equal(result.item.verificationCode, "112233");
  });

  await t.test("Opus 中的同源注册任务也阻止不明确的源邮箱回退", async () => {
    const { upsertCompatibilityAccount, SIGNUP_NOTE } = await import("../src/server/compatibility-state.js");
    const source = "pending-peer@icloud.com";
    (await upsertCompatibilityAccount({ email: "pending-peer+oaisecond@icloud.com", note: SIGNUP_NOTE }));
    await addMail(source, source, "335566");
    await assert.rejects(pickup.pickupMailboxVerificationCode("pending-peer+oaifirst@icloud.com", {
      sourceEmail: source, since, allowBaseRecipient: true,
    }, reader), { code: "mail_recipient_ambiguous" });
  });

  await t.test("没有邮件与上游读取失败明确区分，失败不会缓存为无邮件", async () => {
    const empty = await pickup.pickupMailboxVerificationCode("empty+oai123@icloud.com", {
      sourceEmail: "empty@icloud.com", since, allowBaseRecipient: true,
    }, reader) as any;
    assert.equal(empty.item, null);
    const source = "failure@icloud.com";
    await addMail(source, source, "778899");
    const scope = { sourceEmail: source, since, allowBaseRecipient: true };
    readFailure = true;
    await assert.rejects(pickup.pickupMailboxVerificationCode("failure+oai123@icloud.com", scope, reader), { code: "mail_d1_unavailable" });
    readFailure = false;
    assert.equal((await pickup.pickupMailboxVerificationCode("failure+oai123@icloud.com", scope, reader) as any).item.verificationCode, "778899");
  });

  await t.test("邮件读取遵守每次最多八封正文的已有预算", async () => {
    const source = "bounded@icloud.com";
    for (let index = 0; index < 12; index += 1) await addMail(source, source, "no numeric code", now + index);
    const before = reads.length;
    const result = await pickup.pickupMailboxVerificationCode("bounded+oai123@icloud.com", {
      sourceEmail: source, since, allowBaseRecipient: true,
    }, reader) as any;
    assert.equal(result.item, null);
    assert.equal(reads.length - before, 8);
  });

  await t.test("错误来源和缺失时间不触发上游读取，正文从未持久化", async () => {
    const before = reads.length;
    await assert.rejects(pickup.pickupMailboxVerificationCode(email, { ...options, sourceEmail: "other@icloud.com" }, reader), { code: "invalid_pickup_scope" });
    await assert.rejects(pickup.pickupMailboxVerificationCode(email, { ...options, since: "" }, reader), { code: "invalid_pickup_scope" });
    assert.equal(reads.length, before);
    assert.equal(db.serialize().includes(Buffer.from(canary)), false);
  });
});
