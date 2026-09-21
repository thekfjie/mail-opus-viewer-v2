import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { manageWebhook } from "../scripts/manage-webhook.mjs";

function fixture(receiverUrl?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-webhook-management-"));
  fs.chmodSync(root, 0o700);
  const environmentFile = path.join(root, "runtime.env");
  fs.writeFileSync(environmentFile, "MAIL_API_BASE=https://upstream.example.test\nMAIL_ADMIN_AUTH=fake-admin-only\nV2_MAIL_WEBHOOK_SECRET=fake-webhook-only\n"
    + (receiverUrl === undefined ? "" : `V2_MAIL_WEBHOOK_URL=${receiverUrl}\n`), { mode: 0o600 });
  const backupDirectory = path.join(root, "backup");
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  return { root, environmentFile, backupDirectory };
}

test("webhook apply protects the original settings before writing and verifies only metadata is sent", async () => {
  const fixtureData = fixture();
  const original = { enabled: false, url: "https://old.example.test/hook", method: "POST", headers: '{"authorization":"fake-prior-secret"}', body: '{"id":"${id}"}',
    unknownVersionField: { preserve: true, aiSettings: { enabled: true, model: "fake-model" } } };
  let remote = original;
  const calls: { method: string; body: any }[] = [];
  const transport = async (url: string, init: RequestInit) => {
    assert.equal(url, "https://upstream.example.test/admin/mail_webhook/settings");
    assert.equal(init.redirect, "error");
    assert.equal((init.headers as any)["x-admin-auth"], "fake-admin-only");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, body });
    if (init.method === "POST") {
      const backups = fs.readdirSync(fixtureData.backupDirectory);
      assert.equal(backups.length, 1);
      const file = path.join(fixtureData.backupDirectory, backups[0]);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).settings, original);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      remote = body;
      return Response.json({ success: true });
    }
    return Response.json(remote);
  };
  try {
    const result = await manageWebhook({ action: "apply", backupDirectory: fixtureData.backupDirectory }, { environmentFile: fixtureData.environmentFile, transport });
    assert.equal(result.verified, true);
    assert.equal(result.requests, 3);
    assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "GET"]);
    assert.equal(remote.enabled, true);
    assert.equal(remote.url, "https://mailhook.kfjie.me/api/v2/internal/mail-events");
    assert.deepEqual(remote.unknownVersionField, original.unknownVersionField);
    assert.deepEqual(JSON.parse(remote.headers), { "content-type": "application/json", authorization: "Bearer fake-webhook-only" });
    assert.deepEqual(JSON.parse(remote.body), { id: "${id}", from: "${from}", to: "${to}", subject: "${subject}" });
    assert.equal(JSON.stringify(result).includes("fake-"), false);

    calls.length = 0;
    const restored = await manageWebhook({ action: "rollback", rollbackFile: path.join(fixtureData.backupDirectory, result.backupFile) },
      { environmentFile: fixtureData.environmentFile, transport });
    assert.equal(restored.verified, true);
    assert.equal(restored.requests, 2);
    assert.deepEqual(calls.map((call) => call.method), ["POST", "GET"]);
    assert.deepEqual(remote, original);
  } finally { fs.rmSync(fixtureData.root, { recursive: true, force: true }); }
});

test("receiver URL comes from protected configuration and accepts a dedicated HTTPS host", async () => {
  const input = fixture("https://receiver.example.test/custom-hook");
  let remote: any = { enabled: false };
  try {
    const result = await manageWebhook({ action: "apply", backupDirectory: input.backupDirectory }, {
      environmentFile: input.environmentFile,
      transport: async (_url: string, init: RequestInit) => {
        if (init.method === "POST") {
          remote = JSON.parse(String(init.body));
          return Response.json({ success: true });
        }
        return Response.json(remote);
      },
    });
    assert.equal(result.verified, true);
    assert.equal(remote.url, "https://receiver.example.test/custom-hook");
    assert.deepEqual(Object.keys(JSON.parse(remote.body)), ["id", "from", "to", "subject"]);
  } finally { fs.rmSync(input.root, { recursive: true, force: true }); }
});

test("unsafe receiver URLs fail before upstream access or settings backups", async () => {
  for (const receiverUrl of ["http://receiver.example.test/hook", "https://user:fake-secret@receiver.example.test/hook",
    "https://receiver.example.test/hook?token=fake-secret", "https://receiver.example.test/hook#fragment", "not a URL"]) {
    const input = fixture(receiverUrl);
    let calls = 0;
    try {
      await assert.rejects(manageWebhook({ action: "apply", backupDirectory: input.backupDirectory }, {
        environmentFile: input.environmentFile,
        transport: async () => { calls += 1; return Response.json({ enabled: false }); },
      }), (error: any) => error.code === "INVALID_WEBHOOK_RECEIVER_URL" && !error.message.includes(receiverUrl));
      assert.equal(calls, 0);
      assert.deepEqual(fs.readdirSync(input.backupDirectory), []);
    } finally { fs.rmSync(input.root, { recursive: true, force: true }); }
  }
});

test("disabled Webhook is classified without printing upstream content or attempting POST", async () => {
  const input = fixture();
  let calls = 0;
  const marker = "BODY-AND-TOKEN-MUST-NOT-BE-OUTPUT";
  const transport = async (_url: string, init: RequestInit) => {
    calls += 1;
    assert.equal(init.method, "GET");
    return new Response(`Webhook is disabled ${marker}`, { status: 403 });
  };
  try {
    const result = await manageWebhook({ action: "inspect" }, { environmentFile: input.environmentFile, transport });
    assert.deepEqual(result, { ok: false, enabled: null, httpStatus: 403, classification: "WEBHOOK_DISABLED_OR_KV_MISSING" });
    assert.equal(JSON.stringify(result).includes(marker), false);
    assert.equal(calls, 1);
    await assert.rejects(manageWebhook({ action: "apply", backupDirectory: input.backupDirectory }, { environmentFile: input.environmentFile, transport }),
      (error: any) => error.code === "WEBHOOK_DISABLED_OR_KV_MISSING" && !error.message.includes(marker));
    assert.equal(calls, 2);
    assert.deepEqual(fs.readdirSync(input.backupDirectory), []);
  } finally { fs.rmSync(input.root, { recursive: true, force: true }); }
});

test("failed verification retains a protected rollback file without another update", async () => {
  const input = fixture();
  const methods: string[] = [];
  try {
    await assert.rejects(manageWebhook({ action: "apply", backupDirectory: input.backupDirectory }, {
      environmentFile: input.environmentFile,
      transport: async (_url: string, init: RequestInit) => {
        methods.push(init.method!);
        return Response.json(init.method === "POST" ? { success: true } : { enabled: false });
      },
    }), (error: any) => error.code === "WEBHOOK_SETTINGS_VERIFICATION_FAILED");
    assert.deepEqual(methods, ["GET", "POST", "GET"]);
    assert.equal(fs.readdirSync(input.backupDirectory).length, 1);
  } finally { fs.rmSync(input.root, { recursive: true, force: true }); }
});

test("unsafe permissions and tampered rollback files are rejected before external writes", async () => {
  const input = fixture();
  let calls = 0;
  const transport = async () => { calls += 1; return Response.json({ enabled: false }); };
  try {
    fs.chmodSync(input.environmentFile, 0o644);
    await assert.rejects(manageWebhook({ action: "inspect" }, { environmentFile: input.environmentFile, transport }),
      (error: any) => error.code === "PROTECTED_FILE_MODE_REQUIRED");
    fs.chmodSync(input.environmentFile, 0o600);
    const rollbackFile = path.join(input.backupDirectory, "original.json");
    fs.writeFileSync(rollbackFile, JSON.stringify({ version: 1, upstreamOrigin: "https://upstream.example.test", settingsSha256: "wrong", settings: { enabled: false } }), { mode: 0o600 });
    await assert.rejects(manageWebhook({ action: "rollback", rollbackFile }, { environmentFile: input.environmentFile, transport }),
      (error: any) => error.code === "INVALID_WEBHOOK_BACKUP");
    assert.equal(calls, 0);
  } finally { fs.rmSync(input.root, { recursive: true, force: true }); }
});
