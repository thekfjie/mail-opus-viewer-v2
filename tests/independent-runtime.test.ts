import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const server = fs.readFileSync(path.resolve("src/server/server.ts"), "utf8");
const worker = fs.readFileSync(path.resolve("src/server/worker.ts"), "utf8");
const config = fs.readFileSync(path.resolve("src/server/config.ts"), "utf8");

test("V2 后台在 V1 权威模式下复用 V1 账号规则并保持可切换", () => {
  const runtime = `${server}\n${worker}\n${config}`;
  assert.match(config, /V2_ACCOUNT_AUTHORITY \|\| "v1"/);
  assert.match(server, /commandWriterLabel\(\).*"v1-via-v2"/s);
  assert.match(server, /v1CompatCommand\("rebind"/);
  assert.match(server, /proxyV1AndSync\("\/api\/admin\/mappings\/recycle"/);
  assert.match(worker, /refreshV1Projection/);
  assert.match(worker, /syncFromV1\(\)/);
});

test("共享邮件同步默认关闭并由 Worker 显式检查配额开关", () => {
  assert.match(config, /V2_SHARED_MAIL_SYNC_ENABLED \|\| "false"/);
  assert.match(config, /V2_SHARED_MAIL_SYNC_INTERVAL_MS \|\| 10 \* 60_000/);
  assert.match(worker, /if \(config\.sharedMailSyncEnabled && now - lastSharedMailSyncAt >= config\.sharedMailSyncIntervalMs\)/);
  assert.match(worker, /disabled_to_preserve_upstream_quota/);
  assert.match(config, /V2_OUTLOOK_MAIL_SYNC_ENABLED \|\| "false"/);
  assert.match(worker, /if \(config\.outlookMailSyncEnabled && now - lastOutlookSyncAt >= config\.outlookSyncIntervalMs\)/);
  assert.match(worker, /disabled_to_preserve_mail_capacity/);
});
