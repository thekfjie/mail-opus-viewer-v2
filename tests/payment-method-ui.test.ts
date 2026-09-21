import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("支付方式列表隐藏内部来源链并限制为紧凑三行", () => {
  const main = fs.readFileSync(path.resolve("web/src/main.tsx"), "utf8");
  const styles = fs.readFileSync(path.resolve("web/src/styles.css"), "utf8");
  assert.match(main, /paymentMethodSingleSource/);
  assert.match(main, /promoRank = \(mode: PaymentExposurePromoMode/);
  assert.match(main, /method-chip-source/);
  assert.doesNotMatch(main, /item\.sources\.join\(" → "\)/);
  assert.match(main, /\.slice\(0, 6\)/);
  assert.doesNotMatch(main, />Method<\/strong>/);
  assert.match(main, /PaymentMethodChips compact items=\{paymentExposureMethodItems\(item\)\}/);
  assert.match(styles, /\.method-chip-list \{[^}]*max-height: 39px/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*?\.method-chip-list[^}]*max-height: 39px/);
  assert.doesNotMatch(styles, /\.method-chip-list[^}]*flex-direction: column/);
  assert.match(styles, /\.method-chip \{[^}]*padding: 0 4px/);
  assert.match(styles, /\.method-chip-source/);
  assert.match(styles, /\.method-chip code \{[^}]*text-overflow: ellipsis/);
  assert.match(main, /new Set\(\["oaics", "cs"\]\)/);
  assert.match(main, /\["oaics", "cs"\]\.find\(\(source\) => normalized\.includes\(source\)/);
  assert.match(main, /case "stripe_live": return "cs"/);
  assert.match(main, /case "oaics_custom": return "oaics"/);
  assert.match(main, /paymentMethodColorClass/);
  assert.match(styles, /\.method-chip\.method-momo/);
  assert.match(styles, /--method-channel-color: #be185d/);
  assert.match(styles, /\.method-chip\.promo-one-month[^}]*#2563eb/);
  assert.match(styles, /\.method-chip\.promo-none[^}]*#7c3aed/);
  assert.match(main, /选择支付方式探查优惠模式/);
  assert.match(main, /promoMode: paymentPromoMode/);
  assert.match(styles, /\.method-chip-source[^}]*10px\/13px/);
  assert.match(styles, /\.method-chip code[^}]*11px\/13px/);
  assert.match(main, /PAYMENT_EXPOSURE_BATCH_SESSION_KEY/);
  assert.match(main, /paymentExposureBatchResume/);
});

test("批量 Method 前端只轮询一个本地批次状态入口", () => {
  const main = fs.readFileSync(path.resolve("web/src/main.tsx"), "utf8");
  assert.match(main, /accounts\/payment-exposure-check\/status/);
  assert.doesNotMatch(main, /Promise\.all\(jobAccounts\.map/);
  assert.match(main, /已创建 \$\{result\.requestedJobs\} 个远程批次任务/);
});
