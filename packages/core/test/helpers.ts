import {
  D, Decimal, Money, type AssetHolding, type ConsolidatedPrice, type CreditFacility,
  type Jurisdiction, type UnderwritingInputs, type ValuationContext, type Card,
  type CardControls, type Tier,
} from '../src/index.js';

export const T0 = new Date('2026-06-01T12:00:00.000Z');

export const price = (
  symbol: string, value: string, asOf: Date = T0,
  opts: Partial<ConsolidatedPrice> = {},
): ConsolidatedPrice => ({
  symbol, currency: 'USD', price: D(value), asOf,
  sources: ['alpha', 'beta'], dispersion: D('0.001'),
  stale: false, disputed: false, ...opts,
});

export const holding = (
  over: Partial<AssetHolding> & Pick<AssetHolding, 'symbol' | 'assetClass' | 'quantity'>,
): AssetHolding => ({
  assetId: `asset_${over.symbol}`,
  customerId: 'cust_1',
  custodian: 'anchorage',
  custodyModel: 'institutional_custodian',
  quoteCurrency: 'USD',
  verification: 'custodian_api',
  lastVerifiedAt: T0,
  pledged: true,
  ...over,
});

export const ctx = (
  prices: ConsolidatedPrice[], now: Date = T0,
): ValuationContext => ({
  prices: new Map(prices.map((p) => [p.symbol.toUpperCase(), p])),
  fx: new Map([['EUR', D('1.08')], ['GBP', D('1.27')], ['AED', D('0.2723')], ['SGD', D('0.74')]]),
  facilityCurrency: 'USD',
  now,
});

export const facility = (over: Partial<CreditFacility> = {}): CreditFacility => ({
  facilityId: 'fac_1',
  customerId: 'cust_1',
  currency: 'USD',
  creditLimit: Money.of('100000', 'USD'),
  principalBalance: Money.zero('USD'),
  interestBalance: Money.zero('USD'),
  feeBalance: Money.zero('USD'),
  holdsTotal: Money.zero('USD'),
  aprBps: 1150,
  status: 'active',
  openedAt: new Date('2025-01-01T00:00:00.000Z'),
  ...over,
});

export const underwriting = (over: Partial<UnderwritingInputs> = {}): UnderwritingInputs => ({
  kycStatus: 'approved',
  customerStatus: 'active',
  jurisdiction: 'US' as Jurisdiction,
  tier: 'PRIVATE' as Tier,
  sanctionsClear: true,
  pepReviewCleared: true,
  tenureMonths: 24,
  fraudScore: D('0'),
  delinquencies30d: 0,
  onTimeRate: D('1'),
  monthlyIncome: null,
  externalMonthlyDebtService: null,
  ...over,
});

export const controls = (over: Partial<CardControls> = {}): CardControls => ({
  blockedMccs: [],
  allowedCountries: [],
  blockedCountries: [],
  atmEnabled: true,
  onlineEnabled: true,
  contactlessEnabled: true,
  internationalEnabled: true,
  perTransactionLimit: null,
  dailyLimit: null,
  monthlyLimit: null,
  ...over,
});

export const card = (over: Partial<Card> = {}): Card => ({
  cardId: 'card_1',
  customerId: 'cust_1',
  network: 'visa',
  form: 'physical',
  last4: '4242',
  expMonth: 12,
  expYear: 2030,
  status: 'active',
  controls: controls(),
  walletProvisioned: ['apple_pay'],
  ...over,
});

export const usd = (v: string) => Money.of(v, 'USD');
export const dec = (v: string) => D(v);
export type { Decimal };
