import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const server = fs.readFileSync(path.resolve("src/server/server.ts"), "utf8");
const worker = fs.readFileSync(path.resolve("src/server/worker.ts"), "utf8");
const config = fs.readFileSync(path.resolve("src/server/config.ts"), "utf8");

test("V2 运行时固定本地权威且不加载 V1 适配器或文件投影", () => {
  const runtime = `${server}\n${worker}\n${config}`;
  assert.match(config, /const accountAuthority = "v2" as const/);
  assert.doesNotMatch(runtime, /v1-compat|legacy-config|legacy-import|requestV1|proxyV1|refreshV1Projection|syncFromV1|8789|\/opt\/mail-opus-viewer/);
  assert.match(server, /export async function buildApp/);
  assert.match(worker, /export function createWorker/);
});

test("共享邮件摄取归 V2，Worker 不做定时 Cloudflare 列表扫描", () => {
  assert.match(config, /V2_SHARED_MAIL_SYNC_ENABLED \|\| "false"/);
  assert.doesNotMatch(worker, /syncSharedMail/);
  assert.doesNotMatch(worker, /v1_owns_mailbox_ingestion/);
  assert.match(worker, /event_or_admin_trigger_only/);
  assert.match(config, /V2_OUTLOOK_MAIL_SYNC_ENABLED \|\| "false"/);
  assert.match(worker, /if \(config\.outlookMailSyncEnabled && now - lastOutlookSyncAt >= config\.outlookSyncIntervalMs\)/);
  assert.match(worker, /pendingMail: retryPendingSharedMailEvents/);
});
