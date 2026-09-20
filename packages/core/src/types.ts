/** Shared domain vocabulary for the Global Wealth Card platform. */
import type { Decimal } from './money.js';
import type { Money } from './money.js';

// ---------------------------------------------------------------------------
// Identity & customer
// ---------------------------------------------------------------------------

export type Jurisdiction = 'US' | 'GB' | 'EU' | 'AE' | 'SG' | 'CH' | 'IN' | 'CA' | 'AU';

export type KycStatus = 'not_started' | 'pending' | 'in_review' | 'approved' | 'rejected' | 'expired';

export type CustomerStatus = 'prospect' | 'active' | 'restricted' | 'suspended' | 'closed';

/** Product tiers from PRD §15.1. */
export type Tier = 'WEALTH' | 'WEALTH_PLUS' | 'PRIVATE' | 'ULTRA';

export const TIER_ORDER: readonly Tier[] = ['WEALTH', 'WEALTH_PLUS', 'PRIVATE', 'ULTRA'] as const;

// ---------------------------------------------------------------------------
// Wealth graph (PRD §9)
// ---------------------------------------------------------------------------

export type AssetClass =
  | 'BTC'
  | 'ETH'
  | 'STABLECOIN'
  | 'EQUITY'
  | 'ETF'
  | 'BOND'
  | 'CASH'
  | 'OTHER_TOKEN';

export type CustodyModel = 'institutional_custodian' | 'self_custody_verified' | 'exchange' | 'broker' | 'bank';

/** How an asset's existence and ownership was established. */
export type VerificationMethod = 'onchain_signature' | 'onchain_balance' | 'custodian_api' | 'broker_api' | 'bank_aggregation' | 'manual_review';

export interface AssetHolding {
  readonly assetId: string;
  readonly customerId: string;
  readonly assetClass: AssetClass;
  /** Ticker or on-chain symbol: BTC, USDC, AAPL, VOO. */
  readonly symbol: string;
  readonly custodian: string;
  readonly custodyModel: CustodyModel;
  /** Units held, exact. */
  readonly quantity: Decimal;
  /** Unit of account the symbol is priced in. */
  readonly quoteCurrency: string;
  readonly verification: VerificationMethod;
  readonly lastVerifiedAt: Date;
  /** Customer explicitly pledged this asset as collateral. */
  readonly pledged: boolean;
  /** Set when the customer or ops has frozen the holding from collateral use. */
  readonly excluded?: boolean;
  readonly excludedReason?: string;
}

// ---------------------------------------------------------------------------
// Valuation (PRD §19 Valuation Service)
// ---------------------------------------------------------------------------

export interface PriceQuote {
  readonly symbol: string;
  readonly currency: string;
  readonly price: Decimal;
  readonly asOf: Date;
  readonly source: string;
}

/** A price agreed by the oracle, carrying its provenance for disclosure. */
export interface ConsolidatedPrice {
  readonly symbol: string;
  readonly currency: string;
  readonly price: Decimal;
  readonly asOf: Date;
  readonly sources: readonly string[];
  /** Max relative spread between contributing sources. */
  readonly dispersion: Decimal;
  readonly stale: boolean;
  /** Set when sources disagree beyond policy tolerance. */
  readonly disputed: boolean;
}

export interface ValuedAsset {
  readonly holding: AssetHolding;
  readonly price: ConsolidatedPrice;
  readonly marketValue: Money;
}

// ---------------------------------------------------------------------------
// Collateral (PRD §10)
// ---------------------------------------------------------------------------

export type IneligibilityReason =
  | 'not_pledged'
  | 'excluded_by_customer'
  | 'asset_class_not_eligible'
  | 'symbol_not_whitelisted'
  | 'jurisdiction_restricted'
  | 'stale_price'
  | 'disputed_price'
  | 'verification_expired'
  | 'custody_model_not_eligible'
  | 'depeg_detected'
  | 'below_dust_threshold';

export interface CollateralPosition {
  readonly assetId: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly quantity: Decimal;
  readonly marketValue: Money;
  /** Policy factor applied to this asset class/symbol, 0..1. */
  readonly eligibilityFactor: Decimal;
  /** Volatility-adjusted haircut, 0..1. */
  readonly haircut: Decimal;
  /** Liquidity adjustment, 0..1, reflecting depth vs. position size. */
  readonly liquidityAdjustment: Decimal;
  /** Reduction applied because this asset is over the concentration cap, 0..1. */
  readonly concentrationAdjustment: Decimal;
  /** MarketValue x factor x (1-haircut) x liquidity x concentration. */
  readonly eligibleValue: Money;
  /** Share of total eligible collateral, 0..1. */
  readonly concentration: Decimal;
  readonly eligible: boolean;
  readonly ineligibilityReasons: readonly IneligibilityReason[];
  readonly priceAsOf: Date;
}

export interface CollateralSummary {
  readonly customerId: string;
  readonly currency: string;
  readonly totalMarketValue: Money;
  readonly eligibleCollateralValue: Money;
  readonly positions: readonly CollateralPosition[];
  /** Largest single-asset share of eligible collateral, 0..1. */
  readonly topConcentration: Decimal;
  /** Weighted mean volatility score across eligible collateral, 0..1. */
  readonly weightedVolatility: Decimal;
  /** Weighted mean liquidity score across eligible collateral, 0..1 (higher = more liquid). */
  readonly weightedLiquidity: Decimal;
  /** True when a per-asset or per-issuer cap actually cut a position. When it
   *  did, concentration has already been priced and the credit engine must not
   *  charge for it a second time. */
  readonly concentrationCapBinding: boolean;
  readonly policyVersion: string;
  readonly computedAt: Date;
  /** True when any contributing price was stale or disputed. */
  readonly degraded: boolean;
}

// ---------------------------------------------------------------------------
// Credit (PRD §11)
// ---------------------------------------------------------------------------

export type FacilityStatus = 'pending' | 'active' | 'restricted' | 'frozen' | 'closed' | 'defaulted';

export interface CreditFacility {
  readonly facilityId: string;
  readonly customerId: string;
  readonly currency: string;
  readonly creditLimit: Money;
  /** Settled principal drawn. */
  readonly principalBalance: Money;
  /** Accrued, unpaid interest. */
  readonly interestBalance: Money;
  /** Accrued, unpaid fees. */
  readonly feeBalance: Money;
  /** Approved-but-unsettled authorizations. */
  readonly holdsTotal: Money;
  readonly aprBps: number;
  readonly status: FacilityStatus;
  readonly openedAt: Date;
}

/** Every multiplicative term in the PRD §11.2 formula, kept for explainability. */
export interface CreditFactorBreakdown {
  readonly baseCollateralCapacity: Money;
  /** Capacity after every adjustment and cap, rounded down to the tier step.
   *  The decision's explanations quote this figure, so it has to be
   *  disclosable in its own right. */
  readonly steppedCapacity: Money;
  readonly advanceRate: Decimal;
  readonly portfolioRiskAdjustment: Decimal;
  readonly liquidityAdjustment: Decimal;
  readonly concentrationAdjustment: Decimal;
  readonly customerAdjustment: Decimal;
  readonly tierCap: Money;
  readonly jurisdictionCap: Money;
  readonly existingExposure: Money;
}

export interface CreditDecision {
  readonly customerId: string;
  readonly currency: string;
  readonly approved: boolean;
  readonly creditLimit: Money;
  readonly previousLimit: Money | null;
  readonly breakdown: CreditFactorBreakdown;
  readonly declineReasons: readonly string[];
  /** Human-readable, ordered contribution notes for the AI agent and UI. */
  readonly explanations: readonly string[];
  readonly policyVersion: string;
  readonly decidedAt: Date;
}

export interface UnderwritingInputs {
  readonly kycStatus: KycStatus;
  readonly customerStatus: CustomerStatus;
  readonly jurisdiction: Jurisdiction;
  readonly tier: Tier;
  readonly sanctionsClear: boolean;
  readonly pepReviewCleared: boolean;
  /** Months since account opened. */
  readonly tenureMonths: number;
  /** 0..1, higher = worse. From the fraud engine. */
  readonly fraudScore: Decimal;
  /** Count of payments 30+ days late in the last 24 months. */
  readonly delinquencies30d: number;
  /** Share of statements paid on or before due date, 0..1. Null when no history. */
  readonly onTimeRate: Decimal | null;
  /** Verified monthly income where legally collectable. Null when unavailable. */
  readonly monthlyIncome: Money | null;
  /** Known debt outside this facility. */
  readonly externalMonthlyDebtService: Money | null;
}

// ---------------------------------------------------------------------------
// Risk (PRD §12)
// ---------------------------------------------------------------------------

/** PRD §11.3 limit states, in increasing severity. */
export type RiskState = 'healthy' | 'watch' | 'restricted' | 'remediation' | 'liquidation';

export const RISK_STATE_ORDER: readonly RiskState[] = ['healthy', 'watch', 'restricted', 'remediation', 'liquidation'] as const;

export interface RiskSnapshot {
  readonly customerId: string;
  readonly currency: string;
  /** Total debt / total collateral market value. */
  readonly grossLtv: Decimal | null;
  /** Total debt / eligible (haircut) collateral value. The binding measure. */
  readonly effectiveLtv: Decimal | null;
  /** (eligibleCollateral x liquidationThreshold) / debt. >1 is safe. Null when no debt. */
  readonly healthFactor: Decimal | null;
  /** 0..100 display health, derived from headroom to the liquidation threshold. */
  readonly healthPercent: Decimal;
  readonly state: RiskState;
  readonly totalDebt: Money;
  readonly eligibleCollateralValue: Money;
  readonly totalMarketValue: Money;
  readonly topConcentration: Decimal;
  /** Collateral that could be withdrawn while staying in `healthy`. */
  readonly withdrawableCollateral: Money;
  /** Additional spend available before crossing into `watch`. */
  readonly safeSpendCapacity: Money;
  readonly triggeredRules: readonly string[];
  readonly degraded: boolean;
  readonly policyVersion: string;
  readonly computedAt: Date;
}

export interface StressScenario {
  readonly id: string;
  readonly label: string;
  /** Multiplicative price shocks by asset class, e.g. { BTC: -0.4 }. */
  readonly shocks: Readonly<Partial<Record<AssetClass, string>>>;
  /** Extra haircut added to every position, e.g. liquidity deterioration. */
  readonly liquidityShock?: string;
  /** Stablecoin depeg level, e.g. "0.90" means USDC marks at $0.90. */
  readonly stablecoinPeg?: string;
}

export interface StressResult {
  readonly scenario: StressScenario;
  readonly eligibleCollateralValue: Money;
  readonly effectiveLtv: Decimal | null;
  readonly healthFactor: Decimal | null;
  readonly state: RiskState;
  readonly collateralShortfall: Money;
  readonly survives: boolean;
}

// ---------------------------------------------------------------------------
// Liquidation (PRD §12.3)
// ---------------------------------------------------------------------------

export interface LiquidationLot {
  readonly assetId: string;
  readonly symbol: string;
  readonly quantity: Decimal;
  readonly estimatedPrice: Decimal;
  readonly grossProceeds: Money;
  readonly estimatedSlippage: Money;
  readonly estimatedFees: Money;
  readonly netProceeds: Money;
  readonly reason: string;
}

export interface LiquidationPlan {
  readonly customerId: string;
  readonly currency: string;
  readonly triggeredBy: string;
  readonly targetLtv: Decimal;
  readonly debtBefore: Money;
  readonly collateralBefore: Money;
  readonly lots: readonly LiquidationLot[];
  readonly totalNetProceeds: Money;
  readonly projectedDebtAfter: Money;
  readonly projectedCollateralAfter: Money;
  readonly projectedLtvAfter: Decimal | null;
  readonly sufficient: boolean;
  readonly policyVersion: string;
  readonly plannedAt: Date;
}

// ---------------------------------------------------------------------------
// Card & payments (PRD §13)
// ---------------------------------------------------------------------------

export type CardStatus = 'requested' | 'inactive' | 'active' | 'frozen' | 'expired' | 'cancelled' | 'lost_stolen';
export type CardForm = 'virtual' | 'physical';
export type CardNetwork = 'visa' | 'mastercard';

export interface CardControls {
  /** Blocked merchant category codes. */
  readonly blockedMccs: readonly string[];
  /** ISO-3166 alpha-2 country allowlist. Empty = all allowed. */
  readonly allowedCountries: readonly string[];
  readonly blockedCountries: readonly string[];
  readonly atmEnabled: boolean;
  readonly onlineEnabled: boolean;
  readonly contactlessEnabled: boolean;
  readonly internationalEnabled: boolean;
  /** Per-transaction ceiling in the billing currency. Null = no card-level cap. */
  readonly perTransactionLimit: Money | null;
  readonly dailyLimit: Money | null;
  readonly monthlyLimit: Money | null;
}

export interface Card {
  readonly cardId: string;
  readonly customerId: string;
  readonly network: CardNetwork;
  readonly form: CardForm;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
  readonly status: CardStatus;
  readonly controls: CardControls;
  readonly walletProvisioned: readonly ('apple_pay' | 'google_pay')[];
}

export type MerchantCategory =
  | 'groceries' | 'fuel_ev' | 'dining' | 'travel' | 'hotels' | 'lounges'
  | 'retail' | 'ecommerce' | 'subscriptions' | 'utilities' | 'transit'
  | 'cash_advance' | 'crypto' | 'gambling' | 'other';

export interface AuthorizationRequest {
  readonly requestId: string;
  readonly cardId: string;
  readonly amount: Money;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly mcc: string;
  readonly merchantCountry: string;
  readonly merchantCity?: string;
  /** Card-present tap, e-commerce, ATM, etc. */
  readonly entryMode: 'contactless' | 'chip' | 'ecommerce' | 'atm' | 'wallet' | 'manual';
  readonly isRecurring: boolean;
  readonly requestedAt: Date;
  readonly deviceId?: string;
  /** Approximate transaction geography for the fraud engine. */
  readonly geo?: { lat: number; lon: number };
}

export type DeclineCode =
  | '05_do_not_honor'
  | '51_insufficient_funds'
  | '54_expired_card'
  | '57_txn_not_permitted'
  | '59_suspected_fraud'
  | '61_exceeds_limit'
  | '62_restricted_card'
  | '65_exceeds_frequency'
  | '78_card_not_active'
  | '96_system_error';

export interface AuthorizationDecision {
  readonly requestId: string;
  readonly approved: boolean;
  readonly authorizationId: string | null;
  /** Amount held against the facility, in billing currency. */
  readonly billingAmount: Money;
  readonly fxRate: Decimal | null;
  readonly fxFee: Money;
  readonly declineCode: DeclineCode | null;
  readonly declineReason: string | null;
  /** Ordered trace of every check that ran — the audit record. */
  readonly checks: readonly AuthorizationCheck[];
  readonly fraudScore: Decimal;
  readonly availableCreditAfter: Money;
  readonly decidedAt: Date;
  readonly latencyMs: number;
}

export interface AuthorizationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export type TransactionStatus = 'pending' | 'settled' | 'reversed' | 'declined' | 'disputed' | 'refunded' | 'expired';

export interface CardTransaction {
  readonly transactionId: string;
  readonly customerId: string;
  readonly cardId: string;
  readonly authorizationId: string | null;
  readonly status: TransactionStatus;
  readonly merchantName: string;
  readonly mcc: string;
  readonly category: MerchantCategory;
  readonly merchantCountry: string;
  /** What the merchant charged, in their currency. */
  readonly originalAmount: Money;
  /** What we posted to the facility. */
  readonly billingAmount: Money;
  readonly fxRate: Decimal | null;
  readonly fxFee: Money;
  readonly authorizedAt: Date;
  readonly settledAt: Date | null;
}

// ---------------------------------------------------------------------------
// Rewards (PRD §15)
// ---------------------------------------------------------------------------

export type RewardEntryType = 'earn_pending' | 'earn_posted' | 'reversal' | 'redemption' | 'adjustment' | 'expiry';

export interface RewardEntry {
  readonly entryId: string;
  readonly customerId: string;
  readonly type: RewardEntryType;
  readonly points: Decimal;
  readonly transactionId: string | null;
  readonly category: MerchantCategory | null;
  readonly rateApplied: Decimal | null;
  readonly description: string;
  readonly occurredAt: Date;
}

export type RedemptionKind = 'statement_credit' | 'travel' | 'crypto' | 'transfer_partner';

// ---------------------------------------------------------------------------
// Alerts (PRD §21 GET /alerts)
// ---------------------------------------------------------------------------

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertKind =
  | 'risk_state_change' | 'margin_call' | 'liquidation_warning' | 'liquidation_executed'
  | 'concentration' | 'depeg' | 'price_stale' | 'fraud' | 'payment_due' | 'payment_received'
  | 'limit_change' | 'card_control' | 'kyc';

export interface Alert {
  readonly alertId: string;
  readonly customerId: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string | null;
  readonly actionHref: string | null;
  readonly status: 'open' | 'acknowledged' | 'resolved';
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Audit (PRD §17.3, §22)
// ---------------------------------------------------------------------------

export interface AuditRecord {
  readonly auditId: string;
  readonly actorType: 'customer' | 'operator' | 'system' | 'partner';
  readonly actorId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly policyVersion: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
}
