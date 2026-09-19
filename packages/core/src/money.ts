/**
 * Money and decimal primitives.
 *
 * Rule of the house: money and asset quantities NEVER touch a JS number.
 * Everything is a Decimal internally and a string at every boundary
 * (database, HTTP, logs). Floats are banned in this codebase for value.
 */
import Decimal from 'decimal.js';

// 34 significant digits covers 18-dp crypto quantities times large prices
// without intermediate precision loss. ROUND_HALF_EVEN (banker's rounding)
// avoids the systematic upward bias of HALF_UP across millions of postings.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -30, toExpPos: 40 });

export { Decimal };

/** Anything that can be widened into a Decimal. */
export type Numeric = Decimal | string | number;

export const D = (v: Numeric): Decimal => (v instanceof Decimal ? v : new Decimal(v));

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

/** ISO-4217 code (USD) or an asset symbol used as a unit of account (BTC). */
export type Currency = string;

/** Minor-unit scale per currency. Anything unlisted settles at 2dp. */
const CURRENCY_SCALE: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, CHF: 2, SGD: 2, AED: 2, CAD: 2, AUD: 2, INR: 2,
  JPY: 0, KRW: 0,
  BTC: 8, ETH: 18, USDC: 6, USDT: 6, PYUSD: 6,
};

export const scaleOf = (currency: Currency): number => CURRENCY_SCALE[currency.toUpperCase()] ?? 2;

/**
 * An exact monetary amount tagged with its unit of account.
 * Immutable: every operation returns a new Money.
 */
export class Money {
  readonly amount: Decimal;
  readonly currency: Currency;

  private constructor(amount: Decimal, currency: Currency) {
    this.amount = amount;
    this.currency = currency.toUpperCase();
  }

  static of(amount: Numeric, currency: Currency): Money {
    const d = D(amount);
    if (!d.isFinite()) throw new TypeError(`Money.of: non-finite amount "${String(amount)}"`);
    return new Money(d, currency);
  }

  static zero(currency: Currency): Money {
    return new Money(ZERO, currency);
  }

  private assertSame(other: Money, op: string): void {
    if (this.currency !== other.currency) {
      throw new TypeError(`Money.${op}: currency mismatch ${this.currency} vs ${other.currency}`);
    }
  }

  plus(other: Money): Money {
    this.assertSame(other, 'plus');
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  minus(other: Money): Money {
    this.assertSame(other, 'minus');
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  times(factor: Numeric): Money {
    return new Money(this.amount.times(D(factor)), this.currency);
  }

  dividedBy(divisor: Numeric): Money {
    const d = D(divisor);
    if (d.isZero()) throw new RangeError('Money.dividedBy: division by zero');
    return new Money(this.amount.dividedBy(d), this.currency);
  }

  negated(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  /** Clamp to >= 0. Used wherever a negative would be nonsense (available credit). */
  clampPositive(): Money {
    return this.amount.isNegative() ? Money.zero(this.currency) : this;
  }

  min(other: Money): Money {
    this.assertSame(other, 'min');
    return this.amount.lte(other.amount) ? this : other;
  }

  max(other: Money): Money {
    this.assertSame(other, 'max');
    return this.amount.gte(other.amount) ? this : other;
  }

  /** Round to the currency's settlement scale. */
  round(rounding: Decimal.Rounding = Decimal.ROUND_HALF_EVEN): Money {
    return new Money(this.amount.toDecimalPlaces(scaleOf(this.currency), rounding), this.currency);
  }

  /** Round DOWN to the currency scale — the correct direction for credit we grant. */
  roundDown(): Money {
    return this.round(Decimal.ROUND_FLOOR);
  }

  /** Round UP to the currency scale — the correct direction for debt we collect. */
  roundUp(): Money {
    return this.round(Decimal.ROUND_CEIL);
  }

  /** Round down to a whole multiple of `step` (credit limits land on clean numbers). */
  roundDownToStep(step: Numeric): Money {
    const s = D(step);
    if (s.lte(0)) throw new RangeError('Money.roundDownToStep: step must be positive');
    return new Money(this.amount.dividedBy(s).floor().times(s), this.currency);
  }

  isZero(): boolean { return this.amount.isZero(); }
  isPositive(): boolean { return this.amount.gt(0); }
  isNegative(): boolean { return this.amount.isNegative(); }
  gt(other: Money): boolean { this.assertSame(other, 'gt'); return this.amount.gt(other.amount); }
  gte(other: Money): boolean { this.assertSame(other, 'gte'); return this.amount.gte(other.amount); }
  lt(other: Money): boolean { this.assertSame(other, 'lt'); return this.amount.lt(other.amount); }
  lte(other: Money): boolean { this.assertSame(other, 'lte'); return this.amount.lte(other.amount); }
  eq(other: Money): boolean { this.assertSame(other, 'eq'); return this.amount.eq(other.amount); }

  /** Exact decimal string at full precision — the database representation. */
  toString(): string { return this.amount.toFixed(); }

  /** Fixed at the currency scale — the API/display representation. */
  toFixedString(): string { return this.amount.toDecimalPlaces(scaleOf(this.currency)).toFixed(scaleOf(this.currency)); }

  toJSON(): { amount: string; currency: Currency } {
    return { amount: this.toFixedString(), currency: this.currency };
  }

  /** Convert at an explicit rate. The caller is responsible for rate provenance. */
  convertTo(currency: Currency, rate: Numeric): Money {
    return new Money(this.amount.times(D(rate)), currency);
  }
}

export const sumMoney = (items: readonly Money[], currency: Currency): Money =>
  items.reduce((acc, m) => acc.plus(m), Money.zero(currency));

/**
 * Safe ratio: returns null instead of Infinity/NaN when the denominator is zero.
 * Callers must decide what "no denominator" means in their domain — silently
 * returning 0 or Infinity here is how risk engines get things wrong.
 */
export const ratio = (numerator: Money, denominator: Money): Decimal | null => {
  if (denominator.isZero()) return null;
  return numerator.amount.dividedBy(denominator.amount);
};

/** Clamp a Decimal into [min, max]. */
export const clamp = (value: Numeric, min: Numeric, max: Numeric): Decimal => {
  const v = D(value), lo = D(min), hi = D(max);
  if (lo.gt(hi)) throw new RangeError('clamp: min > max');
  return v.lt(lo) ? lo : v.gt(hi) ? hi : v;
};

/** Basis points -> decimal fraction. 250 bps => 0.025 */
export const bps = (n: Numeric): Decimal => D(n).dividedBy(10_000);

/** Format a Decimal fraction as a percent string for display/explanations. */
export const pct = (fraction: Numeric, dp = 1): string => `${D(fraction).times(100).toDecimalPlaces(dp).toFixed(dp)}%`;
