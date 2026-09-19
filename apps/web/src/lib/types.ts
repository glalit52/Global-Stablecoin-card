/** Response shapes, mirroring what the API actually returns. */

export type RiskState = 'healthy' | 'watch' | 'restricted' | 'remediation' | 'liquidation';

export interface Me {
  id: string; email: string; legalName: string; jurisdiction: string;
  status: string; tier: string; kycStatus: string; memberSince: string;
  stepUpActive: boolean;
}

export interface CreditView {
  creditLimit: string; currentBalance: string; principalBalance: string;
  interestBalance: string; feeBalance: string; pendingAuthorizations: string;
  availableCredit: string; safeSpendCapacity: string; utilization: string | null;
  apr: string; status: string; currency: string;
  decision: {
    approved: boolean; creditLimit: string; previousLimit: string | null;
    breakdown: Record<string, string>; declineReasons: string[];
    explanations: string[]; policyVersion: string; decidedAt: string;
  } | null;
}

export interface RiskView {
  state: RiskState; healthPercent: string; healthFactor: string | null;
  effectiveLtv: string | null; grossLtv: string | null;
  totalDebt: string; eligibleCollateralValue: string; totalMarketValue: string;
  topConcentration: string; withdrawableCollateral: string; safeSpendCapacity: string;
  triggeredRules: string[]; degraded: boolean;
  collateralCallAmount: string; repaymentToTarget: string;
  thresholds: { watch: string; restricted: string; remediation: string; liquidation: string };
  marginCall: { id: string; deadline: string; requiredAmount: string } | null;
  policyVersion: string; computedAt: string;
}

export interface Position {
  assetId: string; symbol: string; assetClass: string; quantity: string;
  marketValue: string; eligibleValue: string; eligible: boolean;
  haircut: string; liquidityAdjustment: string; concentrationAdjustment: string;
  concentration: string; priceAsOf: string;
  ineligibilityReasons: { code: string; explanation: string }[];
}

export interface WealthView {
  totalWealth: string; eligibleCollateral: string; currency: string;
  computedAt: string; degraded: boolean; unpricedSymbols: string[];
  allocation: { assetClass: string; marketValue: string; eligibleValue: string; share: string }[];
  positions: Position[];
}

export interface CardView {
  id: string; form: 'virtual' | 'physical'; last4: string;
  expMonth: number; expYear: number; status: string; network: string;
  controls: Record<string, unknown>; wallets: string[]; createdAt: string;
}

export interface TransactionView {
  id: string; merchantName: string; mcc: string; category: string;
  merchantCountry: string; originalAmount: string; originalCurrency: string;
  billingAmount: string; fxRate: string | null; fxFee: string;
  pointsEarned: string; status: string; authorizedAt: string; settledAt: string | null;
}

export interface DeclinedView {
  requestId: string; merchantName: string; mcc: string; merchantCountry: string;
  amount: string; currency: string; declineCode: string | null;
  declineReason: string | null; declinedAt: string;
}

export interface AlertView {
  id: string; kind: string; severity: 'info' | 'warning' | 'critical';
  title: string; body: string; actionLabel: string | null;
  actionHref: string | null; status: string; createdAt: string;
}

export interface RewardsView {
  points: {
    posted: string; pending: string; lifetimeEarned: string; redeemed: string;
    statementCreditValue: string; travelValue: string;
  };
  tier: {
    current: string; annualFee: string; baseEarnRate: string;
    categoryMultipliers: Record<string, string>;
    bonusCategoryMonthlyCap: string | null; fxMarkupBps: number;
    conciergeIncluded: boolean; loungeUnlimited: boolean;
    loungeVisitsRemaining: number | null; nextTier: string | null;
    progressToNextTier: string; collateralToNextTier: string; spendToNextTier: string;
  };
  economics: {
    trailingAnnualSpend: string; rewardsCost: string; rewardsCostPercentOfSpend: string;
  };
  recent: {
    id: string; type: string; points: string;
    category: string | null; description: string; occurredAt: string;
  }[];
}

export interface StressView {
  scenarios: {
    id: string; label: string; eligibleCollateralValue: string;
    effectiveLtv: string | null; healthFactor: string | null;
    state: RiskState; collateralShortfall: string; survives: boolean;
  }[];
  drawdownTolerance: string | null;
}

export interface AiAnswer {
  interactionId: string; intent: string; answer: string;
  disclaimers: string[];
  sources: { key: string; label: string; value: string; unit: string; asOf: string; source: string }[];
  modelUsed: boolean; groundingRejected: boolean; policyVersion: string;
}

export interface AdminCustomer {
  id: string; email: string; legalName: string; jurisdiction: string;
  tier: string; status: string; kycStatus: string;
  creditLimit: string | null; balance: string | null;
  riskState: RiskState | null; healthPercent: string | null;
  effectiveLtv: string | null; createdAt: string;
}

export interface AdminMetrics {
  portfolio: {
    customers: number; fundedCustomers: number; totalCreditLimit: string;
    totalOutstanding: string; totalEligibleCollateral: string; portfolioLtv: string;
  };
  riskDistribution: Record<string, number>;
  payments: {
    transactions30d: number; volume30d: string; pointsIssued30d: string;
    authorizations30d: number; approvalRate: string; avgAuthLatencyMs: string;
  };
}

export interface ReconciliationView {
  runAt: string; entryCount: number; balanced: boolean;
  totalDebits: string; totalCredits: string; residual: string;
  breaks: { kind: string; detail: string; amount: string | null; reference: string | null }[];
  income: Record<string, string>;
}
