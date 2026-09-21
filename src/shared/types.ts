export type LifecycleStatus = "active" | "third_party_registered" | "third_party_pending_recovery" | "deactivated" | "retired" | "quarantined" | "deleted";
export type RelationType = "email_rebind" | "mailbox_recycle" | "replacement_account" | "possible_duplicate";
export type GrantScope = "current" | "historical" | "admin_only";
export type SaleStatus = "none" | "active" | "closed" | "cancelled";

export type RecycleMode = "deactivated" | "untagged_free" | "invalid_at" | "alias_rotate";
export interface RecycleModeEligibility {
  eligible: boolean;
  reason: string;
  eligibleAt: string;
  trigger: "admin_only";
}
export interface RecycleEligibility {
  accountId: string;
  generation: number;
  maxGeneration: number;
  waitMs: number;
  checkedAt: string;
  account: { lifecycleStatus: string; deactivationLocked: boolean; deactivatedAt: string;
    retired: boolean; deleted: boolean; sold: boolean; customerOpened: boolean };
  evidence: { tokenPlan: "free" | "paid" | "unknown"; hasAccessToken: boolean; invalidAT: boolean;
    mailVerifiedNoPlus: boolean; hasPlusEvidence: boolean; isAuto: boolean; sharedMailbox: boolean;
    specialMarkerCount: number; reusableNoATAutoICloud: boolean };
  modes: Record<RecycleMode, RecycleModeEligibility>;
}

export type PaymentExposurePromoMode = "none" | "one_month" | "unknown";

export interface PaymentExposureCheck {
  id: string;
  target: string;
  ipCountry: string;
  billingCountry: string;
  billingCurrency: string;
  expectedMethod: string;
  availableMethods: string[];
  matchedMethods: string[];
  paymentMethods: PaymentExposureMethod[];
  trialStatus: string;
  exposed: boolean;
  status: string;
  checkoutType: string;
  detail: string;
  promoEligible: boolean | null;
  promoCampaign: string;
  promoMode?: PaymentExposurePromoMode;
  observedAt: string;
  updatedAt: string;
}

export interface PaymentExposureMethod {
  id: string;
  type: string;
  provider: string;
  name: string;
  code: string;
  displayName: string;
  source: string;
  sources?: string[];
  promoMode?: PaymentExposurePromoMode;
}

export interface PaymentExposureMethodSummary {
  method: string;
  sources: string[];
  promoMode?: PaymentExposurePromoMode;
}

export interface PaymentExposureRoute {
  key: string;
  label: string;
  target: string;
  ipCountry: string;
  billingCountry: string;
  billingCurrency: string;
  expectedMethod: string;
  configured: boolean;
  promotionConfigured: boolean;
  promotionIpCountry: string;
  source: "saved" | "environment" | "none";
  addressDisplay: string;
}

export interface PaymentEligibilityApiSummary {
  configured: boolean;
  source: "saved" | "environment" | "default" | "none";
  endpoint: string;
  hasApiToken: boolean;
}

export interface CheckRouteSummary {
  key: "promotion_jp" | "nl_ideal" | "de_paypal" | "ph_gcash";
  label: string;
  ipCountry: string;
  configured: boolean;
  source: "saved" | "environment" | "none";
  addressDisplay: string;
}

export interface PaymentExposureJobItem {
  index: number;
  status: string;
  stage: string;
  extractionStatus: string;
  decision: string;
  finishedAt: string;
  durationMs: number;
  paymentExposure: PaymentExposureCheck[];
}

export interface PaymentExposureJobStatus {
  jobId: string;
  routeKey: string;
  jobKind: string;
  scheduledAt: string;
  promoMode?: PaymentExposurePromoMode;
  route: PaymentExposureRoute;
  status: string;
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  items: PaymentExposureJobItem[];
  pollError?: string;
}

export interface AccountSummary {
  id: string;
  primaryEmail: string;
  primaryEmailMasked: string;
  lifecycleStatus: LifecycleStatus;
  quarantineReason: string;
  deactivationLocked: boolean;
  retiredAt?: string;
  deactivatedAt: string;
  sold: boolean;
  everSold: boolean;
  saleStatus: SaleStatus;
  saleId: string;
  saleFirstUsedAt: string;
  sellable: boolean;
  sellBlockers: string[];
  identityStatus: string;
  accountState: string;
  accountStateLabel: string;
  hidePromotion: boolean;
  plan: string;
  billingChannel: string;
  billingChannelOverride: string;
  provider: string;
  domainMailbox: boolean;
  isAuto: boolean;
  openAiMfaEnabled: boolean;
  openAiAuthMethods: string[];
  suspectedUnused: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  hasStoredAccessToken: boolean;
  hasStoredRefreshToken: boolean;
  credentialState: string;
  credentialStateLabel: string;
  internalPending: boolean;
  markColor: string;
  groupBoundary: boolean;
  bindingCount: number;
  relationCount: number;
  customerGrantCount: number;
  sourceStatus: string;
  arrivedAt: string;
  updatedAt: string;
  latestMailAt: string;
  paymentExposureStatus: string;
  paymentExposureSummary: string;
  paymentExposureMethods: string[];
  paymentExposureMethodDetails: PaymentExposureMethodSummary[];
  paymentExposureCount: number;
  paymentExposureExposedCount: number;
  paymentExposureUnknownCount: number;
  paymentExposureCheckedAt: string;
  trialStatus: string;
  promoEligible: boolean | null;
  promoCampaign: string;
  promoCampaigns: string[];
  promoSuspicious: boolean;
  promoSuspiciousOverride: boolean;
  historicalPromoCampaigns: string[];
  trialCheckedAt: string;
  accessTokenFirstSeenAt: string;
  autoTrialDueAt: string;
  autoTrialStatus: string;
  promotionCheckStatus: string;
  promotionCheckStartedAt: string;
  promotionCheckUpdatedAt: string;
  promotionCheckErrorClass: string;
  promotionCheckErrorDetail: string;
  promotionCheckNextRetryAt: string;
  billingStartedAt: string;
  aliveUntil: string;
  aliveMs: number;
  aliveLabel: string;
  aliveActive: boolean;
}

export interface CredentialVersionSummary {
  id: string;
  subjectHash: string;
  tokenFingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  validityStatus: string;
  validityCheckedAt: string;
  source: string;
  supersedesId: string;
  retiredReason: string;
  observedBindingId: string;
  current: boolean;
  observationCount: number;
}

export interface BindingStage {
  id: string;
  email: string;
  provider: string;
  validFrom: string;
  validTo: string;
  isCurrent: boolean;
  associationMethod: string;
  legacyMappingId: string;
  receiveDisabledAt: string;
}

export interface AccountRelation {
  id: string;
  relationType: RelationType;
  fromAccountId: string;
  toAccountId: string;
  changedAt: string;
  associationMethod: string;
  evidence: unknown;
}

export interface AccountDetail extends AccountSummary {
  note: string;
  paymentLink: string;
  bindings: BindingStage[];
  relations: AccountRelation[];
  timeline: Array<{ id: string; eventType: string; occurredAt: string; payload: unknown }>;
  paymentExposureChecks: PaymentExposureCheck[];
  credentialVersions: CredentialVersionSummary[];
  promotion: Record<string, unknown> | null;
  mailboxConnections: Array<{ id: string; bindingId: string; provider: string; status: string; externalGroupId: string; metadata: unknown }>;
  routingRules: Array<{ id: string; bindingId: string; senderPattern: string; recipientPattern: string; validFrom: string; validTo: string; priority: number }>;
}
