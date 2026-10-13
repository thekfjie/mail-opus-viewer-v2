import { databaseSnapshot } from "./helpers/database-snapshot.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

test("lightweight ingestion preserves V1 subjects, verified dates, ownership and no mail bodies", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-mail-ingestion-"));
  process.env.PROJECT_ROOT = directory;
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.V2_SESSION_SECRET = "fake-session-secret";
  process.env.CREDENTIAL_ENCRYPTION_KEY = "fake-encryption-key";
  process.env.V2_CF_D1_READ_TOKEN = "";
  const [{ db }, { encryptSecret }, { ingestSharedMailEvent, manualSharedMailBackfill, syncSharedMail, retrySharedMailEvent, retryPendingSharedMailEvents, recheckBillingEvidenceForMail, reconcileSharedMailOwnership }, { classifyMail }, { sharedMailRaw, fetchSharedMessage }, { extractVerificationCode, pendingMailboxVerificationCode }, { emailHash, stableId }, { pendingMailboxForEmail, upsertCompatibilityAccount, SIGNUP_NOTE }] = await Promise.all([
    import("../src/server/db.js"), import("../src/server/crypto.js"), import("../src/server/mail-sync.js"),
    import("../src/server/mail-classification.js"), import("../src/server/upstream-mail.js"), import("../src/server/native-mail.js"), import("../src/server/association.js"), import("../src/server/compatibility-state.js"),
  ]);
  t.after(async () => { (await db.close()); fs.rmSync(directory, { recursive: true }); });
  const now = "2026-09-01T00:00:00.000Z";
  (await db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, arrived_at, created_at, updated_at) VALUES('account','active',?,?,?)`).run(now, now, now));
  (await db.prepare(`INSERT INTO mailbox_families(id, provider, canonical_address_hash, created_at, updated_at)
    VALUES('family','domain','hash',?,?)`).run(now, now));
  (await db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,valid_from,is_current,legacy_mapping_id,created_at,updated_at)
    VALUES('binding','account','family',?,'hash','user','example.com','domain',?,1,'test-legacy',?,?)`).run(encryptSecret("user@example.com"), now, now, now));
  (await db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,recipient_pattern,valid_from,source,created_at,updated_at)
    VALUES('rule','binding','^user@example\\.com$',?,'test',?,?)`).run(now, now, now));
  for (const subject of ["OpenAI - 存取權已停用 [case]", "OpenAI - 訪問權限已停用", "OpenAI - 帐户已停用", " OpenAI - Access\r\n Deactivated [code] ", "OpenAI - アクセスが無効になりました [case]"]) {
    assert.equal(classifyMail(subject, "OpenAI").category, "deactivation");
  }
  assert.equal(classifyMail("Newsletter about Access Deactivated", "OpenAI").category, "promotion");
  const marker = "BODY-RAW-HTML-ATTACHMENT-CANARY-72384";
  const raw = ["From: OpenAI <trustandsafety@tm.openai.com>", "To: forward@example.net", "Delivered-To: user@example.com",
    "Subject: OpenAI - Access Deactivated [case]", "Date: Sun, 01 Jan 2000 00:00:00 +0000",
    "MIME-Version: 1.0", "Content-Type: multipart/mixed; boundary=canary-boundary", "", "--canary-boundary",
    "Content-Type: text/html; charset=utf-8", "", `<p>${marker.repeat(4000)}</p>`, "--canary-boundary",
    "Content-Type: application/octet-stream", "Content-Transfer-Encoding: base64", "Content-Disposition: attachment; filename=test.bin", "",
    Buffer.from(marker).toString("base64"), "--canary-boundary--"].join("\r\n");
  let reads = 0;
  const pending = await ingestSharedMailEvent({ id: "1", raw, to: "forward@example.net", subject: "ignored" }, {
    byId: async () => { reads += 1; throw new Error(marker); },
  });
  assert.equal(pending.processingStatus, "pending_time");
  assert.equal(reads, 1);
  assert.deepEqual((await db.prepare("SELECT deactivation_locked,deactivated_at FROM gpt_accounts WHERE id='account'").get()),
    { deactivation_locked: 0, deactivated_at: "" });
  const evidence = await db.prepare("SELECT event_type,source,payload_json FROM lifecycle_events WHERE account_id='account'").get();
  assert.deepEqual({event_type:evidence.event_type,source:evidence.source,automatic_state_change:JSON.parse(evidence.payload_json).automaticStateChange},
    { event_type: "deactivation_mail_detected", source: "shared-mail-api-sync", automatic_state_change: false });
  assert.equal(((await db.prepare("SELECT received_at FROM mail_messages").get()) as any).received_at, "");
  await ingestSharedMailEvent({ id: "1", raw }, { byId: async () => { throw new Error("temporarily unavailable"); } });
  assert.equal(((await db.prepare("SELECT deactivated_at FROM gpt_accounts WHERE id='account'").get()) as any).deactivated_at, "");
  (await db.prepare("UPDATE mail_ingestion_leases SET retry_after=0 WHERE provider_message_id='1'").run());
  const completed = await ingestSharedMailEvent({ id: "1", raw }, {
    byId: async () => { reads += 1; return { id: 1, raw_blob: Array.from(gzipSync(raw)), address: "forward@example.net", created_at: "2026-09-07 08:30:00" }; },
  });
  assert.equal(completed.processingStatus, "processed");
  assert.equal(reads, 2);
  assert.deepEqual((await db.prepare("SELECT lifecycle_status,deactivation_locked,deactivated_at FROM gpt_accounts WHERE id='account'").get()),
    { lifecycle_status: "active", deactivation_locked: 0, deactivated_at: "" });
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM lifecycle_events WHERE account_id='account' AND event_type='deactivation_mail_detected'").get()) as any).n, 1);
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM mail_ownership_claims").get()) as any).n, 1);
  await ingestSharedMailEvent({ id: "1", raw: marker }, { byId: async () => { reads += 1; throw new Error("must not read"); } });
  assert.equal(reads, 2);
  assert.equal(sharedMailRaw({ id: 99, raw_blob: Array.from(gzipSync("decoded-content")) }), "decoded-content");
  assert.equal((await databaseSnapshot(db)).includes(marker), false);
  assert.equal((await databaseSnapshot(db)).includes(Buffer.from(marker).toString("base64")), false);
  for (const file of fs.readdirSync(directory)) {
    assert.equal(fs.readFileSync(path.join(directory, file)).includes(Buffer.from(marker)), false, file);
  }
  await assert.rejects(syncSharedMail(), (error: any) => error.code === "mail_explicit_backfill_window_required");
  let pages = 0;
  const backfill = await manualSharedMailBackfill({ from: "2026-09-07T00:00:00Z", to: "2026-09-08T00:00:00Z" }, {
    backfill: async () => { pages += 1; return { rows: [{ id: 2, raw, address: "user@example.com", created_at: "2026-09-07 09:00:00" }],
      complete: true, cursor: { createdAt: "2026-09-07T09:00:00.000Z", id: "2" } }; },
  });
  assert.equal(pages, 1);
  assert.equal(backfill.inserted, 1);
  assert.equal(((await db.prepare("SELECT deactivated_at FROM gpt_accounts WHERE id='account'").get()) as any).deactivated_at, "");
  assert.equal((await databaseSnapshot(db)).includes(marker), false);
  const failed = await ingestSharedMailEvent({ id: "3", raw_blob: "invalid-gzip", parsedText: marker, parsedHtml: marker });
  assert.equal(failed.processingStatus, "pending_parse");
  assert.deepEqual(await retryPendingSharedMailEvents(), { processed: 0, errors: 0 });
  assert.equal(((await db.prepare("SELECT attempts FROM mail_ingestion_state WHERE provider_message_id='3'").get()) as any).attempts, 0);
  let attempts = 0;
  for (let i = 0; i < 3; i += 1) {
    (await db.prepare("UPDATE mail_ingestion_leases SET retry_after=0 WHERE provider_message_id='3'").run());
    await assert.rejects(retrySharedMailEvent("3", { byId: async () => { attempts += 1; throw new Error(marker); } }),
      (error: any) => error.code === "mail_processing_failed");
  }
  await assert.rejects(retrySharedMailEvent("3", { byId: async () => { attempts += 1; return null; } }),
    (error: any) => error.code === "mail_event_retry_exhausted");
  assert.equal(attempts, 3);
  await retrySharedMailEvent("1", { byId: async () => { throw new Error("processed event must not request"); } });
  const detail = await fetchSharedMessage("1", "user@example.com", { byId: async () => ({ id: 1, raw, address: "forward@example.net" }) });
  assert.ok(detail?.html.includes(marker));
  const displayNameRecipient = await fetchSharedMessage("1", "Hide My Email <user+oai123@icloud.com>", {
    byId: async () => ({ id: 1, raw, address: "Hide My Email <user@icloud.com>" }),
  });
  assert.equal(displayNameRecipient?.to, "Hide My Email <user@icloud.com>");
  const inlineImageRaw = ["From: OpenAI <noreply@openai.com>", "To: user@example.com", "Subject: Image",
    "MIME-Version: 1.0", "Content-Type: multipart/related; boundary=image-boundary", "", "--image-boundary",
    "Content-Type: text/html; charset=utf-8", "", '<img src="cid:openai-logo">', "--image-boundary",
    "Content-Type: image/png", "Content-ID: <openai-logo>", "Content-Transfer-Encoding: base64", "", Buffer.from("fake-png").toString("base64"),
    "--image-boundary--"].join("\r\n");
  const inlineImage = await fetchSharedMessage("2", "user@example.com", { byId: async () => ({ id: 2, raw: inlineImageRaw, address: "user@example.com" }) });
  assert.match(String(inlineImage?.html), /src="data:image\/png;base64,/);
  assert.doesNotMatch(String(inlineImage?.html), /cid:openai-logo/);
  await assert.rejects(fetchSharedMessage("1", "unrelated@example.com", { byId: async () => ({ id: 1, raw, address: "forward@example.net" }) }),
    (error: any) => error.code === "mail_recipient_mismatch");
  assert.equal(extractVerificationCode({ subject: "ChatGPT の一時検証コード", html: "<p>この一時検証コードを入力して続行 823456</p>" }), "823456");
  assert.equal((await databaseSnapshot(db)).includes(marker), false);
  const pendingEmail = "new-signup@example.com";
  (await db.prepare(`INSERT INTO pending_mailboxes(id,email_hash,email_enc,kind,created_at,updated_at)
    VALUES('pending-test',?,?,'signup',?,?)`).run(emailHash(pendingEmail), encryptSecret(pendingEmail), now, now));
  const otpRaw = ["From: OpenAI <noreply@openai.com>", `To: ${pendingEmail}`, "Subject: Your ChatGPT verification code",
    "Content-Type: text/plain; charset=utf-8", "", `Your verification code is 872134. ${marker}`].join("\r\n");
  await ingestSharedMailEvent({ id: 4, address: pendingEmail, raw: otpRaw, created_at: "2026-09-07 10:00:00" });
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM pending_mail_claims WHERE pending_id='pending-test'").get()) as any).n, 1);
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM gpt_accounts").get()) as any).n, 1);
  let otpReads = 0;
  const reader = { byId: async (id: string) => { otpReads += 1; assert.equal(id, "4");
    return { id: 4, address: pendingEmail, raw: otpRaw, created_at: "2026-09-07 10:00:00" }; } };
  const otp = await pendingMailboxVerificationCode(pendingEmail, reader) as any;
  assert.equal(otp.item.verificationCode, "872134");
  assert.equal("text" in otp.item, false);
  assert.equal("html" in otp.item, false);
  assert.equal(otpReads, 1);
  await pendingMailboxVerificationCode(pendingEmail, reader);
  assert.equal(otpReads, 1);
  const aliasEmail = "alias-signup+oai123@icloud.com";
  (await db.prepare(`INSERT INTO pending_mailboxes(id,email_hash,email_enc,kind,created_at,updated_at)
    VALUES('pending-alias',?,?,'signup',?,?)`).run(emailHash(aliasEmail), encryptSecret(aliasEmail), now, now));
  assert.equal((await pendingMailboxForEmail("alias-signup@icloud.com"))?.email, aliasEmail);
  const aliasRaw = ["From: OpenAI <noreply@openai.com>", "To: alias-signup@icloud.com", "Subject: Your temporary ChatGPT verification code",
    "Content-Type: text/plain; charset=utf-8", "", "Your verification code is 314159."].join("\r\n");
  await ingestSharedMailEvent({ id: 5, address: "alias-signup@icloud.com", raw: aliasRaw, created_at: "2026-09-07 10:01:00" });
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM pending_mail_claims WHERE pending_id='pending-alias'").get()) as any).n, 1);
  const aliasOtp = await pendingMailboxVerificationCode(aliasEmail, { byId: async (id: string) => {
    assert.equal(id, "5"); return { id: 5, address: "alias-signup@icloud.com", raw: aliasRaw, created_at: "2026-09-07 10:01:00" };
  } }) as any;
  assert.equal(aliasOtp.item.verificationCode, "314159");

  // Active iCloud bindings must keep ownership when upstream headers collapse
  // ``local+suffix@icloud.com`` to ``local@icloud.com``. The local index stores
  // only the lightweight recipient field; the raw message remains upstream.
  const activeAlias = "active-route+oai456@icloud.com";
  (await db.prepare(`INSERT INTO gpt_accounts(id, lifecycle_status, arrived_at, created_at, updated_at)
    VALUES('icloud-active-account','active',?,?,?)`).run(now, now, now));
  (await db.prepare(`INSERT INTO mailbox_families(id, provider, canonical_address_hash, created_at, updated_at)
    VALUES('icloud-active-family','icloud',?,?,?)`).run(now, now, now));
  (await db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,valid_from,is_current,legacy_mapping_id,created_at,updated_at)
    VALUES('icloud-active-binding','icloud-active-account','icloud-active-family',?,?,'active-route+oai456','icloud.com','icloud',?,1,'icloud-active-legacy',?,?)`)
    .run(encryptSecret(activeAlias), emailHash(activeAlias), now, now, now));
  (await db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,sender_pattern,recipient_pattern,valid_from,source,created_at,updated_at)
    VALUES('icloud-active-rule','icloud-active-binding','^noreply@openai\\.com$','(^|<|\\b)active-route\\+oai456@icloud\\.com(>|\\b|$)',?,'test',?,?)`)
    .run(now, now, now));
  const activeAliasRaw = ["From: OpenAI <noreply@openai.com>", "To: active-route@icloud.com",
    "Subject: Your temporary ChatGPT verification code", "Content-Type: text/plain; charset=utf-8", "",
    "Your verification code is 112233."].join("\r\n");
  await ingestSharedMailEvent({ id: 7, address: "active-route@icloud.com", raw: activeAliasRaw, created_at: "2026-09-07 10:02:00" });
  const activeMessageId = ((await db.prepare("SELECT id FROM mail_messages WHERE provider='shared-mail-api' AND provider_message_id='7'").get()) as any).id;
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM mail_ownership_claims WHERE message_id=? AND binding_id='icloud-active-binding'").get(activeMessageId)) as any).n, 1);

  const billingMarker = "BILLING-BODY-MUST-NOT-PERSIST-57391";
  const momoRaw = ["From: OpenAI <noreply@openai.com>", "To: active-route@icloud.com",
    "Subject: ChatGPT - Your new plan", "Content-Type: text/plain; charset=utf-8", "",
    "You've successfully subscribed to ChatGPT Plus.",
    "Order number: sub_test", "ChatGPT Plus Subscription ₫475000", "Total: ₫475000 Payment method: MoMo",
    billingMarker].join("\r\n");
  await ingestSharedMailEvent({ id: 9, address: "active-route@icloud.com", raw: momoRaw, created_at: "2026-09-07 10:04:00" });
  assert.deepEqual((await db.prepare("SELECT plan,billing_channel FROM gpt_accounts WHERE id='icloud-active-account'").get()),
    { plan: "plus", billing_channel: "vn-momo" });
  assert.deepEqual((await db.prepare("SELECT billing_started_at FROM account_business_evidence WHERE account_id='icloud-active-account'").get()),
    { billing_started_at: "2026-09-07T10:04:00.000Z" });
  const momoMessageId = String(((await db.prepare("SELECT id FROM mail_messages WHERE provider='shared-mail-api' AND provider_message_id='9'").get()) as any).id);
  assert.deepEqual((await db.prepare("SELECT channel,evidence_id,active FROM billing_channel_observations WHERE account_id='icloud-active-account'").get()),
    { channel: "vn-momo", evidence_id: momoMessageId, active: 1 });
  assert.equal(((await db.prepare("SELECT event_type FROM lifecycle_events WHERE account_id='icloud-active-account' AND event_type='plus_activated_by_mail'").get()) as any).event_type,
    "plus_activated_by_mail");
  assert.equal((await databaseSnapshot(db)).includes(billingMarker), false);

  (await db.prepare("UPDATE gpt_accounts SET plan='free',billing_channel='' WHERE id='icloud-active-account'").run());
  (await db.prepare("DELETE FROM billing_channel_observations WHERE account_id='icloud-active-account'").run());
  let billingReads = 0;
  const recheckedBilling = await recheckBillingEvidenceForMail("9", { byId: async (id: string) => {
    billingReads += 1;
    assert.equal(id, "9");
    return { id: 9, address: "active-route@icloud.com", raw: momoRaw, created_at: "2026-09-07 10:04:00" };
  } });
  assert.equal(billingReads, 1);
  assert.deepEqual(recheckedBilling, { matched: true, accountIds: ["icloud-active-account"], messageId: momoMessageId, billingChannel: "vn-momo" });
  assert.deepEqual((await db.prepare("SELECT plan,billing_channel FROM gpt_accounts WHERE id='icloud-active-account'").get()),
    { plan: "plus", billing_channel: "vn-momo" });
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM billing_channel_observations WHERE account_id='icloud-active-account'").get()) as any).n, 1);
  assert.equal((await databaseSnapshot(db)).includes(billingMarker), false);

  // A zero-charge first month with a real order and payment block is an
  // activation receipt, not a marketing-only trial. Exact-ID recheck must
  // refresh both its category and the Plus/channel projections.
  (await db.prepare("UPDATE gpt_accounts SET plan='free',billing_channel='' WHERE id='icloud-active-account'").run());
  (await db.prepare("DELETE FROM billing_channel_observations WHERE account_id='icloud-active-account'").run());
  const vietnameseTrialRaw = ["From: OpenAI <noreply@openai.com>", "To: active-route@icloud.com",
    "Subject: ChatGPT - Kế hoạch mới của bạn", "Content-Type: text/plain; charset=utf-8", "",
    "Bạn đã đăng ký thành công ChatGPT Plus.", "ChatGPT Plus Subscription ₫475000",
    "Giảm giá: -₫475000", "Tổng: ₫0", "Phương thức thanh toán: unknown", "Tháng đầu tiên miễn phí."].join("\r\n");
  await ingestSharedMailEvent({ id: 7722, address: "active-route@icloud.com", subject: "stale webhook" }, {
    byId: async () => ({ id: 7722, address: "active-route@icloud.com", raw: vietnameseTrialRaw, created_at: "2026-09-07 10:05:00" }),
  });
  const vietnameseMessageId = String(((await db.prepare("SELECT id FROM mail_messages WHERE provider='shared-mail-api' AND provider_message_id='7722'").get()) as any).id);
  (await db.prepare("UPDATE mail_messages SET category='general' WHERE id=?").run(vietnameseMessageId));
  let vietnameseReads = 0;
  const vietnameseRecheck = await recheckBillingEvidenceForMail("7722", { byId: async () => {
    vietnameseReads += 1;
    return { id: 7722, address: "active-route@icloud.com", raw: vietnameseTrialRaw, created_at: "2026-09-07 10:05:00" };
  } });
  assert.equal(vietnameseReads, 1);
  assert.deepEqual(vietnameseRecheck, { matched: true, accountIds: ["icloud-active-account"], messageId: vietnameseMessageId, billingChannel: "vn-momo" });
  assert.equal(((await db.prepare("SELECT category FROM mail_messages WHERE id=?").get(vietnameseMessageId)) as any).category, "billing");
  assert.deepEqual((await db.prepare("SELECT plan,billing_channel FROM gpt_accounts WHERE id='icloud-active-account'").get()),
    { plan: "plus", billing_channel: "vn-momo" });
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM billing_channel_observations WHERE account_id='icloud-active-account' AND evidence_id=?").get(vietnameseMessageId)) as any).n, 1);

  // The equivalence is deliberately one-plus-vs-base only; two different
  // aliases sharing a base must never become interchangeable.
  const aliasMismatchRaw = ["From: OpenAI <noreply@openai.com>", "To: active-route+oai999@icloud.com",
    "Subject: Your temporary ChatGPT verification code", "Content-Type: text/plain; charset=utf-8", "",
    "Your verification code is 445566."].join("\r\n");
  await ingestSharedMailEvent({ id: 8, address: "active-route+oai999@icloud.com", raw: aliasMismatchRaw, created_at: "2026-09-07 10:03:00" });
  const mismatchMessageId = ((await db.prepare("SELECT id FROM mail_messages WHERE provider='shared-mail-api' AND provider_message_id='8'").get()) as any).id;
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM mail_ownership_claims WHERE message_id=?").get(mismatchMessageId)) as any).n, 0);

  // A webhook/index pass can win the race with the pending mailbox import.
  // Creating the pending record afterwards must backfill only this bounded
  // security-mail window so the OTP remains readable without storing a body.
  const lateEmail = "late-signup+oai999@icloud.com";
  const lateReceivedAt = new Date().toISOString();
  const lateRaw = ["From: OpenAI <noreply@openai.com>", "To: late-signup@icloud.com",
    "Subject: Your temporary ChatGPT verification code", "Content-Type: text/plain; charset=utf-8", "",
    "Your verification code is 271828."].join("\r\n");
  await ingestSharedMailEvent({ id: 6, address: "late-signup@icloud.com", raw: lateRaw, created_at: lateReceivedAt });
  const latePending = (await upsertCompatibilityAccount({ email: lateEmail, note: SIGNUP_NOTE }));
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM pending_mail_claims WHERE pending_id=?").get(latePending.id)) as any).n, 1);
  const lateOtp = await pendingMailboxVerificationCode(lateEmail, { byId: async (id: string) => {
    assert.equal(id, "6"); return { id: 6, address: lateEmail, raw: lateRaw, created_at: lateReceivedAt };
  } }) as any;
  assert.equal(lateOtp.item.verificationCode, "271828");
  assert.equal("text" in lateOtp.item, false);
  assert.equal("html" in lateOtp.item, false);
  assert.equal((await databaseSnapshot(db)).includes(marker), false);

  // A stale/shared legacy regex on another account must not defeat the exact
  // recipient binding. Reconciliation also removes its old derived claim.
  (await db.prepare(`INSERT INTO gpt_accounts(id,lifecycle_status,arrived_at,created_at,updated_at)
    VALUES('indirect-account','active',?,?,?)`).run(now, now, now));
  (await db.prepare(`INSERT INTO mailbox_families(id,provider,canonical_address_hash,created_at,updated_at)
    VALUES('indirect-family','domain','indirect-family',?,?)`).run(now, now));
  (await db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,
    valid_from,is_current,legacy_mapping_id,created_at,updated_at)
    VALUES('indirect-binding','indirect-account','indirect-family',?,'indirect-hash','other','example.com','domain',?,1,'indirect-legacy',?,?)`)
    .run(encryptSecret("other@example.com"), now, now, now));
  (await db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,recipient_pattern,valid_from,source,created_at,updated_at)
    VALUES('indirect-rule','indirect-binding','^user@example\\.com$',?,'legacy-test',?,?)`).run(now, now, now));
  const exactRaw = "From: sender@example.net\r\nTo: user@example.com\r\nSubject: Exact owner\r\n\r\nbody";
  await ingestSharedMailEvent({ id: 12, address: "user@example.com", raw: exactRaw, created_at: "2026-09-07 11:00:00" });
  const exactMessageId = stableId("mail-message", "shared-mail-api", "12");
  assert.deepEqual((await db.prepare(`SELECT account_id,binding_id,visible_to_customer FROM mail_ownership_claims
    WHERE message_id=? ORDER BY account_id`).all(exactMessageId)),
  [{ account_id: "account", binding_id: "binding", visible_to_customer: 1 }]);
  (await db.prepare(`INSERT INTO mail_ownership_claims(message_id,account_id,binding_id,claim_type,confidence,reason,visible_to_customer,created_at)
    VALUES(?,'indirect-account','indirect-binding','routing_rule',1,'stale-program-claim',0,?)`).run(exactMessageId, now));
  await reconcileSharedMailOwnership("12", { byId: async () => ({
    id: 12, address: "user@example.com", raw: exactRaw, created_at: "2026-09-07 11:00:00",
  }) });
  assert.deepEqual((await db.prepare(`SELECT account_id,binding_id,visible_to_customer FROM mail_ownership_claims
    WHERE message_id=? ORDER BY account_id`).all(exactMessageId)),
  [{ account_id: "account", binding_id: "binding", visible_to_customer: 1 }]);

  // A bare recipient and a concrete +oai alias both identify the shared
  // mailbox batch. Neither address selects one child inside that batch.
  for (const [label, accountId, bindingId, email, validFrom] of [
    ["old", "base-old-account", "base-old-binding", "base-generation+oaiold@icloud.com", "2026-08-29T06:14:45.740Z"],
    ["middle", "base-middle-account", "base-middle-binding", "base-generation+oaimiddle@icloud.com", "2026-09-01T05:37:57.463Z"],
    ["new", "base-new-account", "base-new-binding", "base-generation+oainew@icloud.com", "2026-09-03T05:37:57.463Z"],
  ]) {
    (await db.prepare(`INSERT INTO gpt_accounts(id,lifecycle_status,arrived_at,created_at,updated_at)
      VALUES(?,'active',?,?,?)`).run(accountId, validFrom, validFrom, validFrom));
    (await db.prepare(`INSERT INTO mailbox_families(id,provider,canonical_address_hash,created_at,updated_at)
      VALUES(?,'icloud',?,?,?)`).run(`base-${label}-family`, `base-${label}-hash`, validFrom, validFrom));
    (await db.prepare(`INSERT INTO email_bindings(id,account_id,mailbox_family_id,email_enc,email_hash,local_part,domain,provider,
      valid_from,is_current,legacy_mapping_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'icloud.com','icloud',?,1,?,?,?)`).run(
      bindingId, accountId, `base-${label}-family`, encryptSecret(email), `base-${label}-email-hash`,
      email.split("@")[0], validFrom, `base-${label}-legacy`, validFrom, validFrom,
    ));
    (await db.prepare(`INSERT INTO mail_routing_rules(id,binding_id,recipient_pattern,valid_from,source,created_at,updated_at)
      VALUES(?,?,?,?,'v1-generation-test',?,?)`).run(
      `base-${label}-rule`, bindingId, `^${email.replace(/[.+]/g, "\\$&")}$`, validFrom, validFrom, validFrom,
    ));
  }
  const baseRaw = "From: OpenAI <noreply@openai.com>\r\nTo: base-generation@icloud.com\r\nSubject: Security alert\r\n\r\nbody";
  await ingestSharedMailEvent({ id: 13, address: "base-generation@icloud.com", raw: baseRaw, created_at: "2026-09-04 16:15:18" });
  assert.deepEqual((await db.prepare(`SELECT account_id,binding_id,visible_to_customer FROM mail_ownership_claims
    WHERE message_id=? ORDER BY account_id`).all(stableId("mail-message", "shared-mail-api", "13"))), [
    { account_id: "base-middle-account", binding_id: "base-middle-binding", visible_to_customer: 1 },
    { account_id: "base-new-account", binding_id: "base-new-binding", visible_to_customer: 1 },
    { account_id: "base-old-account", binding_id: "base-old-binding", visible_to_customer: 1 },
  ]);
  const exactOldRaw = baseRaw.replaceAll("base-generation@icloud.com", "base-generation+oaiold@icloud.com");
  await ingestSharedMailEvent({ id: 14, address: "base-generation+oaiold@icloud.com", raw: exactOldRaw, created_at: "2026-09-04 16:15:20" });
  assert.deepEqual((await db.prepare(`SELECT account_id,binding_id,visible_to_customer FROM mail_ownership_claims
    WHERE message_id=? ORDER BY account_id`).all(stableId("mail-message", "shared-mail-api", "14"))), [
    { account_id: "base-middle-account", binding_id: "base-middle-binding", visible_to_customer: 1 },
    { account_id: "base-new-account", binding_id: "base-new-binding", visible_to_customer: 1 },
    { account_id: "base-old-account", binding_id: "base-old-binding", visible_to_customer: 1 },
  ]);

  (await db.prepare("DELETE FROM pending_mailboxes WHERE id='pending-test'").run());
  (await db.prepare("DELETE FROM pending_mailboxes WHERE id='pending-alias'").run());
  (await db.prepare("DELETE FROM pending_mailboxes WHERE id=?").run(latePending.id));
  assert.equal(((await db.prepare("SELECT COUNT(*) n FROM pending_mail_claims").get()) as any).n, 0);
  await assert.rejects(pendingMailboxVerificationCode(pendingEmail, reader), (error: any) => error.code === "pending_mailbox_not_found");
});
