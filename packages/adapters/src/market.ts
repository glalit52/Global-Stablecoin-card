/**
 * Market simulator.
 *
 * Drives the sandbox price feeds. Deterministic given a seed, so a stress
 * demo or a failing test can be replayed exactly. The API and the simulator
 * share one instance in-process, which is what lets a scripted BTC crash
 * actually move a customer through the risk ladder end to end.
 */
import { D, Decimal } from '@wealthcard/core';

/** mulberry32 — small, fast, and reproducible from a seed. */
const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface AssetSpec {
  readonly symbol: string;
  readonly initialPrice: string;
  /** Annualised drift, e.g. "0.15" for +15%/yr. */
  readonly drift: string;
  /** Annualised volatility, e.g. "0.55". */
  readonly volatility: string;
  /** Pegged assets mean-revert to this level instead of drifting. */
  readonly peg?: string;
}

const DEFAULT_ASSETS: readonly AssetSpec[] = [
  { symbol: 'BTC', initialPrice: '100000', drift: '0.20', volatility: '0.55' },
  { symbol: 'ETH', initialPrice: '3800', drift: '0.18', volatility: '0.65' },
  { symbol: 'USDC', initialPrice: '1.0000', drift: '0', volatility: '0.01', peg: '1' },
  { symbol: 'PYUSD', initialPrice: '1.0000', drift: '0', volatility: '0.015', peg: '1' },
  { symbol: 'USDT', initialPrice: '1.0000', drift: '0', volatility: '0.02', peg: '1' },
  { symbol: 'USD', initialPrice: '1', drift: '0', volatility: '0', peg: '1' },
];

const MAX_HISTORY = 400;

export class MarketSimulator {
  private readonly rand: () => number;
  private readonly specs = new Map<string, AssetSpec>();
  private readonly spot = new Map<string, Decimal>();
  private readonly closes = new Map<string, Decimal[]>();
  private readonly fx = new Map<string, Decimal>([
    ['USD', D('1')], ['EUR', D('1.08')], ['GBP', D('1.27')], ['CHF', D('1.12')],
    ['SGD', D('0.74')], ['AED', D('0.2723')], ['JPY', D('0.0064')], ['CAD', D('0.73')],
    ['AUD', D('0.66')], ['INR', D('0.0120')], ['KRW', D('0.00073')],
  ]);

  constructor(seed = 42, assets: readonly AssetSpec[] = DEFAULT_ASSETS) {
    this.rand = mulberry32(seed);
    for (const a of assets) {
      this.specs.set(a.symbol, a);
      this.spot.set(a.symbol, D(a.initialPrice));
      // Seed a history so realized-volatility haircuts have something to read
      // from the first tick rather than silently falling back to defaults.
      const history: Decimal[] = [];
      let p = D(a.initialPrice);
      for (let i = 0; i < 90; i++) {
        p = this.step(p, a, 1 / 365);
        history.push(p);
      }
      this.closes.set(a.symbol, history);
    }
  }

  /** Box-Muller from the seeded uniform stream. */
  private gaussian(): number {
    const u1 = Math.max(this.rand(), Number.EPSILON);
    const u2 = this.rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  private step(price: Decimal, spec: AssetSpec, dt: number): Decimal {
    if (spec.peg) {
      // Mean-reverting around the peg: an Ornstein-Uhlenbeck style pull, so a
      // depeg shock decays back rather than random-walking away forever.
      const peg = D(spec.peg);
      const noise = D(this.gaussian() * Number(spec.volatility) * Math.sqrt(dt));
      const pull = peg.minus(price).times(D('0.25'));
      const next = price.plus(pull).plus(noise.times(peg));
      return next.lt(0) ? D('0.0001') : next;
    }
    // Geometric Brownian motion, first-order. Exact enough for a simulator and
    // it keeps the whole path inside Decimal.
    const mu = D(spec.drift).times(dt);
    const sigma = D(spec.volatility).times(Math.sqrt(dt));
    const shock = sigma.times(this.gaussian());
    const next = price.times(D(1).plus(mu).plus(shock));
    return next.lt(D('0.0001')) ? D('0.0001') : next;
  }

  /** Advance every asset by `days`, recording a close per day. */
  tick(days = 1 / 24): void {
    for (const [symbol, spec] of this.specs) {
      const current = this.spot.get(symbol)!;
      const next = this.step(current, spec, days);
      this.spot.set(symbol, next);
      const history = this.closes.get(symbol)!;
      history.push(next);
      if (history.length > MAX_HISTORY) history.shift();
    }
  }

  /** Apply an instantaneous move, e.g. shock('BTC', '-0.40'). */
  shock(symbol: string, pctChange: string): Decimal {
    const current = this.spot.get(symbol.toUpperCase());
    if (!current) throw new RangeError(`unknown symbol ${symbol}`);
    const next = current.times(D(1).plus(D(pctChange)));
    const floored = next.lt(D('0.0001')) ? D('0.0001') : next;
    this.spot.set(symbol.toUpperCase(), floored);
    this.closes.get(symbol.toUpperCase())!.push(floored);
    return floored;
  }

  setPrice(symbol: string, price: string): void {
    const key = symbol.toUpperCase();
    if (!this.specs.has(key)) throw new RangeError(`unknown symbol ${symbol}`);
    this.spot.set(key, D(price));
    this.closes.get(key)!.push(D(price));
  }

  priceOf(symbol: string): Decimal | undefined {
    return this.spot.get(symbol.toUpperCase());
  }

  historyOf(symbol: string, days: number): Decimal[] {
    const h = this.closes.get(symbol.toUpperCase()) ?? [];
    return h.slice(Math.max(0, h.length - days));
  }

  symbols(): string[] {
    return [...this.specs.keys()];
  }

  fxRate(currency: string): Decimal | undefined {
    return this.fx.get(currency.toUpperCase());
  }

  fxRates(): Map<string, Decimal> {
    return new Map(this.fx);
  }

  /** Per-source jitter so the consolidator sees genuine dispersion. */
  jitter(basisPoints: number): Decimal {
    return D(1).plus(D((this.rand() - 0.5) * 2 * basisPoints).dividedBy(10_000));
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.spot].map(([k, v]) => [k, v.toDecimalPlaces(8).toFixed()]));
  }
}

/** One process-wide simulator so the API and the scenario driver agree. */
let shared: MarketSimulator | null = null;

export const sharedMarket = (): MarketSimulator => {
  shared ??= new MarketSimulator(Number(process.env.MARKET_SEED ?? 42));
  return shared;
};

export const resetSharedMarket = (seed = 42): MarketSimulator => {
  shared = new MarketSimulator(seed);
  return shared;
};
