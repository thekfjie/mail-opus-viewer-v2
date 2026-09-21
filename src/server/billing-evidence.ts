import { isStrictPlusEvidenceSubject } from "./plus-evidence.js";

export interface BillingMailEvidence {
  confirmedPlus: boolean;
  billingChannel: string;
}

const TRIAL_PATTERNS = [
  /\b(?:free|complimentary)\s+(?:month|trial|trial period)\b/i,
  /\b(?:first|initial)\s+month.{0,40}\bfree\b/i,
  /(?:免费|免費|無料)(?:试用|試用|体验|體驗|体験|トライアル)?/i,
  /(?:首月|首个一月|最初の一か月|初月).{0,20}(?:免费|免費|無料)/i,
  /(?:tháng\s+đầu(?:\s+tiên)?).{0,24}(?:miễn\s+phí|free)/i,
  /(?:total|amount\s+(?:due|charged)|charged\s+today|合计|合計|總計|tổng(?:\s+cộng)?)\s*[:：]?\s*(?:(?:USD|EUR|GBP|JPY|CNY|PHP|IDR|THB|KRW|VND|INR|BRL|PLN|CHF)\s*)?(?:[$€£¥₹₫₩₱]|Rp\.?|R\$|zł)?\s*0(?:[.,]0{1,2})?(?:\D|$)/i,
  /(?:^|\D)(?:0|0\.00)\s*(?:USD|EUR|GBP|JPY|CNY|PHP|IDR|THB|KRW|VND|INR|BRL|PLN|CHF|元|円|美元|欧元)(?:\D|$)/i,
];

const ACTIVE_PATTERNS = [
  /\bWelcome\s+to\s+ChatGPT\s+Plus\b/i,
  /\bChatGPT\s+Plus\s+(?:subscription|plan|membership).{0,36}(?:active|activated|confirmed|enabled|started|renewed|paid)\b/i,
  /\b(?:successfully\s+subscribed|subscribed\s+to|paid\s+for)\s+ChatGPT\s+Plus\b/i,
  /ChatGPT\s*Plus.{0,60}(?:正常に登録されました|已成功(?:订阅|訂閱)|订阅成功|訂閱成功)/i,
  /(?:套餐|方案|计划|計劃|プラン).{0,48}(?:已开通|已啟用|已启用|有効|active|activated|renewed|成功)/i,
];

function normalizedContent(subject: string, text: string, html: string): string {
  return `${subject || ""}\n${text || ""}\n${html || ""}`
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&euro;|&#8364;/gi, "€")
    .replace(/&pound;|&#163;/gi, "£")
    .replace(/&dollar;|&#36;/gi, "$")
    .replace(/&#8377;|&rupee;/gi, "₹")
    .replace(/&#8363;|&#x20ab;/gi, "₫")
    .replace(/&#8361;|&#x20a9;/gi, "₩")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function confirmedSubscriptionReceipt(content: string): boolean {
  const subscribed = /(?:successfully\s+subscribed|successfully\s+registered|正常に登録されました|成功(?:订阅|订購|訂閱)|已成功(?:订阅|訂閱|订购|訂購)|(?:đã\s+)?đăng\s+ký\s+thành\s+công(?:\s+(?:gói\s+)?)?ChatGPT\s*Plus|(?:đã\s+)?đăng\s+ký\s+(?:gói\s+)?ChatGPT\s*Plus\s+thành\s+công)/i.test(content);
  const transaction = /(?:order\s+(?:number|no\.?|id)|订单号|訂單號|注文番号|payment\s+method|付款方式|支付方式|決済方法|subscription|订阅|訂閱|phương\s+thức\s+thanh\s+toán|đăng\s+ký)/i.test(content);
  return subscribed && transaction && /(?:ChatGPT\s*Plus|Plus)/i.test(content);
}

function hasSubscriptionReceiptStructure(html: string): boolean {
  const source = String(html || "");
  if (!source) return false;
  return /\bclass=["'][^"']*\border_summary\b/i.test(source)
    && /\bclass=["'][^"']*\bpayment_method_content\b/i.test(source)
    && /\bclass=["'][^"']*\bpayment_method_item\b/i.test(source);
}

function trustedBillingSender(sender: string): boolean {
  const value = String(sender || "").trim().toLowerCase();
  return /@(?:[a-z0-9-]+\.)*openai\.com$/.test(value)
    || /^[a-z]+_at_(?:tm|email)[a-z0-9]*_openai_com_[a-z0-9]+_[a-z0-9]+@icloud\.com$/.test(value);
}

function paymentMethod(content: string): string {
  const labels = "Payment method|Payment option|付款方式|支付方式|決済方法|支払い方法|결제\\s*수단|Phương thức\\s+thanh toán|Metode pembayaran|Método de pagamento|Método de pago";
  const labelled = [...content.matchAll(new RegExp(`(?:${labels})\\s*[:：]\\s*([A-Za-z\\u00c0-\\u024f\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af][A-Za-z0-9+./ \\u00c0-\\u024f\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af-]{0,40})`, "gi"))]
    .map((match) => String(match[1] || "").trim()).filter(Boolean);
  return (labelled[0] || "").toLowerCase();
}

function channelFromContent(content: string): string {
  const method = paymentMethod(content);
  const unspecified = !method || /^unknown\b/i.test(method);
  const paypal = /paypal/i.test(method) || (/\bPayPal\b/i.test(content) && /(?:payment method|付款方式|支付方式)/i.test(content));
  const sepaInMethod = /\bsepa\b/i.test(method);
  const idealInMethod = /\bideal\b/i.test(method);
  const sepaInBody = /\bSEPA\b/.test(content);
  const idealInBody = /\biDEAL\b/i.test(content);
  const php = /(?:₱|\bPHP\b|=E2=82=B1|&#8369;|&#x20b1;)/i.test(content);
  const idr = /(?:\bIDR\b|\bRp\.?\s*[\d.,]+)/i.test(content);
  const vnd = /(?:\bVND\b|₫)/i.test(content);
  const pln = /(?:\bPLN\b|\bzł\s*[\d.,]*|\bzl\s*[\d.,]*)/i.test(content);
  const gcash = /\bg\s*-?\s*cash\b/i.test(method) || /\bg\s*-?\s*cash\b/i.test(content);
  const grabPay = /\bgrab\s*-?\s*pay\b/i.test(method) || /\bgrab\s*-?\s*pay\b/i.test(content);
  const gopay = /\bgo\s*-?\s*pay\b/i.test(method) || /\bgo\s*-?\s*pay\b/i.test(content);
  const blik = /\bblik\b/i.test(method) || /\bblik\b/i.test(content);
  const naver = /\bnaver(?:\s*pay)?\b/i.test(method) || /\bNaver\s*Pay\b|\b네이버(?:페이)?\b/i.test(content);
  const cardInMethod = /\b(?:visa|mastercard|master\s*card|amex|american\s*express|jcb|card|银行卡|信用卡|借记卡|debit|credit)\b/i.test(method)
    || (/(?:Visa|Mastercard|Master\s*Card|Amex|American\s*Express|JCB)(?:\s*[-–—]?\s*\d{2,4})?/i.test(content)
      && /(?:Payment method|付款方式|支付方式)/i.test(content));

  if (gcash && php && !paypal) return "ph-gcash";
  if (gopay && idr && !paypal) return "id-gopay";
  if (blik && pln && !paypal) return "pl-blik";
  if (php && !paypal && (cardInMethod || (unspecified && /\b(?:visa|mastercard|amex|jcb)\b/i.test(content)))) return "ph-card";
  if (!paypal && naver) return "kr-naver";
  if (!paypal && (/\bkakao(?:\s*pay)?\b/i.test(method) || /\bKakao\s*Pay\b|\b카카오(?:페이)?\b/i.test(content))) return "kr-kakao";
  if (/\btwint\b/i.test(method) || /\bTWINT\b/i.test(content)) return "ch-twint";
  // Preserve the established V1 rule: OpenAI's Vietnam receipts often leave
  // the payment method as "unknown", while VND/₫ still identifies MoMo.
  if (/\bmomo\b/i.test(method) || /\bMoMo\b/i.test(content)
    || (unspecified && vnd && !paypal)) return "vn-momo";
  if (/\bupi\b/i.test(method) || /\bUPI\b/i.test(content)) return "in-upi";
  if (/\bpix\b/i.test(method) || /\bPIX\b/i.test(content)) return paypal ? "br-paypal" : "br-pix";
  if (sepaInMethod || idealInMethod || sepaInBody || idealInBody) return "eu-ideal";
  if (paypal) {
    if (/\bBRL\b|R\$\s?\d/i.test(content)) return "br-paypal";
    if (/(?:€\s*19[.,]33|19[.,]33\s*€|\bEUR\s*19[.,]33|19[.,]33\s*EUR\b)/i.test(content)) return "de-paypal";
    if (/\bTHB\b|฿\s?\d/i.test(content)) return "th-paypal";
    if (/\bGBP\b|£|\bEUR\b|€/.test(content)) return "uk-paypal";
    if (/\bUSD\b|(?<![A-Za-z])\$\s?\d/.test(content)) return "us-paypal";
    return "uk-paypal";
  }
  return "";
}

export function deriveBillingMailEvidence(subject: string, text = "", html = "", sender = ""): BillingMailEvidence {
  if (sender && !trustedBillingSender(sender)) return { confirmedPlus: false, billingChannel: "" };
  const content = normalizedContent(subject, text, html);
  const receipt = confirmedSubscriptionReceipt(content)
    || (trustedBillingSender(sender) && hasSubscriptionReceiptStructure(html));
  const trialOnly = TRIAL_PATTERNS.some((pattern) => pattern.test(content));
  const marketingTrial = trialOnly && !receipt && !isStrictPlusEvidenceSubject(subject);
  const confirmedPlus = !marketingTrial && (receipt || isStrictPlusEvidenceSubject(subject)
    || ACTIVE_PATTERNS.some((pattern) => pattern.test(content)));
  return { confirmedPlus, billingChannel: confirmedPlus ? channelFromContent(content) : "" };
}
