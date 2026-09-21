import assert from "node:assert/strict";
import test from "node:test";
import { accountRowStatusClass, lifecycleLabel, lifecycleTone, promotionCheckUnavailableReason } from "../web/src/account-status.js";
import type { AccountSummary } from "../src/shared/types.js";

const active = { lifecycleStatus: "active", identityStatus: "matched", deactivationLocked: false, plan: "free" } as const;

test("账号行恢复 Plus 绿色，邮箱供应商、渠道和人工标记不改变状态语义", () => {
  for (const provider of ["icloud", "outlook", "domain", "external"]) {
    for (const billingChannel of ["", "us-paypal", "id-gopay", "future-channel"]) {
      const item = { ...active, plan: "PLUS", provider, billingChannel, markColor: "red" };
      assert.equal(accountRowStatusClass(item), "plus-account");
      assert.equal(lifecycleTone(item), "green");
      assert.equal(lifecycleLabel(item), "活跃");
      assert.equal(item.markColor, "red");
      assert.equal(accountRowStatusClass({ ...item, plan: "free" }), "");
      assert.equal(accountRowStatusClass({ ...item, plan: "unknown" }), "");
    }
  }
});

test("所有封禁账号都显示红色，停用锁优先于 Plus、回收或待核对状态", () => {
  for (const plan of ["plus", "free", "team", "unknown", ""]) {
    for (const lifecycleStatus of ["active", "deactivated", "quarantined", "retired"] as const) {
      const item = { ...active, plan, lifecycleStatus, deactivationLocked: true, markColor: "green" };
      assert.equal(accountRowStatusClass(item), "deactivated");
      assert.equal(lifecycleTone(item), "red");
      assert.equal(lifecycleLabel(item), "永久停用");
      assert.equal(item.markColor, "green");
    }
    const statusOnly = { ...active, plan, lifecycleStatus: "deactivated" as const };
    assert.equal(accountRowStatusClass(statusOnly), "deactivated");
    assert.equal(lifecycleTone(statusOnly), "red");
    assert.equal(lifecycleLabel(statusOnly), "永久停用");
  }
});

test("待核对保留黄色、历史回收保留灰色，Plus 套餐不会冒充活跃状态", () => {
  for (const [lifecycleStatus, tone, label] of [
    ["quarantined", "yellow", "归属待核对"], ["retired", "gray", "历史回收"], ["deleted", "gray", "已删除"],
  ] as const) {
    const item = { ...active, plan: "plus", lifecycleStatus };
    assert.equal(accountRowStatusClass(item), "");
    assert.equal(lifecycleTone(item), tone);
    assert.equal(lifecycleLabel(item), label);
  }
  const conflict = { ...active, lifecycleStatus: "quarantined", identityStatus: "conflict" } satisfies Partial<AccountSummary>;
  assert.equal(lifecycleLabel(conflict), "凭证归属冲突");
});

test("第三方待恢复显示为独立黄色状态", () => {
  const item = { ...active, lifecycleStatus: "third_party_pending_recovery", plan: "plus" } as const;
  assert.equal(lifecycleLabel(item), "第三方待恢复");
  assert.equal(lifecycleTone(item), "yellow");
  assert.equal(accountRowStatusClass(item), "");
});

test("第三方注册保留类别标签，但与活跃账号同为绿色并应用 Plus 行样式", () => {
  const item = { ...active, lifecycleStatus: "third_party_registered", plan: "plus" } as const;
  assert.equal(lifecycleLabel(item), "第三方注册");
  assert.equal(lifecycleTone(item), "green");
  assert.equal(accountRowStatusClass(item), "plus-account");
});

test("活跃和第三方注册允许优惠检测，真实停用与待恢复仍被拦截", () => {
  assert.equal(promotionCheckUnavailableReason({ ...active, lifecycleStatus: "active" }), "");
  assert.equal(promotionCheckUnavailableReason({ ...active, lifecycleStatus: "third_party_registered" }), "");
  assert.equal(promotionCheckUnavailableReason({ ...active, lifecycleStatus: "third_party_pending_recovery" }), "账号已停用，无需检测优惠");
  assert.equal(promotionCheckUnavailableReason({ ...active, lifecycleStatus: "deactivated" }), "账号已停用，无需检测优惠");
  assert.equal(promotionCheckUnavailableReason({ ...active, lifecycleStatus: "third_party_registered", deactivationLocked: true }), "账号已停用，无需检测优惠");
  assert.equal(promotionCheckUnavailableReason({ ...active, lifecycleStatus: "third_party_registered", plan: "plus" }), "Plus 已开通，无需检测优惠");
});
