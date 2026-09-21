import assert from "node:assert/strict";
import test from "node:test";
import { billingStartedAtFromMails, computeAliveInfo } from "../src/server/repository.js";

test("存活时长从账单起点计算到当前时间", () => {
  const result = computeAliveInfo("2026-09-01T00:00:00.000Z", "", Date.parse("2026-09-02T01:02:00.000Z"));
  assert.equal(result.aliveLabel, "账单起已活 1天1小时");
  assert.equal(result.aliveActive, true);
});

test("存活时长在停用后固定到停用时间", () => {
  const result = computeAliveInfo("2026-09-01T00:00:00.000Z", "2026-09-01T12:34:00.000Z", Date.parse("2026-09-12T00:00:00.000Z"));
  assert.equal(result.aliveLabel, "账单起存活 12小时34分（已停用）");
  assert.equal(result.aliveActive, false);
});

test("明确换绑链上的套餐邮件可确定账单起点", () => {
  const mails = [
    { subject: "Your temporary ChatGPT login code", received_at: "2026-08-25T21:58:18.000Z" },
    { subject: "ChatGPT - 新しいプラン", received_at: "2026-09-02T05:12:34.000Z" },
  ];
  assert.equal(billingStartedAtFromMails(mails, "plus", "vn-momo"), "2026-09-02T05:12:34.000Z");
  assert.equal(billingStartedAtFromMails(mails, "free", ""), "");
});

test("Plus 已确认但渠道尚未回写时仍保留套餐邮件账单起点", () => {
  const mails = [{ subject: "ChatGPT - Your new plan", received_at: "2026-09-11T12:48:55.000Z" }];
  assert.equal(billingStartedAtFromMails(mails, "plus", ""), "2026-09-11T12:48:55.000Z");
});
