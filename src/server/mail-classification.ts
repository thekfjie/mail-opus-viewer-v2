import { isPlanOrderSubject, isStrictPlusEvidenceSubject } from "./plus-evidence.js";

const SECURITY_PATTERNS = [
  /^(?:your\s+)?(?:OpenAI|ChatGPT)\s+code\s+is\b/i,
  /multi[- ]factor\s+authentication\s+settings.*chang/i,
  /(?:temporary|临时|臨時|一時).*(?:code|验证码|驗證碼|認証コード|login|登录|登入)/i,
  /(?:authentication|verification|sign[ -]?in|login|log in|one[ -]?time|magic link).*(?:code|link)/i,
  /(?:code).*(?:authentication|verification|sign[ -]?in|login|connexion|authentification|autenticaci[oó]n|acceso|tempor(?:aire|al))/i,
  /(?:password|密码|密碼).*(?:reset|重置)/i,
  /new sign-in|new login|新的登录|新的登入/i,
  /(?:mfa|2fa|passkey|security key|account security|安全密钥|安全金鑰)/i,
  /email.*(?:change|changed)|邮箱.*(?:换绑|更改)|郵箱.*(?:更改|換綁)/i,
];

const REBIND_PATTERNS = [
  /(?:your\s+)?(?:chatgpt|openai)\s+(?:email|e-mail)\s+address\s+(?:was|has been)\s+(?:changed|updated)/i,
  /(?:email|e-mail)\s+address\s+(?:was|has been)\s+(?:changed|updated)/i,
  /(?:邮箱|郵箱).*(?:换绑|換綁|更改|变更|變更|更新)/i,
  /(?:换绑|換綁|更改|变更|變更|更新).*(?:邮箱|郵箱)/i,
];

const DEACTIVATION_PATTERNS = [
  /^OpenAI(?:\s+API)?\s*[-–—]\s*Access Deactivated\b/i,
  /^OpenAI(?:\s+API)?\s*[-–—]\s*(?:存取權已停用|存取权已停用|訪問權限已停用|访问权限已停用|帳戶已停用|帐户已停用|アクセスが無効になりました|アカウントが無効になりました)(?:\s|\[|$)/i,
];
const BILLING_PATTERNS = [
  /invoice|receipt|payment|billing|subscription|renewal|refund|chargeback/i,
  /payment\s+method|payment\s+failed|update\s+(?:your\s+)?plus\s+payment/i,
  /账单|收据|付款|支付|订阅|訂閱|套餐|方案|续费|續費|退款|扣款/i,
  /(?:plus\s+)?access\s+(?:will\s+)?end|subscription\s+(?:will\s+)?end|(?:订阅|訂閱).*(?:到期|结束|結束)/i,
];
const PROMOTION_PATTERNS = [/introducing|discover|try chatgpt|写作支援|tips|newsletter|推荐|推廣/i];
const POLICY_PATTERNS = [/terms|policy|privacy|政策|条款|條款|隱私|隐私/i];

const STRUCTURE_TOKEN_PATTERNS = {
  security: /(?:verification|authentication|one[-_ ]?time|login|sign[-_ ]?in|security)[-_ ]?(?:code|token|link|notice)?|mfa|2fa|passkey/i,
  rebind: /(?:email|mail)[-_ ]?(?:address[-_ ]?)?(?:change|changed|updated)|(?:old|new)[-_ ]?email/i,
  deactivation: /(?:access|account|user)[-_ ]?(?:deactivated|disabled|suspended)|deactivation|account[-_ ]?ban/i,
  policy: /(?:policy|terms|privacy)[-_ ]?(?:violation|warning|update|notice)?|violation[-_ ]?warning/i,
  billing: /(?:order|invoice|receipt|payment|subscription|renewal|refund|chargeback|billing|payment[-_ ]?method|subscription[-_ ]?(?:end|expiry|expired|cancel))/i,
  promotion: /(?:marketing|newsletter|promotion|campaign|trial[-_ ]?offer|feature[-_ ]?announcement)/i,
};

function trustedSenderHint(sender: string): boolean {
  const value = String(sender || "").toLowerCase();
  if (/^(?:openai|chatgpt)$/.test(value.trim())) return true;
  const address = value.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/)?.[0] || "";
  if (!address) return false;
  return /@(?:[a-z0-9-]+\.)*openai\.com$/.test(address)
    || /_at_(?:tm|email)_openai_com_[a-z0-9_]+@icloud\.com$/.test(address);
}

function visibleHtml(html: string): string {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
}

function hasStructuredSignal(html: string, kind: keyof typeof STRUCTURE_TOKEN_PATTERNS): boolean {
  const source = String(html || "");
  if (!source) return false;
  const attributes = [...source.matchAll(/\b(?:class|id|data-testid|role)=["']([^"']+)["']/gi)]
    .map((match) => String(match[1] || "")).join(" ");
  return STRUCTURE_TOKEN_PATTERNS[kind].test(attributes);
}

function hasBodyStructure(text: string, html: string, kind: keyof typeof STRUCTURE_TOKEN_PATTERNS): boolean {
  const source = `${String(text || "")}\n${visibleHtml(html)}`;
  if (kind === "security") return /\b\d{4,8}\b/.test(source) && STRUCTURE_TOKEN_PATTERNS.security.test(source);
  if (kind === "rebind") return (source.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).length >= 2;
  return STRUCTURE_TOKEN_PATTERNS[kind].test(source);
}

const VERIFICATION_SUBJECT_PATTERNS = [
  /(?:verification|verify|login|temporary|one[- ]time|security|authentication|sign[ -]?in).*(?:code)|code.*(?:verification|login|temporary)|(?:chatgpt|openai)\s+code\s+is\b/i,
  /验证码|驗證碼|登录代码|登入代碼|認証コード|確認コード|検証コード|ログイン\s*コード|인증\s*코드|일회용\s*코드|로그인\s*코드/i,
  /mã\s+(?:xác\s+minh|xác\s+nhận|tạm\s+thời|đăng\s+nhập)|kode\s+(?:verifikasi|sementara|masuk)|kod\s+(?:pengesahan|log\s+masuk)/i,
  /c[oó]digo.*(?:verifica|tempor[aá]ri|temporal|acceso|acesso|iniciar\s+sesi[oó]n)|c[oó]digo(?:\s+(?:do|de|da))?\s+(?:openai|chatgpt)|code.*(?:v[ée]rification|temporaire|connexion)/i,
  /best[aä]tigungscode|verifizierungscode|anmeldecode|sicherheitscode|codice.*(?:verifica|temporaneo|accesso)|verificatiecode|aanmeldcode/i,
  /kod\s+(?:weryfikacyjny|weryfikacji|logowania)|doğrulama\s+kodu|geçici.*kod|код.*(?:подтверждения|входа)|временный\s+код/i,
  /رمز\s+(?:التحقق|مؤقت)|รหัส(?:ยืนยัน|ชั่วคราว)/i,
  /(?:लॉग\s*इन|लॉगिन|टेम्पररी).*कोड/i,
];

/** 收信分类和取码共用多语言规则，包含 iCloud 转发后的 OpenAI 发件人。 */
export function isVerificationMail(subject: string, sender = ""): boolean {
  const text = String(subject || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  return /openai|chatgpt/i.test(`${text} ${sender}`)
    && VERIFICATION_SUBJECT_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyMail(subject: string, sender = "", body = "", html = ""): { category: string; isSecurity: boolean; safeAcrossBinding: boolean } {
  const text = `${subject || ""} ${sender || ""} ${body || ""}`.replace(/\s+/g, " ").trim();
  const trusted = trustedSenderHint(sender);
  if (isDeactivationSubject(subject) || (trusted && hasStructuredSignal(html, "deactivation"))) {
    return { category: "deactivation", isSecurity: false, safeAcrossBinding: false };
  }
  if (REBIND_PATTERNS.some((pattern) => pattern.test(text)) || (trusted && hasStructuredSignal(html, "rebind"))) {
    return { category: "rebind", isSecurity: true, safeAcrossBinding: false };
  }
  if (isVerificationMail(subject, sender) || SECURITY_PATTERNS.some((pattern) => pattern.test(text))
    || (trusted && (hasStructuredSignal(html, "security") || hasBodyStructure(body, html, "security")))) {
    return { category: "security", isSecurity: true, safeAcrossBinding: false };
  }
  if (isPlanOrderSubject(subject) || isStrictPlusEvidenceSubject(subject)
    || BILLING_PATTERNS.some((pattern) => pattern.test(text))
    || (trusted && hasStructuredSignal(html, "billing"))) {
    return { category: "billing", isSecurity: false, safeAcrossBinding: false };
  }
  if (POLICY_PATTERNS.some((pattern) => pattern.test(text)) || (trusted && hasStructuredSignal(html, "policy"))) {
    return { category: "policy", isSecurity: false, safeAcrossBinding: false };
  }
  if (PROMOTION_PATTERNS.some((pattern) => pattern.test(text)) || (trusted && hasStructuredSignal(html, "promotion"))) {
    return { category: "promotion", isSecurity: false, safeAcrossBinding: false };
  }
  return { category: "general", isSecurity: false, safeAcrossBinding: false };
}

export function isDeactivationSubject(subject: string): boolean {
  const normalized = String(subject || "").replace(/\s+/g, " ").trim();
  return DEACTIVATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export const SAFE_ACROSS_BINDING_CATEGORIES = new Set<string>();
