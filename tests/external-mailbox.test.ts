import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("external mailbox adapters retain V1 ownership while reading only the requested ID", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opus-external-offline-"));
  Object.assign(process.env, { PROJECT_ROOT: directory, DATABASE_PATH: path.join(directory, "test.sqlite"),
    V2_SESSION_SECRET: "external-offline-session", CREDENTIAL_ENCRYPTION_KEY: "external-offline-encryption" });
  const external = await import("../src/server/external-mailbox.js");
  const { db } = await import("../src/server/db.js");
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  await t.test("parser keeps V1 providers and rejects hostname suffix confusion", () => {
    assert.equal(external.parseExternalMailbox("https://yangyang.website/messages/offline-token/a%40example.test")?.email, "a@example.test");
    assert.equal(external.parseExternalMailbox("https://notyangyang.website/messages/offline-token/a%40example.test"), null);
    assert.equal(external.parseExternalMailbox("flysms:a@icloud.com:offline-token")?.provider, "flysms");
    assert.equal(external.parseExternalMailbox("https://flysms.top/icloud/#email=a%40icloud.com&token=offline-token")?.token, "offline-token");
    assert.equal(external.parseExternalMailbox("https://applemail.kfjie.me/mail/a%40icloud.com/offline-token")?.provider, "applemail");
  });

  await t.test("YangYang uses one exact ID request, in-flight coalescing and no persistent body cache", async () => {
    const mailbox = external.parseExternalMailbox("https://yangyang.website/messages/offline-token/a%40example.test")!;
    const calls: string[] = [];
    const transport = (async (url: any, options: any) => {
      calls.push(String(url));
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify({ id: "42", toAddress: "a@example.test", subject: "offline mail",
        body: `data:text/html;base64,${Buffer.from("<p>BODY_UNIQUE_MARKER</p>").toString("base64")}`, receivedAt: "2026-08-01T00:00:00.000Z" }));
    }) as typeof fetch;
    const results = await Promise.all([external.fetchExternalMessageById(mailbox, "yangyang-42", transport), external.fetchExternalMessageById(mailbox, "42", transport)]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "https://yangyang.website/message/42/offline-token/a%40example.test");
    assert.equal(results[0]?.text, "BODY_UNIQUE_MARKER");
    await external.fetchExternalMessageById(mailbox, "42", transport);
    assert.equal(calls.length, 2);
    for (const entry of fs.readdirSync(directory)) assert.equal(fs.readFileSync(path.join(directory, entry)).includes(Buffer.from("BODY_UNIQUE_MARKER")), false);
  });

  await t.test("FlySMS manual and AppleMail missing ID API produce zero upstream calls", async () => {
    let count = 0;
    const transport = (async () => { count += 1; throw new Error("must not fetch"); }) as typeof fetch;
    for (const address of ["flysms:a@icloud.com:offline-token", "https://applemail.kfjie.me/mail/a%40icloud.com/offline-token"]) {
      await assert.rejects(external.fetchExternalMessageById(external.parseExternalMailbox(address)!, "42", transport), /external_mail_(manual_only|id_api_unavailable)/);
    }
    assert.equal(count, 0);
  });

  await t.test("wrong IDs, recipient mismatches and failures never leak upstream secrets", async () => {
    const mailbox = external.parseExternalMailbox("https://yangyang.website/messages/offline-secret/a%40example.test")!;
    await assert.rejects(external.fetchExternalMessageById(mailbox, "42", (async () => new Response(JSON.stringify({ id: "43" }))) as typeof fetch), /external_mail_id_mismatch/);
    await assert.rejects(external.fetchExternalMessageById(mailbox, "42", (async () => new Response(JSON.stringify({ id: "42", toAddress: "other@example.test" }))) as typeof fetch), /external_mail_recipient_mismatch/);
    await assert.rejects(external.fetchExternalMessageById(mailbox, "42", (async () => { throw new Error("offline-secret"); }) as typeof fetch), (error: any) => error.message === "external_mail_transport_error");
    await assert.rejects(external.fetchExternalMessageById(mailbox, "42", (async () => new Response("offline-secret", { status: 500 })) as typeof fetch), (error: any) => error.message === "external_mail_http_500");
  });
});
