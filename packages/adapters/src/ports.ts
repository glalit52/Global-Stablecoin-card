/**
 * Partner ports (PRD §18.2).
 *
 * The launch model is partner-first: the company owns the brand, the wealth
 * graph, the engines and the AI, while licensed partners provide card issuing,
 * lending, custody, KYC and stablecoin rails. PRD §28 also names partner
 * dependency as a High severity risk whose mitigation is a "multi-provider
 * architecture".
 *
 * Both of those are the same engineering requirement: every regulated function
 * sits behind an interface defined *by us*, in our vocabulary. Swapping a
 * processor becomes a new implementation of a port rather than a rewrite, and
 * nothing in the domain core ever learns a vendor's name.
 *
 * Every port method is idempotent on an explicit key. Payment and settlement
 * operations get retried by networks that do not ask permission first.
 */
import type { Decimal, Money } from '@wealthcard/core';
import type {
  AssetClass, CardControls, CardForm, CardNetwork, CardStatus, Jurisdiction,
  KycStatus, PriceQuote,
} from '@wealthcard/core';

/** Raised when a partner is reachable but refuses the request. */
export class PartnerError extends Error {
  constructor(
    readonly partner: string,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`[${partner}:${code}] ${message}`);
    this.name = 'PartnerError';
  }
}

/** Raised when a partner cannot be reached or does not answer in time. */
export class PartnerUnavailableError extends PartnerError {
  constructor(partner: string, message: string) {
    super(partner, 'unavailable', message, true);
    this.name = 'PartnerUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Identity & KYC (PRD §19.1 Identity & KYC Service)
// ---------------------------------------------------------------------------

export interface KycApplicant {
  readonly customerId: string;
  readonly legalName: string;
  readonly dateOfBirth: string;
  readonly email: string;
  readonly jurisdiction: Jurisdiction;
  readonly addressCountry: string;
  readonly documentType?: 'passport' | 'drivers_license' | 'national_id';
  readonly documentNumber?: string;
}

export interface KycResult {
  readonly status: KycStatus;
  readonly reference: string;
  readonly sanctionsClear: boolean;
  readonly pepMatch: boolean;
  readonly adverseMedia: boolean;
  /** 0..1, higher = riskier. Feeds the underwriting fraud score. */
  readonly riskScore: Decimal;
  readonly reasons: readonly string[];
  readonly checkedAt: Date;
}

export interface KycProvider {
  readonly name: string;
  submit(applicant: KycApplicant, idempotencyKey: string): Promise<KycResult>;
  get(reference: string): Promise<KycResult | null>;
  /** Periodic re-screening against sanctions and PEP lists. */
  rescreen(reference: string): Promise<KycResult>;
}

// ---------------------------------------------------------------------------
// Card issuing & processing (PRD §13.1)
// ---------------------------------------------------------------------------

export interface IssueCardRequest {
  readonly customerId: string;
  readonly form: CardForm;
  readonly network: CardNetwork;
  readonly nameOnCard: string;
  readonly shippingAddress?: string;
}

export interface IssuedCard {
  readonly partnerCardId: string;
  /** Network token reference. The PAN itself never enters our systems. */
  readonly tokenReference: string;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
  readonly status: CardStatus;
}

/** Sensitive card details, fetched on demand and never stored. */
export interface CardSecrets {
  readonly pan: string;
  readonly cvv: string;
  readonly expMonth: number;
  readonly expYear: number;
}

export interface CardIssuer {
  readonly name: string;
  issue(req: IssueCardRequest, idempotencyKey: string): Promise<IssuedCard>;
  setStatus(partnerCardId: string, status: CardStatus, idempotencyKey: string): Promise<void>;
  updateControls(partnerCardId: string, controls: CardControls, idempotencyKey: string): Promise<void>;
  /** Returns PAN/CVV for in-app display. Always an explicit, audited call. */
  reveal(partnerCardId: string, customerId: string): Promise<CardSecrets>;
  provisionWallet(partnerCardId: string, wallet: 'apple_pay' | 'google_pay', idempotencyKey: string): Promise<{ activationData: string }>;
}

// ---------------------------------------------------------------------------
// Crypto custody (PRD §18.1)
// ---------------------------------------------------------------------------

export interface CustodyBalance {
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly quantity: Decimal;
  readonly availableQuantity: Decimal;
  /** Quantity pledged and locked against the credit facility. */
  readonly pledgedQuantity: Decimal;
  readonly asOf: Date;
}

export interface PledgeResult {
  readonly pledgeId: string;
  readonly symbol: string;
  readonly quantity: Decimal;
  readonly confirmedAt: Date;
}

export interface LiquidationFill {
  readonly fillId: string;
  readonly symbol: string;
  readonly quantity: Decimal;
  readonly executedPrice: Decimal;
  readonly grossProceeds: Money;
  readonly fees: Money;
  readonly netProceeds: Money;
  readonly venue: string;
  readonly executedAt: Date;
}

export interface CustodyProvider {
  readonly name: string;
  listBalances(custodyAccountId: string): Promise<CustodyBalance[]>;
  /** Lock collateral so it cannot be withdrawn while it backs credit. */
  pledge(custodyAccountId: string, symbol: string, quantity: Decimal, idempotencyKey: string): Promise<PledgeResult>;
  release(custodyAccountId: string, pledgeId: string, quantity: Decimal, idempotencyKey: string): Promise<void>;
  /** Execute a forced sale. Must be idempotent: a double-sell is unrecoverable. */
  liquidate(custodyAccountId: string, symbol: string, quantity: Decimal, idempotencyKey: string): Promise<LiquidationFill>;
  /** Prove the customer controls a self-custodied address. */
  verifyAddressOwnership(address: string, signature: string, challenge: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Market data (PRD §19.1 Valuation Service)
// ---------------------------------------------------------------------------

export interface MarketDataProvider {
  readonly name: string;
  /** One quote per symbol, from this source only. Consolidation is ours. */
  quotes(symbols: readonly string[]): Promise<PriceQuote[]>;
  /** Closing prices, newest last. Feeds realized-volatility haircuts. */
  history(symbol: string, days: number): Promise<Decimal[]>;
  fxRates(base: string, quotes: readonly string[]): Promise<Map<string, Decimal>>;
}

// ---------------------------------------------------------------------------
// Stablecoin settlement (PRD §14)
// ---------------------------------------------------------------------------

export interface StablecoinTransfer {
  readonly transferId: string;
  readonly symbol: string;
  readonly amount: Decimal;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly txHash: string;
  readonly networkFee: Money;
  readonly status: 'pending' | 'confirmed' | 'failed';
  readonly confirmations: number;
  readonly screenedClear: boolean;
  readonly submittedAt: Date;
}

export interface StablecoinRail {
  readonly name: string;
  /** Screening runs before value moves, not after (PRD §14.1 Travel Rule). */
  screenAddress(address: string, symbol: string): Promise<{ clear: boolean; riskScore: Decimal; reasons: string[] }>;
  send(symbol: string, amount: Decimal, toAddress: string, idempotencyKey: string): Promise<StablecoinTransfer>;
  get(transferId: string): Promise<StablecoinTransfer | null>;
  /** Live peg observation, for the depeg monitor. */
  pegStatus(symbol: string): Promise<{ price: Decimal; depegged: boolean; asOf: Date }>;
}

// ---------------------------------------------------------------------------
// Lending partner (PRD §18.2)
// ---------------------------------------------------------------------------

export interface FundingDraw {
  readonly drawId: string;
  readonly amount: Money;
  readonly status: 'pending' | 'funded' | 'rejected';
  readonly fundedAt: Date | null;
}

export interface LendingPartner {
  readonly name: string;
  /** Notify the lender of a limit we intend to grant. They may cap it. */
  registerFacility(customerId: string, requestedLimit: Money, idempotencyKey: string): Promise<{ approvedLimit: Money; partnerFacilityId: string }>;
  draw(partnerFacilityId: string, amount: Money, idempotencyKey: string): Promise<FundingDraw>;
  repay(partnerFacilityId: string, amount: Money, idempotencyKey: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Notifications (PRD §19.1 Notification Service)
// ---------------------------------------------------------------------------

export type NotificationChannel = 'push' | 'email' | 'sms' | 'in_app';

export interface NotificationRequest {
  readonly customerId: string;
  readonly channel: NotificationChannel;
  readonly title: string;
  readonly body: string;
  readonly deepLink?: string;
  /** Critical notices bypass quiet hours and per-customer throttles. */
  readonly critical: boolean;
}

export interface Notifier {
  readonly name: string;
  send(req: NotificationRequest, idempotencyKey: string): Promise<{ delivered: boolean; messageId: string }>;
}

/** Everything the application layer needs from the outside world. */
export interface PartnerRegistry {
  readonly kyc: KycProvider;
  readonly issuer: CardIssuer;
  readonly custody: CustodyProvider;
  readonly marketData: readonly MarketDataProvider[];
  readonly stablecoin: StablecoinRail;
  readonly lender: LendingPartner;
  readonly notifier: Notifier;
}
