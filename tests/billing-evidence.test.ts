import assert from "node:assert/strict";
import test from "node:test";
import { deriveBillingMailEvidence } from "../src/server/billing-evidence.js";
import { classifyMail } from "../src/server/mail-classification.js";

test("真实订阅回执即使首月免费和零元也确认 Plus", () => {
  const result = deriveBillingMailEvidence("ChatGPT - Your new plan", [
    "You've successfully subscribed to ChatGPT Plus.",
    "Enjoy your first month free.",
    "Order number: sub_test",
    "ChatGPT Plus Subscription ₫475000",
    "Discount: -₫475000 Total: ₫0 Payment method",
  ].join("\n"));
  assert.deepEqual(result, { confirmedPlus: true, billingChannel: "vn-momo" });
});

test("越南语真实新套餐回执在首月免费时仍确认 Plus", () => {
  const subject = "ChatGPT - Kế hoạch mới của bạn";
  const body = [
    "Bạn đã đăng ký thành công ChatGPT Plus.",
    "ChatGPT Plus Subscription ₫475000",
    "Giảm giá: -₫475000",
    "Tổng: ₫0",
    "Phương thức thanh toán: unknown",
    "Tháng đầu tiên miễn phí.",
  ].join("\n");
  assert.equal(classifyMail(subject, "OpenAI <noreply@openai.com>").category, "billing");
  assert.deepEqual(deriveBillingMailEvidence(subject, body), { confirmedPlus: true, billingChannel: "vn-momo" });
});

test("越南语支付方式字段换行时仍识别 MoMo", () => {
  const body = [
    "Bạn đã đăng ký thành công ChatGPT Plus.",
    "Order number: sub_wrapped",
    "ChatGPT Plus Subscription ₫475000",
    "Giảm giá: -₫475000        Tổng: ₫0",
    "Phương thức",
    "thanh toán: unknown",
  ].join("\n");
  assert.deepEqual(deriveBillingMailEvidence("ChatGPT - Kế hoạch mới của bạn", body),
    { confirmedPlus: true, billingChannel: "vn-momo" });
});

test("只有免费试用营销文案不能变成 Plus 账单证据", () => {
  assert.deepEqual(
    deriveBillingMailEvidence("Try ChatGPT Plus free for one month", "Start your free trial today."),
    { confirmedPlus: false, billingChannel: "" },
  );
});

test("HTML 中带订单号的零元 MoMo 回执仍确认 Plus", () => {
  assert.deepEqual(deriveBillingMailEvidence("ChatGPT - Your new plan", "", [
    "<p>You've successfully subscribed to ChatGPT Plus.</p>",
    "<p>Order number: sub_html</p>",
    "<p>Payment method: MoMo</p>",
    "<p>Total: &#x20ab;0</p>",
  ].join("")), { confirmedPlus: true, billingChannel: "vn-momo" });
});

test("仅凭回执 HTML 结构也能跨语言确认 Plus", () => {
  const html = [
    '<section class="order_summary"><table><tr><td>ITEM_A</td></tr></table></section>',
    '<div class="payment_method_content"><span class="payment_method_item">VALUE_A</span></div>',
  ].join("");
  assert.deepEqual(deriveBillingMailEvidence("SUBJECT_A", "", html, "noreply@openai.com"),
    { confirmedPlus: true, billingChannel: "" });
  assert.deepEqual(deriveBillingMailEvidence("SUBJECT_A", "", html, "sender@example.com"),
    { confirmedPlus: false, billingChannel: "" });
  assert.deepEqual(deriveBillingMailEvidence("ChatGPT - Your new plan",
    "You've successfully subscribed to ChatGPT Plus. Order number: sub_fake.", "", "sender@example.com"),
  { confirmedPlus: false, billingChannel: "" });
});

test("V1 成熟渠道优先级完整迁移到 V2", () => {
  const receipt = (method: string, amount: string) => deriveBillingMailEvidence("ChatGPT - Your new plan", [
    "You've successfully subscribed to ChatGPT Plus.",
    "Order number: sub_channel_test",
    `Payment method: ${method}`,
    `Total: ${amount}`,
  ].join("\n"));
  const cases: Array<[string, string, string]> = [
    ["PayPal", "USD $20.00", "us-paypal"],
    ["iDEAL", "EUR €22.00", "eu-ideal"],
    ["PayPal", "GBP £20.00", "uk-paypal"],
    ["PayPal", "EUR €19.33", "de-paypal"],
    ["Visa 4242", "PHP ₱1,100", "ph-card"],
    ["GCash", "PHP ₱1,100", "ph-gcash"],
    ["GoPay", "IDR Rp 349.000", "id-gopay"],
    ["PayPal", "BRL R$ 99,90", "br-paypal"],
    ["PIX", "BRL R$ 99,90", "br-pix"],
    ["UPI", "INR ₹1,999", "in-upi"],
    ["MoMo", "VND ₫475000", "vn-momo"],
    ["unknown", "VND ₫475000", "vn-momo"],
    ["TWINT", "CHF 20.00", "ch-twint"],
    ["Kakao Pay", "KRW ₩29,000", "kr-kakao"],
    ["Naver Pay", "KRW ₩29,000", "kr-naver"],
    ["PayPal", "THB ฿699", "th-paypal"],
    ["BLIK", "PLN 99.00 zł", "pl-blik"],
  ];
  for (const [method, amount, channel] of cases) {
    assert.equal(receipt(method, amount).billingChannel, channel, `${method} ${amount}`);
  }
});

test("渠道优先级避免把 PayPal、银行卡或 GrabPay 错判为地区钱包", () => {
  const evidence = (body: string) => deriveBillingMailEvidence("ChatGPT - Your new plan",
    `You've successfully subscribed to ChatGPT Plus. Order number: sub_guard. ${body}`);
  assert.equal(evidence("Payment method: PayPal Total: KRW ₩29,000").billingChannel, "uk-paypal");
  assert.equal(evidence("Payment method: Visa Total: CHF 20.00").billingChannel, "");
  assert.equal(evidence("Payment method: GrabPay Total: PHP ₱1,100").billingChannel, "");
  assert.equal(evidence("Payment method: unknown Total: PHP ₱1,100").billingChannel, "");
  assert.equal(evidence("Payment method: unknown Total: KRW ₩29,000").billingChannel, "");
  assert.equal(evidence("Payment method: unknown Total: EUR €22.00").billingChannel, "");
  assert.equal(evidence("Payment method: PayPal Total: VND ₫475000").billingChannel, "uk-paypal");
});
