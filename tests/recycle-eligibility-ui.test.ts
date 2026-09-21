import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecycleEligibilityPanel, recycleConfirmationMessage, recycleModeLabels } from "../web/src/recycle-eligibility.js";
import type { RecycleEligibility } from "../src/shared/types.js";

const eligibility: RecycleEligibility = { accountId: "offline-account", generation: 0, maxGeneration: 2, waitMs: 604800000,
  checkedAt: "2026-09-09T00:00:00.000Z", account: { lifecycleStatus: "deactivated", deactivationLocked: true,
    deactivatedAt: "2026-09-02T01:00:00.000Z", retired: false, deleted: false, sold: true, customerOpened: false },
  evidence: { tokenPlan: "free", hasAccessToken: true, invalidAT: false, mailVerifiedNoPlus: false, hasPlusEvidence: false,
    isAuto: false, sharedMailbox: true, specialMarkerCount: 1, reusableNoATAutoICloud: false },
  modes: { deactivated: { eligible: false, reason: "账号停用未满 7 天", eligibleAt: "2026-09-09T01:00:00.000Z", trigger: "admin_only" },
    untagged_free: { eligible: false, reason: "已停用账号应使用停用账号回收", eligibleAt: "", trigger: "admin_only" },
    invalid_at: { eligible: false, reason: "当前 AT 尚未明确判定为失效", eligibleAt: "", trigger: "admin_only" },
    alias_rotate: { eligible: false, reason: "仅自动注册池账号支持后缀轮换", eligibleAt: "", trigger: "admin_only" } } };

function render(data: RecycleEligibility | null, overrides: Record<string, unknown> = {}) {
  let actions = 0;
  const html = renderToStaticMarkup(React.createElement(RecycleEligibilityPanel, { data, loading: false, busy: false,
    readOnly: false, error: "", formatTime: (value: string) => value, onRefresh: () => { actions++; }, onExecute: () => { actions++; }, ...overrides }));
  assert.equal(actions, 0, "rendering eligibility is not an action");
  return html;
}

function modeHtml(html: string, mode: string): string {
  return html.match(new RegExp(`<article[^>]+data-recycle-mode="${mode}"[\\s\\S]*?</article>`))![0];
}

test("回收卡片显示具体保护原因、北京时间门槛和人工操作警告", () => {
  const html = render(eligibility);
  assert.match(html, /已售未使用/);
  assert.match(html, /账号停用未满 7 天/);
  assert.match(html, /2026-09-09T01:00:00.000Z/);
  assert.match(html, /北京时间/);
  assert.match(html, /仅管理员确认后执行，达到条件不会自动回收；回收将撤销原客户链接和会话/);
  for (const mode of Object.keys(recycleModeLabels)) assert.match(modeHtml(html, mode), /<button[^>]*disabled=""/);
});

test("只有后端确认 eligible 才开放对应按钮；刷新、错误、执行中和只读仍禁用", () => {
  const eligible = structuredClone(eligibility);
  eligible.modes.deactivated = { ...eligible.modes.deactivated, eligible: true, reason: "" };
  assert.doesNotMatch(modeHtml(render(eligible), "deactivated"), /<button[^>]*disabled=""/);
  for (const props of [{ loading: true }, { busy: true }, { readOnly: true }, { error: "资格读取失败" }]) {
    assert.match(modeHtml(render(eligible, props), "deactivated"), /<button[^>]*disabled=""/);
  }
  assert.match(modeHtml(render(null), "deactivated"), /<button[^>]*disabled=""/);
  assert.match(modeHtml(render(eligible), "untagged_free"), /<button[^>]*disabled=""/);
});

test("所有模式的确认提示包含具体账号和客户链接、会话撤销后果", () => {
  for (const mode of Object.keys(recycleModeLabels) as Array<keyof typeof recycleModeLabels>) {
    const text = recycleConfirmationMessage(mode, "offline@example.test");
    assert.ok(text.includes("offline@example.test"));
    assert.ok(text.includes(recycleModeLabels[mode]));
    assert.ok(text.includes("回收将撤销原客户链接和会话"));
    assert.ok(text.includes("达到条件不会自动回收"));
  }
});
