/**
 * Risk policy: the single, versioned source of every parameter the collateral,
 * credit, risk and liquidation engines read.
 *
 * PRD §12.3 and §22 require that production risk rules be deterministic,
 * testable and governed. That means:
 *   - no engine may hard-code a threshold; it reads it from here,
 *   - every policy carries a `version` that is stamped onto every decision,
 *   - policies are frozen objects so a request handler cannot mutate one.
 *
 * Nothing in this file is a lending term. Final LTVs, haircuts and eligibility
 * must be set by the regulated lender, legal counsel and the risk committee
 * (PRD §10.2). These values are conservative engineering defaults.
 */
import { D, Decimal, Money } from './money.js';
import type { AssetClass, Jurisdiction, MerchantCategory, Tier } from './types.js';

export interface AssetPolicy {
  /** PRD §10.1 eligibility factor, 0..1. */
  readonly eligibilityFactor: string;
  /** Floor haircut before volatility adjustment, 0..1. */
  readonly baseHaircut: string;
  /** Ceiling on the volatility-adjusted haircut, 0..1. */
  readonly maxHaircut: string;
  /** Multiplier applied to realized volatility when deriving the haircut. */
  readonly volatilityHaircutMultiplier: string;
  /** Share of this asset class permitted in eligible collateral before the
   *  concentration penalty starts biting, 0..1. */
  readonly concentrationCap: string;
  /** Static risk descriptor, 0..1, higher = riskier. Used when no realized
   *  volatility is available. */
  readonly defaultVolatility: string;
  /** Static liquidity descriptor, 0..1, higher = more liquid. */
  readonly defaultLiquidity: string;
  /** Maximum age of a price quote before the asset is marked stale. */
  readonly maxPriceAgeSeconds: number;
  /** Maximum age of ownership verification before collateral is suspended. */
  readonly maxVerificationAgeHours: number;
  /** Positions below this value in the facility currency are ignored. */
  readonly dustThreshold: string;
  /** Slippage assumed when modelling a forced sale, 0..1. */
  readonly liquidationSlippage: string;
  /** Venue/execution fee assumed when modelling a forced sale, 0..1. */
  readonly liquidationFee: string;
  /** Order in which this class is sold during liquidation. Lower sells first. */
  readonly liquidationPriority: number;
  readonly eligibleForCollateral: boolean;
}

export interface TierPolicy {
  readonly maxCreditLimit: string;
  readonly minCreditLimit: string;
  /** Limits are rounded down to a multiple of this. */
  readonly limitStep: string;
  readonly annualFee: string;
  /** Base earn rate in points per unit of spend. */
  readonly baseEarnRate: string;
  /** Category multipliers applied on top of the base rate. */
  readonly categoryMultipliers: Readonly<Partial<Record<MerchantCategory, string>>>;
  /** Points earned above this per calendar month accrue at the base rate only. */
  readonly bonusCategoryMonthlyCap: string;
  readonly loungeVisitsPerYear: number;
  readonly conciergeIncluded: boolean;
  readonly fxMarkupBps: number;
}

export interface RiskThresholds {
  /** Advance rate: max eligible-collateral LTV at origination, 0..1. */
  readonly maxOriginationLtv: string;
  /** Informational alert threshold. */
  readonly watchLtv: string;
  /** New spend is capped above this. */
  readonly restrictedLtv: string;
  /** Margin call: customer must add collateral or repay. */
  readonly remediationLtv: string;
  /** Forced-action threshold. */
  readonly liquidationLtv: string;
  /** LTV a liquidation restores the account to. Must be < remediationLtv. */
  readonly liquidationTargetLtv: string;
  /** Hours a customer has to cure a margin call before liquidation may run. */
  readonly remediationWindowHours: number;
  /** Health factor denominator: collateral x this / debt. */
  readonly liquidationThreshold: string;
  /** Spend is blocked entirely above this LTV even inside the limit. */
  readonly spendBlockLtv: string;
}

export interface StablecoinPolicy {
  /** Symbols permitted as collateral in this policy version. */
  readonly whitelist: readonly string[];
  /** Deviation from peg that marks the asset as depegged, 0..1. */
  readonly depegThreshold: string;
  /** Extra haircut applied once depeg is detected, 0..1. */
  readonly depegHaircut: string;
  /** Max share of eligible collateral from any single stablecoin issuer, 0..1. */
  readonly issuerConcentrationCap: string;
  readonly issuerBySymbol: Readonly<Record<string, string>>;
}

export interface FraudPolicy {
  /** Score at or above which an authorization is declined, 0..1. */
  readonly declineThreshold: string;
  /** Score at or above which step-up authentication is demanded. */
  readonly stepUpThreshold: string;
  /** Transactions per rolling window before velocity flags. */
  readonly velocityCount: number;
  readonly velocityWindowMinutes: number;
  /** Implied travel speed (km/h) above which geography is impossible. */
  readonly impossibleTravelKmh: number;
  /** Multiple of the customer's trailing average ticket that flags an anomaly. */
  readonly amountAnomalyMultiple: string;
  /** MCCs that always demand step-up regardless of score. */
  readonly highRiskMccs: readonly string[];
}

export interface CreditPolicy {
  /** Floor on the portfolio risk adjustment term, 0..1. */
  readonly minPortfolioRiskAdjustment: string;
  readonly minLiquidityAdjustment: string;
  readonly minConcentrationAdjustment: string;
  readonly minCustomerAdjustment: string;
  readonly maxCustomerAdjustment: string;
  /** Months of tenure at which the tenure bonus is fully earned. */
  readonly tenureMaturityMonths: number;
  /** Max uplift from a perfect repayment record, e.g. "0.10" = +10%. */
  readonly repaymentBonus: string;
  /** Penalty per 30-day delinquency in the last 24 months. */
  readonly delinquencyPenalty: string;
  /** Credit capacity may not exceed this multiple of verified annual income
   *  where income is known. Null disables the test. */
  readonly incomeMultipleCap: string | null;
  /** Scenario id from `stressScenarios` used as the baseline adverse case
   *  when sizing the portfolio risk adjustment. */
  readonly baselineStressScenarioId: string;
  /** Share of eligible collateral a sound book is expected to retain under
   *  that baseline scenario, 0..1. Books that retain less are cut back. */
  readonly expectedStressSurvival: string;
  /** Weighted liquidity at or above which the book needs no portfolio-level
   *  liquidity reduction, 0..1. */
  readonly adequateLiquidity: string;
  /** Statement APR in basis points, before tier/risk adjustment. */
  readonly baseAprBps: number;
  /** Days between statement close and payment due. */
  readonly gracePeriodDays: number;
  /** Minimum payment as a share of the statement balance, 0..1. */
  readonly minimumPaymentRate: string;
  /** Absolute floor on the minimum payment. */
  readonly minimumPaymentFloor: string;
}

export interface JurisdictionPolicy {
  readonly enabled: boolean;
  /** Program-level ceiling on any one customer's limit. */
  readonly maxCreditLimit: string;
  /** Asset classes this jurisdiction permits as collateral. */
  readonly permittedAssetClasses: readonly AssetClass[];
  /** Stablecoins permitted here, narrowing the global whitelist. */
  readonly permittedStablecoins: readonly string[];
  /** Whether forced liquidation may run without a court/regulatory step. */
  readonly automatedLiquidationPermitted: boolean;
  readonly requiresIncomeVerification: boolean;
}

export interface RiskPolicy {
  readonly version: string;
  readonly effectiveFrom: string;
  readonly description: string;
  readonly facilityCurrency: string;
  readonly assets: Readonly<Record<AssetClass, AssetPolicy>>;
  /** Per-symbol overrides layered on top of the asset-class policy. */
  readonly symbolOverrides: Readonly<Record<string, Partial<AssetPolicy>>>;
  readonly tiers: Readonly<Record<Tier, TierPolicy>>;
  readonly thresholds: RiskThresholds;
  readonly stablecoins: StablecoinPolicy;
  readonly fraud: FraudPolicy;
  readonly credit: CreditPolicy;
  readonly jurisdictions: Readonly<Record<Jurisdiction, JurisdictionPolicy>>;
  readonly stressScenarios: readonly import('./types.js').StressScenario[];
}

// ---------------------------------------------------------------------------
// v1.0.0 — MVP launch policy (PRD §23: BTC + stablecoins, one jurisdiction)
// ---------------------------------------------------------------------------

const MVP_POLICY: RiskPolicy = {
  version: 'risk-policy-1.0.0',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  description: 'MVP launch policy: BTC + regulated stablecoin collateral, US launch jurisdiction.',
  facilityCurrency: 'USD',

  assets: {
    STABLECOIN: {
      eligibilityFactor: '1.00', baseHaircut: '0.02', maxHaircut: '0.25',
      volatilityHaircutMultiplier: '1.5', concentrationCap: '1.00',
      defaultVolatility: '0.02', defaultLiquidity: '0.98',
      maxPriceAgeSeconds: 300, maxVerificationAgeHours: 24,
      dustThreshold: '25', liquidationSlippage: '0.001', liquidationFee: '0.001',
      liquidationPriority: 1, eligibleForCollateral: true,
    },
    CASH: {
      eligibilityFactor: '1.00', baseHaircut: '0.00', maxHaircut: '0.05',
      volatilityHaircutMultiplier: '0', concentrationCap: '1.00',
      defaultVolatility: '0.00', defaultLiquidity: '1.00',
      maxPriceAgeSeconds: 86_400, maxVerificationAgeHours: 72,
      dustThreshold: '25', liquidationSlippage: '0', liquidationFee: '0',
      liquidationPriority: 0, eligibleForCollateral: true,
    },
    BTC: {
      eligibilityFactor: '1.00', baseHaircut: '0.30', maxHaircut: '0.65',
      volatilityHaircutMultiplier: '0.55', concentrationCap: '0.80',
      defaultVolatility: '0.55', defaultLiquidity: '0.90',
      maxPriceAgeSeconds: 120, maxVerificationAgeHours: 12,
      dustThreshold: '50', liquidationSlippage: '0.008', liquidationFee: '0.002',
      liquidationPriority: 3, eligibleForCollateral: true,
    },
    // Present in the schema so V2 enablement is a policy change, not a code
    // change (PRD §6 "asset-agnostic architecture").
    ETH: {
      eligibilityFactor: '1.00', baseHaircut: '0.35', maxHaircut: '0.70',
      volatilityHaircutMultiplier: '0.60', concentrationCap: '0.60',
      defaultVolatility: '0.65', defaultLiquidity: '0.85',
      maxPriceAgeSeconds: 120, maxVerificationAgeHours: 12,
      dustThreshold: '50', liquidationSlippage: '0.010', liquidationFee: '0.002',
      liquidationPriority: 4, eligibleForCollateral: false,
    },
    ETF: {
      eligibilityFactor: '1.00', baseHaircut: '0.20', maxHaircut: '0.45',
      volatilityHaircutMultiplier: '0.45', concentrationCap: '0.70',
      defaultVolatility: '0.18', defaultLiquidity: '0.92',
      maxPriceAgeSeconds: 900, maxVerificationAgeHours: 36,
      dustThreshold: '50', liquidationSlippage: '0.002', liquidationFee: '0.001',
      liquidationPriority: 2, eligibleForCollateral: false,
    },
    EQUITY: {
      eligibilityFactor: '0.90', baseHaircut: '0.30', maxHaircut: '0.60',
      volatilityHaircutMultiplier: '0.50', concentrationCap: '0.25',
      defaultVolatility: '0.32', defaultLiquidity: '0.80',
      maxPriceAgeSeconds: 900, maxVerificationAgeHours: 36,
      dustThreshold: '50', liquidationSlippage: '0.004', liquidationFee: '0.001',
      liquidationPriority: 5, eligibleForCollateral: false,
    },
    BOND: {
      eligibilityFactor: '1.00', baseHaircut: '0.08', maxHaircut: '0.30',
      volatilityHaircutMultiplier: '0.30', concentrationCap: '1.00',
      defaultVolatility: '0.06', defaultLiquidity: '0.88',
      maxPriceAgeSeconds: 3_600, maxVerificationAgeHours: 48,
      dustThreshold: '50', liquidationSlippage: '0.002', liquidationFee: '0.001',
      liquidationPriority: 2, eligibleForCollateral: false,
    },
    OTHER_TOKEN: {
      eligibilityFactor: '0.00', baseHaircut: '1.00', maxHaircut: '1.00',
      volatilityHaircutMultiplier: '1.0', concentrationCap: '0.00',
      defaultVolatility: '0.95', defaultLiquidity: '0.20',
      maxPriceAgeSeconds: 60, maxVerificationAgeHours: 6,
      dustThreshold: '100', liquidationSlippage: '0.05', liquidationFee: '0.005',
      liquidationPriority: 9, eligibleForCollateral: false,
    },
  },

  symbolOverrides: {
    // USDC carries a lighter haircut than the generic stablecoin bucket on the
    // strength of its attestation regime; USDT carries more on reserve opacity.
    USDC: { baseHaircut: '0.015' },
    USDT: { baseHaircut: '0.06', concentrationCap: '0.40' },
    PYUSD: { baseHaircut: '0.03', concentrationCap: '0.30' },
  },

  tiers: {
    WEALTH: {
      maxCreditLimit: '50000', minCreditLimit: '1000', limitStep: '100',
      annualFee: '0', baseEarnRate: '1',
      categoryMultipliers: { groceries: '2', fuel_ev: '2', dining: '2' },
      bonusCategoryMonthlyCap: '2500',
      loungeVisitsPerYear: 0, conciergeIncluded: false, fxMarkupBps: 100,
    },
    WEALTH_PLUS: {
      maxCreditLimit: '250000', minCreditLimit: '5000', limitStep: '500',
      annualFee: '295', baseEarnRate: '1.25',
      categoryMultipliers: { groceries: '3', fuel_ev: '3', dining: '3', travel: '3', hotels: '3' },
      bonusCategoryMonthlyCap: '10000',
      loungeVisitsPerYear: 6, conciergeIncluded: false, fxMarkupBps: 50,
    },
    PRIVATE: {
      maxCreditLimit: '1000000', minCreditLimit: '25000', limitStep: '1000',
      annualFee: '995', baseEarnRate: '1.5',
      categoryMultipliers: { groceries: '3', fuel_ev: '3', dining: '4', travel: '5', hotels: '5', lounges: '5' },
      bonusCategoryMonthlyCap: '50000',
      loungeVisitsPerYear: -1, conciergeIncluded: true, fxMarkupBps: 0,
    },
    ULTRA: {
      maxCreditLimit: '10000000', minCreditLimit: '100000', limitStep: '5000',
      annualFee: '4950', baseEarnRate: '2',
      categoryMultipliers: { groceries: '3', fuel_ev: '3', dining: '5', travel: '6', hotels: '6', lounges: '6' },
      bonusCategoryMonthlyCap: '-1',
      loungeVisitsPerYear: -1, conciergeIncluded: true, fxMarkupBps: 0,
    },
  },

  thresholds: {
    maxOriginationLtv: '0.50',
    watchLtv: '0.60',
    restrictedLtv: '0.70',
    remediationLtv: '0.78',
    liquidationLtv: '0.85',
    liquidationTargetLtv: '0.55',
    remediationWindowHours: 24,
    liquidationThreshold: '0.85',
    spendBlockLtv: '0.70',
  },

  stablecoins: {
    whitelist: ['USDC', 'PYUSD'],
    depegThreshold: '0.01',
    depegHaircut: '0.30',
    issuerConcentrationCap: '0.75',
    issuerBySymbol: { USDC: 'circle', PYUSD: 'paxos', USDT: 'tether' },
  },

  fraud: {
    declineThreshold: '0.85',
    stepUpThreshold: '0.60',
    velocityCount: 8,
    velocityWindowMinutes: 10,
    impossibleTravelKmh: 900,
    amountAnomalyMultiple: '8',
    highRiskMccs: ['6011', '6051', '7995', '4829', '6540'],
  },

  credit: {
    minPortfolioRiskAdjustment: '0.40',
    minLiquidityAdjustment: '0.50',
    minConcentrationAdjustment: '0.60',
    minCustomerAdjustment: '0.50',
    maxCustomerAdjustment: '1.15',
    tenureMaturityMonths: 18,
    repaymentBonus: '0.10',
    delinquencyPenalty: '0.15',
    incomeMultipleCap: null,
    baselineStressScenarioId: 'btc_drawdown_30',
    expectedStressSurvival: '0.60',
    adequateLiquidity: '0.85',
    baseAprBps: 1_150,
    gracePeriodDays: 21,
    minimumPaymentRate: '0.02',
    minimumPaymentFloor: '35',
  },

  jurisdictions: {
    US: {
      enabled: true, maxCreditLimit: '5000000',
      permittedAssetClasses: ['BTC', 'STABLECOIN', 'CASH'],
      permittedStablecoins: ['USDC', 'PYUSD'],
      automatedLiquidationPermitted: true, requiresIncomeVerification: false,
    },
    AE: {
      enabled: true, maxCreditLimit: '3000000',
      permittedAssetClasses: ['BTC', 'STABLECOIN', 'CASH'],
      permittedStablecoins: ['USDC'],
      automatedLiquidationPermitted: true, requiresIncomeVerification: false,
    },
    SG: {
      enabled: true, maxCreditLimit: '2000000',
      permittedAssetClasses: ['BTC', 'STABLECOIN', 'CASH'],
      permittedStablecoins: ['USDC'],
      automatedLiquidationPermitted: true, requiresIncomeVerification: true,
    },
    CH: { enabled: false, maxCreditLimit: '0', permittedAssetClasses: [], permittedStablecoins: [], automatedLiquidationPermitted: false, requiresIncomeVerification: true },
    GB: { enabled: false, maxCreditLimit: '0', permittedAssetClasses: [], permittedStablecoins: [], automatedLiquidationPermitted: false, requiresIncomeVerification: true },
    EU: { enabled: false, maxCreditLimit: '0', permittedAssetClasses: [], permittedStablecoins: [], automatedLiquidationPermitted: false, requiresIncomeVerification: true },
    IN: { enabled: false, maxCreditLimit: '0', permittedAssetClasses: [], permittedStablecoins: [], automatedLiquidationPermitted: false, requiresIncomeVerification: true },
    CA: { enabled: false, maxCreditLimit: '0', permittedAssetClasses: [], permittedStablecoins: [], automatedLiquidationPermitted: false, requiresIncomeVerification: true },
    AU: { enabled: false, maxCreditLimit: '0', permittedAssetClasses: [], permittedStablecoins: [], automatedLiquidationPermitted: false, requiresIncomeVerification: true },
  },

  stressScenarios: [
    { id: 'btc_drawdown_30', label: 'BTC -30%', shocks: { BTC: '-0.30' } },
    { id: 'btc_drawdown_50', label: 'BTC -50%', shocks: { BTC: '-0.50' } },
    { id: 'btc_drawdown_70', label: 'BTC -70% (2018/2022 analogue)', shocks: { BTC: '-0.70' } },
    { id: 'stablecoin_depeg', label: 'Stablecoin depeg to $0.90', shocks: {}, stablecoinPeg: '0.90' },
    { id: 'correlated_crash', label: 'BTC -50% with depeg to $0.95 and liquidity stress', shocks: { BTC: '-0.50', ETH: '-0.60' }, stablecoinPeg: '0.95', liquidityShock: '0.10' },
    { id: 'liquidity_freeze', label: 'Order-book liquidity deterioration', shocks: { BTC: '-0.15' }, liquidityShock: '0.20' },
    { id: 'equity_drawdown_20', label: 'Equities -20%', shocks: { EQUITY: '-0.20', ETF: '-0.20' } },
  ],
};

/** Policy registry. New versions are added, never edited in place. */
const REGISTRY = new Map<string, RiskPolicy>();

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
};

export const registerPolicy = (policy: RiskPolicy): void => {
  if (REGISTRY.has(policy.version)) throw new Error(`policy ${policy.version} already registered`);
  REGISTRY.set(policy.version, deepFreeze(policy));
};

registerPolicy(MVP_POLICY);

let activeVersion = MVP_POLICY.version;

export const getPolicy = (version?: string): RiskPolicy => {
  const v = version ?? activeVersion;
  const p = REGISTRY.get(v);
  if (!p) throw new Error(`unknown risk policy version "${v}"`);
  return p;
};

export const listPolicyVersions = (): string[] => [...REGISTRY.keys()];

/** Swap the active policy. Governed action: callers must write an audit record. */
export const setActivePolicy = (version: string): void => {
  if (!REGISTRY.has(version)) throw new Error(`unknown risk policy version "${version}"`);
  activeVersion = version;
};

export const getActivePolicyVersion = (): string => activeVersion;

// --- Resolution helpers -----------------------------------------------------

/** Asset-class policy with any per-symbol override layered on top. */
export const resolveAssetPolicy = (
  policy: RiskPolicy,
  assetClass: AssetClass,
  symbol: string,
): AssetPolicy => {
  const base = policy.assets[assetClass];
  const override = policy.symbolOverrides[symbol.toUpperCase()];
  return override ? { ...base, ...override } : base;
};

export const tierPolicy = (policy: RiskPolicy, tier: Tier) => policy.tiers[tier];

export const jurisdictionPolicy = (policy: RiskPolicy, j: Jurisdiction) => policy.jurisdictions[j];

export const thresholdMoney = (value: string, currency: string): Money => Money.of(value, currency);

export const asDecimal = (value: string): Decimal => D(value);

/** Sanity checks a policy must satisfy before it can go live. Used by tests
 *  and by the admin console's policy-promotion workflow. */
export const validatePolicy = (policy: RiskPolicy): string[] => {
  const errors: string[] = [];
  const t = policy.thresholds;
  const ladder: [string, string][] = [
    ['maxOriginationLtv', t.maxOriginationLtv],
    ['watchLtv', t.watchLtv],
    ['restrictedLtv', t.restrictedLtv],
    ['remediationLtv', t.remediationLtv],
    ['liquidationLtv', t.liquidationLtv],
  ];
  for (let i = 1; i < ladder.length; i++) {
    const prev = ladder[i - 1]!, cur = ladder[i]!;
    if (D(cur[1]).lte(D(prev[1]))) errors.push(`thresholds.${cur[0]} (${cur[1]}) must exceed ${prev[0]} (${prev[1]})`);
  }
  if (D(t.liquidationTargetLtv).gte(D(t.remediationLtv))) {
    errors.push('liquidationTargetLtv must be below remediationLtv or liquidation cannot cure a margin call');
  }
  if (D(t.liquidationLtv).gt(1)) errors.push('liquidationLtv above 1.0 means the book is already underwater');

  for (const [cls, ap] of Object.entries(policy.assets)) {
    if (D(ap.baseHaircut).gt(D(ap.maxHaircut))) errors.push(`assets.${cls}: baseHaircut exceeds maxHaircut`);
    for (const [field, v] of [['eligibilityFactor', ap.eligibilityFactor], ['baseHaircut', ap.baseHaircut], ['maxHaircut', ap.maxHaircut], ['concentrationCap', ap.concentrationCap]] as const) {
      if (D(v).lt(0) || D(v).gt(1)) errors.push(`assets.${cls}.${field} must be within [0,1], got ${v}`);
    }
  }
  for (const [tier, tp] of Object.entries(policy.tiers)) {
    if (D(tp.minCreditLimit).gt(D(tp.maxCreditLimit))) errors.push(`tiers.${tier}: minCreditLimit exceeds maxCreditLimit`);
  }
  for (const sym of policy.stablecoins.whitelist) {
    if (!policy.stablecoins.issuerBySymbol[sym]) errors.push(`stablecoins: whitelisted ${sym} has no mapped issuer`);
  }
  for (const [j, jp] of Object.entries(policy.jurisdictions)) {
    if (!jp.enabled) continue;
    for (const sym of jp.permittedStablecoins) {
      if (!policy.stablecoins.whitelist.includes(sym)) {
        errors.push(`jurisdictions.${j}: permits ${sym} which is not on the global stablecoin whitelist`);
      }
    }
  }
  if (!policy.stressScenarios.some((s) => s.id === policy.credit.baselineStressScenarioId)) {
    errors.push(`credit.baselineStressScenarioId "${policy.credit.baselineStressScenarioId}" is not a defined stress scenario`);
  }
  for (const [field, v] of [['expectedStressSurvival', policy.credit.expectedStressSurvival], ['adequateLiquidity', policy.credit.adequateLiquidity]] as const) {
    if (D(v).lte(0) || D(v).gt(1)) errors.push(`credit.${field} must be within (0,1], got ${v}`);
  }
  if (D(policy.fraud.stepUpThreshold).gte(D(policy.fraud.declineThreshold))) {
    errors.push('fraud.stepUpThreshold must be below declineThreshold');
  }
  return errors;
};
