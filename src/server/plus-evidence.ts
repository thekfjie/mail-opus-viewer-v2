const TRIAL_OR_ZERO_CHARGE_PATTERNS = [
  /\b(?:free|complimentary)\s+(?:month|trial|trial period)\b/i,
  /\b(?:first|initial)\s+month.{0,24}\bfree\b/i,
  /(?:免费|免費|無料)(?:试用|試用|体验|體驗|体験|トライアル)?/i,
  /(?:首月|首个一月|最初の一か月|初月).{0,16}(?:免费|免費|無料)/i,
  /(?:^|\D)(?:0|0\.00)\s*(?:USD|EUR|JPY|CNY|元|円|美元|欧元)(?:\D|$)/i,
];

const STRICT_ACTIVE_SUBJECT_PATTERNS = [
  /^Welcome\s+to\s+ChatGPT\s+Plus$/i,
  /^ChatGPT\s+Plus\s+(?:subscription\s+)?(?:renewed|renewal)$/i,
  /^Your\s+ChatGPT\s+Plus\s+(?:subscription|plan)\s+is\s+(?:now\s+)?(?:active|renewed)$/i,
  /^(?:ChatGPT|OpenAI).{0,48}(?:receipt|invoice|payment confirmation|payment received|renewal).{0,48}(?:Plus|subscription)$/i,
  /^(?:Plus|subscription).{0,48}(?:receipt|invoice|payment confirmation|payment received|renewal).{0,48}(?:ChatGPT|OpenAI)$/i,
];

const PLAN_ORDER_SUBJECT_PATTERNS = [
  /^ChatGPT\s*-\s*Your new plan$/i,
  /^ChatGPT\s*-\s*你的新(?:套餐|方案|[计計][划劃])$/i,
  /^ChatGPT\s*-\s*新しいプラン$/i,
];

function normalizedSubject(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function isTrialOrZeroChargeSubject(subject: unknown): boolean {
  const value = normalizedSubject(subject);
  return TRIAL_OR_ZERO_CHARGE_PATTERNS.some((pattern) => pattern.test(value));
}

export function isPlanOrderSubject(subject: unknown): boolean {
  const value = normalizedSubject(subject);
  return PLAN_ORDER_SUBJECT_PATTERNS.some((pattern) => pattern.test(value));
}

export function isStrictPlusEvidenceSubject(subject: unknown): boolean {
  const value = normalizedSubject(subject);
  if (!value || isTrialOrZeroChargeSubject(value) || isPlanOrderSubject(value)) return false;
  return STRICT_ACTIVE_SUBJECT_PATTERNS.some((pattern) => pattern.test(value));
}
