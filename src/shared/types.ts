export type LifecycleStatus = "active" | "deactivated" | "retired" | "quarantined" | "deleted";
export type RelationType = "email_rebind" | "mailbox_recycle" | "replacement_account" | "possible_duplicate";
export type GrantScope = "current" | "historical" | "admin_only";
export type SaleStatus = "none" | "active" | "closed" | "cancelled";

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
  provider: string;
  domainMailbox: boolean;
  suspectedUnused: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
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
  paymentExposureCount: number;
  paymentExposureExposedCount: number;
  paymentExposureUnknownCount: number;
  paymentExposureCheckedAt: string;
  trialStatus: string;
  promoEligible: boolean | null;
  promoCampaign: string;
  trialCheckedAt: string;
  accessTokenFirstSeenAt: string;
  autoTrialDueAt: string;
  autoTrialStatus: string;
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
}
