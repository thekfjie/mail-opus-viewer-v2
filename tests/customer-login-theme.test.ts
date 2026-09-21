import assert from "node:assert/strict";
import test from "node:test";
import { customerHtml } from "../src/server/customer-assets.js";
import { customerLoginCss, customerLoginPage, customerLoginScript } from "../src/server/customer-login-theme.js";

test("customer login provides responsive light, dark and automatic themes", () => {
  const page = customerLoginPage(customerHtml);
  assert.match(page, /<title>Opusmail v2<\/title>/);
  assert.match(page, /customer-login\.css/);
  assert.match(customerLoginScript, /data-theme-choice="light"/);
  assert.match(customerLoginScript, /data-theme-choice="auto"/);
  assert.match(customerLoginScript, /data-theme-choice="dark"/);
  assert.match(customerLoginScript, /prefers-color-scheme: dark/);
  assert.match(customerLoginScript, /localStorage\.setItem\(key,preference\)/);
  assert.match(customerLoginScript, /id="passwordToggle"/);
  assert.match(customerLoginScript, /保持登录状态/);
  assert.match(customerLoginScript, /忘记密码/);
  assert.match(customerLoginCss, /:root\[data-theme="dark"\]/);
  assert.match(customerLoginCss, /@media\(max-width:720px\)/);
  assert.match(customerLoginCss, /opus-brand-mark/);
});

test("customer login geometry follows the supplied desktop and mobile composition", () => {
  assert.match(customerLoginCss, /padding:clamp\(112px,14\.8vh,148px\) 24px 64px/);
  assert.match(customerLoginCss, /width:204px;height:52px/);
  assert.match(customerLoginCss, /grid-template-columns:48px 82px 48px/);
  assert.match(customerLoginCss, /width:min\(480px,100%\)/);
  assert.match(customerLoginCss, /min-height:496px/);
  assert.match(customerLoginCss, /\.login-brand\{justify-content:center;margin:0 auto 40px\}/);
  assert.match(customerLoginCss, /scene-wave/);
  assert.match(customerLoginCss, /scene-card/);
  assert.match(customerLoginCss, /scene-plane/);
  assert.match(customerLoginCss, /@media\(max-width:720px\)\{\.login\{align-items:center;padding:98px 18px 42px/);
  assert.doesNotMatch(customerLoginCss, /@media\(max-width:[^)]+\)[^{]*\{\.login\{align-items:flex-start/);

  const brandPosition = customerLoginScript.indexOf("'+brand()+'<section class=\"login-card\"");
  assert.ok(brandPosition >= 0, "brand must stay outside and immediately above the login card");
  assert.match(customerLoginScript, /class=\"theme-switch\"/);
  assert.match(customerLoginScript, /function scene\(\)/);
  assert.match(customerLoginScript, /linearGradient id=\"mailBody\"/);
});
