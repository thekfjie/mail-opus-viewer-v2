import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  adminLoadStatusText,
  adminLoadTiming,
  beginAdminLoad,
  completeAdminLoad,
  failAdminLoad,
  markAdminListReady,
} from "../web/src/load-state";

test("长后台任务不再把 501 秒算成账号列表加载耗时", () => {
  const startedAt = 1_000;
  const listReadyAt = 1_420;
  const now = listReadyAt + 501_000;
  const state = markAdminListReady(beginAdminLoad(1, startedAt, false, "initial"), listReadyAt);
  const timing = adminLoadTiming(state, now);
  const status = adminLoadStatusText(state, now);

  assert.equal(timing.foregroundMs, 420);
  assert.equal(timing.backgroundMs, 501_000);
  assert.equal(status?.title, "账号列表已可操作，后台数据继续同步");
  assert.match(status?.detail || "", /首屏 420 毫秒/);
  assert.match(status?.detail || "", /后台 8 分 21 秒/);
  assert.doesNotMatch(status?.detail || "", /首屏.*501/);
});

test("账号列表可操作后，首屏计时冻结而后台计时继续", () => {
  const ready = markAdminListReady(beginAdminLoad(2, 10_000, false, "navigation"), 10_750);
  assert.deepEqual(adminLoadTiming(ready, 15_750), {
    foregroundMs: 750,
    backgroundMs: 5_000,
    totalMs: 5_750,
    active: true,
  });

  const complete = completeAdminLoad(ready, 16_000);
  assert.deepEqual(adminLoadTiming(complete, 999_999), {
    foregroundMs: 750,
    backgroundMs: 5_250,
    totalMs: 6_000,
    active: false,
  });
});

test("重新进入页面与新请求都生成独立开始时间", () => {
  const oldRequest = completeAdminLoad(markAdminListReady(beginAdminLoad(7, 1_000, false, "initial"), 1_500), 2_000);
  const restored = beginAdminLoad(8, 900_000, true, "restore");

  assert.equal(oldRequest.startedAt, 1_000);
  assert.equal(restored.startedAt, 900_000);
  assert.equal(restored.listReadyAt, 900_000);
  assert.equal(adminLoadTiming(restored, 900_250).foregroundMs, 0);
  assert.equal(adminLoadTiming(restored, 900_250).backgroundMs, 250);
});

test("失败会停止计时，已有列表时保留可操作状态语义", () => {
  const ready = markAdminListReady(beginAdminLoad(9, 2_000, false, "initial"), 2_300);
  const failed = failAdminLoad(ready, 7_300, "network disconnected");
  const status = adminLoadStatusText(failed, 500_000);

  assert.equal(adminLoadTiming(failed, 500_000).totalMs, 5_300);
  assert.equal(adminLoadTiming(failed, 500_000).active, false);
  assert.equal(status?.title, "账号列表可操作，后台同步失败");
});

test("组件生命周期会终止旧请求、恢复页重新加载并仅在活动阶段启动时钟", () => {
  const source = fs.readFileSync(path.resolve("web/src/main.tsx"), "utf8");
  assert.match(source, /loadRequest\.current\.controller\?\.abort\(\)/);
  assert.match(source, /window\.addEventListener\("pagehide", onPageHide\)/);
  assert.match(source, /window\.addEventListener\("pageshow", onPageShow\)/);
  assert.match(source, /event\.persisted && authenticated/);
  assert.match(source, /window\.addEventListener\("online", onOnline\)/);
  assert.match(source, /loadState\.phase !== "initial" && loadState\.phase !== "usable-background"/);
  assert.match(source, /return \(\) => window\.clearInterval\(timer\)/);
  assert.match(source, /controller\?\.abort\(\)/);
  assert.match(source, /状态连接中断，\$\{Math\.ceil\(delay \/ 1000\)\} 秒后自动重连/);
  assert.match(source, /window\.addEventListener\("online", reconnect\)/);
  assert.match(source, /window\.removeEventListener\("online", reconnect\)/);
});
