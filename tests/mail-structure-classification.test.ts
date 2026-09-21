import assert from "node:assert/strict";
import test from "node:test";
import { classifyMail } from "../src/server/mail-classification.js";

const sender = "noreply@openai.com";

test("未知语言仍可按可信邮件 HTML 结构识别安全、换绑、封禁、政策、推广和账单", () => {
  const cases: Array<[string, string]> = [
    ['<div data-testid="verification_code"><span>123456</span></div>', "security"],
    ['<section class="email_change"><p>old@example.com -> new@example.com</p></section>', "rebind"],
    ['<main class="access_deactivated"><h1>ATTRIBUTE_A</h1></main>', "deactivation"],
    ['<article data-testid="policy_violation_warning"><h1>ATTRIBUTE_B</h1></article>', "policy"],
    ['<article class="marketing_campaign"><h1>ATTRIBUTE_C</h1></article>', "promotion"],
    ['<section id="subscription_notice"><div class="payment_method_block">FIELD_A</div></section>', "billing"],
  ];
  for (const [html, category] of cases) {
    assert.equal(classifyMail("SUBJECT_A", sender, "", html).category, category);
  }
});

test("结构识别不会把普通内容中的 plan 当成账单", () => {
  assert.equal(classifyMail("Plan around the weather", sender).category, "general");
  assert.equal(classifyMail("Final reminder: Your Plus access ends soon", sender).category, "billing");
  assert.equal(classifyMail("Your Plus access will end soon", sender).category, "billing");
});

test("非可信发件人即使伪造结构也不升级为特殊邮件类别", () => {
  const html = '<section class="access_deactivated payment_method subscription_notice"><span>123456</span></section>';
  assert.equal(classifyMail("SUBJECT_A", "attacker@example.com", "", html).category, "general");
});
