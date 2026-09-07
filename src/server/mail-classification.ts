const SECURITY_PATTERNS = [
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
  /access deactivated/i,
  /存取权已停用|访问权限已停用|帳戶已停用|账号已停用/i,
  /アクセスが無効になりました|アカウントが無効になりました/i,
];
const BILLING_PATTERNS = [/invoice|receipt|payment|billing|subscription|plan|账单|收据|付款|套餐|訂閱|方案/i];
const PROMOTION_PATTERNS = [/introducing|discover|try chatgpt|写作支援|tips|newsletter|推荐|推廣/i];
const POLICY_PATTERNS = [/terms|policy|privacy|政策|条款|條款|隱私|隐私/i];

export function classifyMail(subject: string, sender = ""): { category: string; isSecurity: boolean; safeAcrossBinding: boolean } {
  const text = `${subject || ""} ${sender || ""}`;
  if (REBIND_PATTERNS.some((pattern) => pattern.test(text))) return { category: "rebind", isSecurity: true, safeAcrossBinding: false };
  if (SECURITY_PATTERNS.some((pattern) => pattern.test(text))) return { category: "security", isSecurity: true, safeAcrossBinding: false };
  if (DEACTIVATION_PATTERNS.some((pattern) => pattern.test(text))) return { category: "deactivation", isSecurity: false, safeAcrossBinding: false };
  if (BILLING_PATTERNS.some((pattern) => pattern.test(text))) return { category: "billing", isSecurity: false, safeAcrossBinding: false };
  if (POLICY_PATTERNS.some((pattern) => pattern.test(text))) return { category: "policy", isSecurity: false, safeAcrossBinding: false };
  if (PROMOTION_PATTERNS.some((pattern) => pattern.test(text))) return { category: "promotion", isSecurity: false, safeAcrossBinding: false };
  return { category: "general", isSecurity: false, safeAcrossBinding: false };
}

export const SAFE_ACROSS_BINDING_CATEGORIES = new Set<string>();
