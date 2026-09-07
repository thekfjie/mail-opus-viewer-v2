import assert from "node:assert/strict";
import test from "node:test";
import {
  isPlanOrderSubject,
  isStrictPlusEvidenceSubject,
  isTrialOrZeroChargeSubject,
} from "../src/server/plus-evidence.js";

test("V2 只把严格激活、续费或付款主题作为 Plus 证据", () => {
  assert.equal(isStrictPlusEvidenceSubject("Welcome to ChatGPT Plus"), true);
  assert.equal(isStrictPlusEvidenceSubject("ChatGPT Plus subscription renewed"), true);
  assert.equal(isStrictPlusEvidenceSubject("OpenAI payment confirmation - ChatGPT Plus"), true);
  assert.equal(isStrictPlusEvidenceSubject("ChatGPT - Your new plan"), false);
  assert.equal(isStrictPlusEvidenceSubject("ChatGPT - 新しいプラン"), false);
  assert.equal(isStrictPlusEvidenceSubject("Try ChatGPT Plus free for one month"), false);
});

test("V2 单独识别新套餐候选与免费/零元主题", () => {
  assert.equal(isPlanOrderSubject("ChatGPT - 你的新套餐"), true);
  assert.equal(isTrialOrZeroChargeSubject("ChatGPT Plus 初月無料"), true);
  assert.equal(isTrialOrZeroChargeSubject("ChatGPT Plus receipt - 0.00 USD"), true);
});
