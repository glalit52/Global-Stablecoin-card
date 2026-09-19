import { describe, it, expect } from 'vitest';
import {
  computeCollateral, computeHaircut, D, getPolicy, Money, valuePortfolio, liquidationOrder,
} from '../src/index.js';
import { ctx, holding, price, T0 } from './helpers.js';

const policy = getPolicy();

const build = (
  holdings: Parameters<typeof holding>[0][],
  prices: ReturnType<typeof price>[],
  now = T0,
  jurisdiction: 'US' | 'SG' | 'GB' = 'US',
  vols?: Map<string, ReturnType<typeof D>>,
) => {
  const { valued } = valuePortfolio(holdings.map(holding), ctx(prices, now));
  return computeCollateral({
    customerId: 'cust_1', jurisdiction, valued, policy, now,
    ...(vols ? { volatilityBySymbol: vols } : {}),
  });
};

describe('collateral engine', () => {
  it('applies the PRD §10.1 formula exactly', () => {
    // 1 BTC @ $100,000. factor 1.0, haircut 0.30 (base, vol at expectation),
    // liquidity 0.90 => 100000 * 1 * 0.70 * 0.90 = 63,000, then the 80% BTC
    // concentration cap on a single-asset book => 50,400.
    const s = build(
      [{ symbol: 'BTC', assetClass: 'BTC', quantity: D('1') }],
      [price('BTC', '100000')],
    );
    expect(s.totalMarketValue.toFixedString()).toBe('100000.00');
    const p = s.positions[0]!;
    expect(p.haircut.toFixed()).toBe('0.3');
    expect(p.liquidityAdjustment.toFixed()).toBe('0.9');
    expect(p.concentrationAdjustment.toFixed()).toBe('0.8');
    expect(s.eligibleCollateralValue.toFixedString()).toBe('50400.00');
    expect(s.concentrationCapBinding).toBe(true);
    expect(p.eligible).toBe(true);
  });

  it('raises the haircut only for volatility above the policy expectation', () => {
    const base = D('0.30'), expected = D('0.55'), mult = D('0.55'), max = D('0.65');
    // At expectation, the base haircut stands — no double counting.
    expect(computeHaircut(base, expected, expected, mult, max).toFixed()).toBe('0.3');
    // Below expectation never goes under the base.
    expect(computeHaircut(base, expected, D('0.20'), mult, max).toFixed()).toBe('0.3');
    // Above expectation scales up, and is capped.
    expect(computeHaircut(base, expected, D('0.85'), mult, max).toFixed()).toBe('0.465');
    expect(computeHaircut(base, expected, D('2'), mult, max).toFixed()).toBe('0.65');
  });

  it('cuts eligible value when realised volatility spikes', () => {
    const calm = build([{ symbol: 'BTC', assetClass: 'BTC', quantity: D('1') }], [price('BTC', '100000')]);
    const storm = build(
      [{ symbol: 'BTC', assetClass: 'BTC', quantity: D('1') }], [price('BTC', '100000')],
      T0, 'US', new Map([['BTC', D('0.95')]]),
    );
    expect(storm.eligibleCollateralValue.lt(calm.eligibleCollateralValue)).toBe(true);
    // haircut 0.30 + (0.95-0.55)*0.55 = 0.52 => 100000*0.48*0.9*0.8 = 34,560
    expect(storm.eligibleCollateralValue.toFixedString()).toBe('34560.00');
  });

  it('gives USDC a lighter haircut than the generic stablecoin bucket', () => {
    const s = build(
      [{ symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('100000') }],
      [price('USDC', '1.00')],
    );
    // 100000 * 1.0 * (1 - 0.015) * 0.98 = 96,530 before caps.
    expect(s.positions[0]!.haircut.toFixed()).toBe('0.015');
    // A book that is 100% one issuer is cut to the 75% issuer cap.
    expect(s.eligibleCollateralValue.toFixedString()).toBe('72397.50');
  });

  it('gives a USDC position a higher eligible value than a generic stablecoin', () => {
    // Same size, same peg, different issuer quality: the override must bite.
    const withUsdc = build(
      [
        { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('50000') },
        { symbol: 'BTC', assetClass: 'BTC', quantity: D('1') },
      ],
      [price('USDC', '1.00'), price('BTC', '100000')],
    );
    const usdc = withUsdc.positions.find((p) => p.symbol === 'USDC')!;
    // 0.015 for USDC against the 0.02 generic stablecoin base.
    expect(usdc.haircut.lt(D('0.02'))).toBe(true);
  });

  it('suspends collateral when the price is stale', () => {
    const stale = new Date(T0.getTime() - 10 * 60_000); // 10 min, BTC allows 120s
    const s = build([{ symbol: 'BTC', assetClass: 'BTC', quantity: D('1') }], [price('BTC', '100000', stale)]);
    expect(s.eligibleCollateralValue.isZero()).toBe(true);
    expect(s.positions[0]!.ineligibilityReasons).toContain('stale_price');
    expect(s.degraded).toBe(true);
  });

  it('suspends collateral when price sources disagree', () => {
    const s = build(
      [{ symbol: 'BTC', assetClass: 'BTC', quantity: D('1') }],
      [price('BTC', '100000', T0, { disputed: true, dispersion: D('0.08') })],
    );
    expect(s.eligibleCollateralValue.isZero()).toBe(true);
    expect(s.positions[0]!.ineligibilityReasons).toContain('disputed_price');
  });

  it('refuses unpledged and customer-excluded holdings', () => {
    const s = build(
      [
        { symbol: 'BTC', assetClass: 'BTC', quantity: D('1'), pledged: false },
        { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('50000'), excluded: true },
      ],
      [price('BTC', '100000'), price('USDC', '1.00')],
    );
    expect(s.eligibleCollateralValue.isZero()).toBe(true);
    expect(s.positions[0]!.ineligibilityReasons).toContain('not_pledged');
    expect(s.positions[1]!.ineligibilityReasons).toContain('excluded_by_customer');
    // Market value is still reported — the customer's wealth graph is complete
    // even where it cannot be lent against.
    expect(s.totalMarketValue.toFixedString()).toBe('150000.00');
  });

  it('refuses non-whitelisted stablecoins', () => {
    const s = build(
      [{ symbol: 'USDT', assetClass: 'STABLECOIN', quantity: D('100000') }],
      [price('USDT', '1.00')],
    );
    expect(s.positions[0]!.ineligibilityReasons).toContain('symbol_not_whitelisted');
  });

  it('applies the jurisdiction asset list', () => {
    const inUs = build([{ symbol: 'PYUSD', assetClass: 'STABLECOIN', quantity: D('10000') }], [price('PYUSD', '1.00')]);
    expect(inUs.positions[0]!.eligible).toBe(true);
    // Singapore permits USDC only.
    const inSg = build([{ symbol: 'PYUSD', assetClass: 'STABLECOIN', quantity: D('10000') }], [price('PYUSD', '1.00')], T0, 'SG');
    expect(inSg.positions[0]!.ineligibilityReasons).toContain('jurisdiction_restricted');
    // Great Britain is not an enabled programme at all.
    const inGb = build([{ symbol: 'BTC', assetClass: 'BTC', quantity: D('1') }], [price('BTC', '100000')], T0, 'GB');
    expect(inGb.eligibleCollateralValue.isZero()).toBe(true);
  });

  it('adds a haircut for a mild depeg and removes eligibility for a severe one', () => {
    const mild = build([{ symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('100000') }], [price('USDC', '0.97')]);
    expect(mild.positions[0]!.eligible).toBe(true);
    expect(mild.positions[0]!.haircut.toFixed()).toBe('0.315'); // 0.015 + 0.30 depeg
    expect(mild.degraded).toBe(true);

    const severe = build([{ symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('100000') }], [price('USDC', '0.80')]);
    expect(severe.positions[0]!.ineligibilityReasons).toContain('depeg_detected');
    expect(severe.eligibleCollateralValue.isZero()).toBe(true);
  });

  it('expires collateral when ownership verification goes stale', () => {
    const old = new Date(T0.getTime() - 48 * 3_600_000); // BTC allows 12h
    const s = build(
      [{ symbol: 'BTC', assetClass: 'BTC', quantity: D('1'), lastVerifiedAt: old }],
      [price('BTC', '100000')],
    );
    expect(s.positions[0]!.ineligibilityReasons).toContain('verification_expired');
  });

  it('refuses self-custody without a control signature', () => {
    const noSig = build(
      [{ symbol: 'BTC', assetClass: 'BTC', quantity: D('1'), custodyModel: 'self_custody_verified', verification: 'onchain_balance' }],
      [price('BTC', '100000')],
    );
    expect(noSig.positions[0]!.ineligibilityReasons).toContain('custody_model_not_eligible');

    const withSig = build(
      [{ symbol: 'BTC', assetClass: 'BTC', quantity: D('1'), custodyModel: 'self_custody_verified', verification: 'onchain_signature' }],
      [price('BTC', '100000')],
    );
    expect(withSig.positions[0]!.eligible).toBe(true);
  });

  it('never drives a single-asset portfolio to zero through the concentration cap', () => {
    // A self-referential cap would iterate 0.8 -> 0.64 -> ... -> 0. It must not.
    const s = build([{ symbol: 'BTC', assetClass: 'BTC', quantity: D('10') }], [price('BTC', '100000')]);
    expect(s.eligibleCollateralValue.isPositive()).toBe(true);
    // 1,000,000 * 0.70 * 0.90 = 630,000, then the 0.80 BTC cap => 504,000
    expect(s.eligibleCollateralValue.toFixedString()).toBe('504000.00');
    expect(s.positions[0]!.concentrationAdjustment.toFixed()).toBe('0.8');
    expect(s.topConcentration.toFixed()).toBe('1');
  });

  it('leaves a diversified book unpenalised', () => {
    const s = build(
      [
        { symbol: 'BTC', assetClass: 'BTC', quantity: D('1') },
        { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('100000') },
      ],
      [price('BTC', '100000'), price('USDC', '1.00')],
    );
    // BTC 63,000 of 159,530 = 39.5%, below its 80% cap.
    expect(s.positions[0]!.concentrationAdjustment.toFixed()).toBe('1');
    expect(s.eligibleCollateralValue.toFixedString()).toBe('159530.00');
  });

  it('enforces the stablecoin issuer concentration cap across symbols', () => {
    const s = build(
      [
        { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('900000') },
        { symbol: 'BTC', assetClass: 'BTC', quantity: D('1') },
      ],
      [price('USDC', '1.00'), price('BTC', '100000')],
    );
    // Circle is far past the 75% issuer cap, so USDC is cut back.
    const usdc = s.positions.find((p) => p.symbol === 'USDC')!;
    expect(usdc.concentrationAdjustment.lt(1)).toBe(true);
  });

  it('ignores dust positions', () => {
    const s = build(
      [{ symbol: 'BTC', assetClass: 'BTC', quantity: D('0.0001') }],
      [price('BTC', '100000')],
    );
    expect(s.positions[0]!.ineligibilityReasons).toContain('below_dust_threshold');
  });

  it('computes weighted volatility and liquidity over eligible collateral only', () => {
    const s = build(
      [
        { symbol: 'BTC', assetClass: 'BTC', quantity: D('1') },
        { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('100000') },
        { symbol: 'USDT', assetClass: 'STABLECOIN', quantity: D('500000') }, // ineligible
      ],
      [price('BTC', '100000'), price('USDC', '1.00'), price('USDT', '1.00')],
    );
    expect(s.weightedVolatility.gt(0)).toBe(true);
    expect(s.weightedVolatility.lt(D('0.55'))).toBe(true); // diluted by the stablecoin
    expect(s.weightedLiquidity.gt(D('0.9'))).toBe(true);
  });

  it('orders liquidation cheapest and most liquid first', () => {
    const s = build(
      [
        { symbol: 'BTC', assetClass: 'BTC', quantity: D('1') },
        { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('100000') },
      ],
      [price('BTC', '100000'), price('USDC', '1.00')],
    );
    const order = liquidationOrder(s.positions, policy);
    expect(order.map((p) => p.symbol)).toEqual(['USDC', 'BTC']);
  });

  it('is deterministic: identical inputs give an identical summary', () => {
    const args = [
      [{ symbol: 'BTC' as const, assetClass: 'BTC' as const, quantity: D('1.23456789') }],
      [price('BTC', '98765.43')],
    ] as const;
    const a = build([...args[0]], [...args[1]]);
    const b = build([...args[0]], [...args[1]]);
    expect(a.eligibleCollateralValue.toString()).toBe(b.eligibleCollateralValue.toString());
    expect(a.positions[0]!.haircut.toFixed()).toBe(b.positions[0]!.haircut.toFixed());
  });

  it('reports an empty portfolio as zero rather than throwing', () => {
    const s = build([], []);
    expect(s.eligibleCollateralValue.toFixedString()).toBe('0.00');
    expect(s.topConcentration.toFixed()).toBe('0');
    expect(s.weightedLiquidity.toFixed()).toBe('0');
  });
});
