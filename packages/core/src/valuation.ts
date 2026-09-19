/**
 * Valuation service (PRD §19.1).
 *
 * Consolidates quotes from several independent sources into one price the
 * collateral engine is allowed to lend against. The design rule is that a
 * single bad or stale feed must never be able to inflate a credit line, so:
 *   - we take the median, not the mean (one outlier cannot move it),
 *   - we measure dispersion and mark the price `disputed` when feeds disagree,
 *   - we mark the price `stale` on age and let downstream engines refuse it.
 */
import { D, Decimal, Money, ONE, ZERO } from './money.js';
import type { AssetHolding, ConsolidatedPrice, PriceQuote, ValuedAsset } from './types.js';
import { resolveAssetPolicy, type RiskPolicy } from './policy.js';

/** Feeds disagreeing by more than this relative spread mark the price disputed. */
const DEFAULT_MAX_DISPERSION = '0.02';

export interface ConsolidateOptions {
  readonly now?: Date;
  readonly maxAgeSeconds: number;
  readonly maxDispersion?: string;
  /** Sources required for an undisputed price. Below this the price is disputed. */
  readonly minSources?: number;
}

export const median = (values: readonly Decimal[]): Decimal => {
  if (values.length === 0) throw new RangeError('median of empty set');
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : sorted[mid - 1]!.plus(sorted[mid]!).dividedBy(2);
};

/**
 * Collapse many quotes for one symbol into a single decision-grade price.
 * Throws only when there is nothing at all to work with — every other failure
 * mode is expressed in the returned flags so the caller can degrade safely.
 */
export const consolidate = (
  quotes: readonly PriceQuote[],
  opts: ConsolidateOptions,
): ConsolidatedPrice => {
  if (quotes.length === 0) throw new RangeError('consolidate: no quotes supplied');

  const now = opts.now ?? new Date();
  const symbol = quotes[0]!.symbol;
  const currency = quotes[0]!.currency;
  const minSources = opts.minSources ?? 2;
  const maxDispersion = D(opts.maxDispersion ?? DEFAULT_MAX_DISPERSION);

  for (const q of quotes) {
    if (q.symbol !== symbol) throw new TypeError(`consolidate: mixed symbols ${symbol}/${q.symbol}`);
    if (q.currency !== currency) throw new TypeError(`consolidate: mixed currencies for ${symbol}`);
  }

  const ageSeconds = (q: PriceQuote) => (now.getTime() - q.asOf.getTime()) / 1000;
  const fresh = quotes.filter((q) => ageSeconds(q) <= opts.maxAgeSeconds && q.price.gt(0));

  // Fall back to every quote we have rather than throwing: the caller needs a
  // number plus the `stale` flag far more than it needs an exception.
  const usable = fresh.length > 0 ? fresh : quotes.filter((q) => q.price.gt(0));
  if (usable.length === 0) throw new RangeError(`consolidate: no positive prices for ${symbol}`);

  const prices = usable.map((q) => q.price);
  const price = median(prices);

  const lo = prices.reduce((a, b) => (a.lt(b) ? a : b));
  const hi = prices.reduce((a, b) => (a.gt(b) ? a : b));
  const dispersion = price.isZero() ? ZERO : hi.minus(lo).dividedBy(price).abs();

  // The consolidated price is only as fresh as the newest feed behind it.
  const asOf = usable.reduce((a, q) => (q.asOf > a ? q.asOf : a), usable[0]!.asOf);

  return {
    symbol,
    currency,
    price,
    asOf,
    sources: usable.map((q) => q.source),
    dispersion,
    stale: fresh.length === 0,
    disputed: dispersion.gt(maxDispersion) || usable.length < minSources,
  };
};

/** A stablecoin trading off its $1.00 peg by more than policy tolerance. */
export const isDepegged = (price: ConsolidatedPrice, policy: RiskPolicy): boolean => {
  const deviation = price.price.minus(ONE).abs();
  return deviation.gt(D(policy.stablecoins.depegThreshold));
};

export interface ValuationContext {
  /** Consolidated price by symbol, in the symbol's quote currency. */
  readonly prices: ReadonlyMap<string, ConsolidatedPrice>;
  /** FX rates into the facility currency, keyed by source currency. */
  readonly fx: ReadonlyMap<string, Decimal>;
  readonly facilityCurrency: string;
  readonly now: Date;
}

/** Convert an amount in `from` into the facility currency. */
export const convert = (amount: Decimal, from: string, ctx: ValuationContext): Decimal => {
  if (from.toUpperCase() === ctx.facilityCurrency.toUpperCase()) return amount;
  const rate = ctx.fx.get(from.toUpperCase());
  if (!rate) throw new RangeError(`no FX rate ${from} -> ${ctx.facilityCurrency}`);
  return amount.times(rate);
};

/**
 * Mark one holding to market in the facility currency.
 * Returns null when we hold no price at all for the symbol — the collateral
 * engine treats that as ineligible rather than guessing a value.
 */
export const valueHolding = (
  holding: AssetHolding,
  ctx: ValuationContext,
): ValuedAsset | null => {
  const price = ctx.prices.get(holding.symbol.toUpperCase());
  if (!price) return null;

  const quoted = holding.quantity.times(price.price);
  const inFacility = convert(quoted, price.currency, ctx);
  return {
    holding,
    price,
    marketValue: Money.of(inFacility, ctx.facilityCurrency),
  };
};

export const valuePortfolio = (
  holdings: readonly AssetHolding[],
  ctx: ValuationContext,
): { valued: ValuedAsset[]; unpriced: AssetHolding[] } => {
  const valued: ValuedAsset[] = [];
  const unpriced: AssetHolding[] = [];
  for (const h of holdings) {
    const v = valueHolding(h, ctx);
    if (v) valued.push(v);
    else unpriced.push(h);
  }
  return { valued, unpriced };
};

export const totalMarketValue = (valued: readonly ValuedAsset[], currency: string): Money =>
  valued.reduce((acc, v) => acc.plus(v.marketValue), Money.zero(currency));

/** True when the price behind this holding is too old for its asset class. */
export const isPriceStaleFor = (
  valued: ValuedAsset,
  policy: RiskPolicy,
  now: Date,
): boolean => {
  const ap = resolveAssetPolicy(policy, valued.holding.assetClass, valued.holding.symbol);
  if (valued.price.stale) return true;
  const ageSeconds = (now.getTime() - valued.price.asOf.getTime()) / 1000;
  return ageSeconds > ap.maxPriceAgeSeconds;
};

/**
 * Realized volatility from a price history, annualized, expressed as a 0..1
 * risk score. Used to make haircuts responsive to market conditions rather
 * than frozen at their policy defaults.
 */
export const realizedVolatility = (
  closes: readonly Decimal[],
  periodsPerYear = 365,
): Decimal | null => {
  if (closes.length < 3) return null;
  const returns: Decimal[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!, cur = closes[i]!;
    if (prev.lte(0)) continue;
    // Simple returns are adequate here and avoid a log implementation that
    // would drop us out of Decimal precision.
    returns.push(cur.minus(prev).dividedBy(prev));
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((a, r) => a.plus(r), ZERO).dividedBy(returns.length);
  const variance = returns
    .reduce((a, r) => a.plus(r.minus(mean).pow(2)), ZERO)
    .dividedBy(returns.length - 1);
  const annualized = variance.times(periodsPerYear).sqrt();

  // Clamp into the 0..1 score the policy engine expects. 200% annualized
  // volatility and above all read as "maximum risk".
  return annualized.gt(2) ? ONE : annualized.dividedBy(2);
};
