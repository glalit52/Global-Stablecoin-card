import { describe, it, expect } from 'vitest';
import {
  collateralCallAmount, computeCollateral, computeRisk, D, drawdownTolerance,
  evaluateTrigger, getPolicy, isAtLeast, Money, planLiquidation, projectAfterSpend,
  repaymentToTarget, runAllStressScenarios, runStressScenario, stateForLtv,
  valuePortfolio, worseOf,
} from '../src/index.js';
import { ctx, facility, holding, price, T0, usd } from './helpers.js';

const policy = getPolicy();

const collateralOf = (
  holdings: Parameters<typeof holding>[0][], prices: ReturnType<typeof price>[], now = T0,
) => {
  const { valued } = valuePortfolio(holdings.map(holding), ctx(prices, now));
  return computeCollateral({ customerId: 'cust_1', jurisdiction: 'US', valued, policy, now });
};

/** A book with exactly 1,000,000 of eligible collateral, for clean LTV maths. */
const cleanBook = (btcPrice: string) => collateralOf(
  [{ symbol: 'BTC', assetClass: 'BTC', quantity: D('10') },
   { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('600000') }],
  [price('BTC', btcPrice), price('USDC', '1.00')],
);

describe('risk state ladder', () => {
  it('maps LTV onto the PRD §11.3 states', () => {
    expect(stateForLtv(D('0.30'), policy)).toBe('healthy');
    expect(stateForLtv(D('0.60'), policy)).toBe('watch');
    expect(stateForLtv(D('0.70'), policy)).toBe('restricted');
    expect(stateForLtv(D('0.78'), policy)).toBe('remediation');
    expect(stateForLtv(D('0.85'), policy)).toBe('liquidation');
    expect(stateForLtv(D('1.50'), policy)).toBe('liquidation');
    expect(stateForLtv(null, policy)).toBe('healthy');
  });

  it('orders states so escalation is monotonic', () => {
    expect(worseOf('healthy', 'watch')).toBe('watch');
    expect(worseOf('liquidation', 'watch')).toBe('liquidation');
    expect(isAtLeast('remediation', 'restricted')).toBe(true);
    expect(isAtLeast('watch', 'restricted')).toBe(false);
  });
});

describe('risk snapshot', () => {
  it('reports a clean account with no debt as fully healthy', () => {
    const c = cleanBook('100000');
    const r = computeRisk({ facility: facility(), collateral: c, policy, now: T0 });
    expect(r.state).toBe('healthy');
    expect(r.healthPercent.toFixed()).toBe('100');
    expect(r.totalDebt.isZero()).toBe(true);
    expect(r.effectiveLtv!.toFixed()).toBe('0');
    expect(r.withdrawableCollateral.eq(r.eligibleCollateralValue)).toBe(true);
  });

  it('counts authorization holds as exposure', () => {
    const c = cleanBook('100000');
    const noHolds = computeRisk({
      facility: facility({ principalBalance: usd('400000') }), collateral: c, policy, now: T0,
    });
    const withHolds = computeRisk({
      facility: facility({ principalBalance: usd('400000'), holdsTotal: usd('200000') }),
      collateral: c, policy, now: T0,
    });
    expect(withHolds.effectiveLtv!.gt(noHolds.effectiveLtv!)).toBe(true);
    // Holds move risk but are not yet debt.
    expect(withHolds.totalDebt.toFixedString()).toBe('400000.00');
  });

  it('treats debt with no eligible collateral as liquidation, not as a null LTV', () => {
    const empty = collateralOf([], []);
    const r = computeRisk({
      facility: facility({ principalBalance: usd('5000') }), collateral: empty, policy, now: T0,
    });
    expect(r.state).toBe('liquidation');
    expect(r.healthPercent.toFixed()).toBe('0');
    expect(r.triggeredRules).toContain('no_eligible_collateral_against_outstanding_exposure');
  });

  it('escalates but never relaxes on non-LTV signals', () => {
    const stalePrice = new Date(T0.getTime() - 3_600_000);
    const degraded = collateralOf(
      [{ symbol: 'BTC', assetClass: 'BTC', quantity: D('10') },
       { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('600000') }],
      [price('BTC', '100000', stalePrice), price('USDC', '1.00')],
    );
    const r = computeRisk({
      facility: facility({ principalBalance: usd('10000') }), collateral: degraded, policy, now: T0,
    });
    expect(r.degraded).toBe(true);
    expect(isAtLeast(r.state, 'watch')).toBe(true);
    expect(r.triggeredRules).toContain('degraded_pricing_or_verification');
  });

  it('holds the account in remediation while a margin call is open', () => {
    const c = cleanBook('100000');
    const r = computeRisk({
      facility: facility({ principalBalance: usd('10000') }), collateral: c, policy,
      now: T0, openMarginCall: true,
    });
    expect(r.state).toBe('remediation');
  });

  it('respects an operations freeze on the facility', () => {
    const c = cleanBook('100000');
    const r = computeRisk({
      facility: facility({ status: 'frozen', principalBalance: usd('1000') }),
      collateral: c, policy, now: T0,
    });
    expect(isAtLeast(r.state, 'remediation')).toBe(true);
  });

  it('computes safe spend as the lower of risk headroom and the credit limit', () => {
    const c = cleanBook('100000');
    const eligible = c.eligibleCollateralValue;
    // Watch ceiling is 60% of eligible collateral.
    const r = computeRisk({
      facility: facility({ creditLimit: usd('10000000') }), collateral: c, policy, now: T0,
    });
    expect(r.safeSpendCapacity.toFixedString()).toBe(eligible.times(D('0.6')).roundDown().toFixedString());

    // A tight contractual limit binds instead.
    const limited = computeRisk({
      facility: facility({ creditLimit: usd('5000') }), collateral: c, policy, now: T0,
    });
    expect(limited.safeSpendCapacity.toFixedString()).toBe('5000.00');
  });

  it('never reports negative withdrawable collateral', () => {
    const c = cleanBook('100000');
    const r = computeRisk({
      facility: facility({ principalBalance: usd('900000') }), collateral: c, policy, now: T0,
    });
    expect(r.withdrawableCollateral.isNegative()).toBe(false);
    expect(r.withdrawableCollateral.isZero()).toBe(true);
  });

  it('derives health from headroom to the liquidation threshold', () => {
    const c = cleanBook('100000');
    const eligible = c.eligibleCollateralValue;
    // Borrow exactly at the liquidation LTV: health must be zero.
    const atThreshold = computeRisk({
      facility: facility({ creditLimit: usd('10000000'), principalBalance: Money.of(eligible.amount.times(D('0.85')), 'USD') }),
      collateral: c, policy, now: T0,
    });
    expect(atThreshold.healthPercent.toFixed()).toBe('0');
    expect(atThreshold.state).toBe('liquidation');
  });

  it('projects the effect of new spend without mutating anything', () => {
    const c = cleanBook('100000');
    const r = computeRisk({
      facility: facility({ creditLimit: usd('10000000'), principalBalance: usd('100000') }),
      collateral: c, policy, now: T0,
    });
    const before = r.effectiveLtv!.toFixed();
    const projected = projectAfterSpend(r, usd('500000'), policy);
    expect(projected.ltv!.gt(r.effectiveLtv!)).toBe(true);
    expect(r.effectiveLtv!.toFixed()).toBe(before);
  });

  it('sizes the collateral call and the repayment that cure a breach', () => {
    const c = cleanBook('100000');
    const eligible = c.eligibleCollateralValue;
    const debt = Money.of(eligible.amount.times(D('0.80')), 'USD');
    const r = computeRisk({
      facility: facility({ creditLimit: usd('10000000'), principalBalance: debt }),
      collateral: c, policy, now: T0,
    });
    expect(r.state).toBe('remediation');

    const call = collateralCallAmount(r, policy);
    const repay = repaymentToTarget(r, policy);
    expect(call.isPositive()).toBe(true);
    expect(repay.isPositive()).toBe(true);
    // Adding that collateral lands at the 55% target.
    const curedLtv = debt.amount.dividedBy(eligible.plus(call).amount);
    expect(curedLtv.lte(D('0.5501'))).toBe(true);
    // Repaying that amount does the same.
    const afterRepay = debt.minus(repay).amount.dividedBy(eligible.amount);
    expect(afterRepay.lte(D('0.5501'))).toBe(true);
  });
});

describe('stress testing', () => {
  it('runs every policy scenario and flags the ones that force action', () => {
    const c = cleanBook('100000');
    const r = computeRisk({
      facility: facility({ creditLimit: usd('10000000'), principalBalance: Money.of(c.eligibleCollateralValue.amount.times(D('0.5')), 'USD') }),
      collateral: c, policy, now: T0,
    });
    const results = runAllStressScenarios(r, c, policy);
    expect(results).toHaveLength(policy.stressScenarios.length);
    // A 70% BTC drawdown on a half-drawn book must not pass quietly.
    const severe = results.find((x) => x.scenario.id === 'btc_drawdown_70')!;
    expect(severe.survives).toBe(false);
    expect(severe.collateralShortfall.isPositive()).toBe(true);
    // A mild shock on the same book is survivable.
    const mild = results.find((x) => x.scenario.id === 'btc_drawdown_30')!;
    expect(mild.survives).toBe(true);
  });

  it('models a depeg as a price level, not a percentage move', () => {
    const c = collateralOf(
      [{ symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('500000') },
       { symbol: 'BTC', assetClass: 'BTC', quantity: D('2') }],
      [price('USDC', '1.00'), price('BTC', '100000')],
    );
    const r = computeRisk({
      facility: facility({ creditLimit: usd('10000000'), principalBalance: usd('200000') }),
      collateral: c, policy, now: T0,
    });
    const depeg = runStressScenario(r, c, policy.stressScenarios.find((s) => s.id === 'stablecoin_depeg')!, policy);
    expect(depeg.eligibleCollateralValue.lt(c.eligibleCollateralValue)).toBe(true);
    // Only the stablecoin leg moves, so the loss is close to 10% of it.
    expect(depeg.eligibleCollateralValue.gt(c.eligibleCollateralValue.times(D('0.85')))).toBe(true);
  });

  it('never produces a negative stressed collateral value', () => {
    const c = cleanBook('100000');
    const r = computeRisk({ facility: facility(), collateral: c, policy, now: T0 });
    const wipeout = runStressScenario(r, c, {
      id: 'wipeout', label: 'Total loss', shocks: { BTC: '-2.0' }, stablecoinPeg: '0',
    }, policy);
    expect(wipeout.eligibleCollateralValue.isNegative()).toBe(false);
  });

  it('reports drawdown tolerance a customer can act on', () => {
    const c = cleanBook('100000');
    const noDebt = computeRisk({ facility: facility(), collateral: c, policy, now: T0 });
    expect(drawdownTolerance(noDebt, policy)).toBeNull();

    const halfDrawn = computeRisk({
      facility: facility({ creditLimit: usd('10000000'), principalBalance: Money.of(c.eligibleCollateralValue.amount.times(D('0.5')), 'USD') }),
      collateral: c, policy, now: T0,
    });
    const tol = drawdownTolerance(halfDrawn, policy)!;
    // At 50% LTV with liquidation at 85%, tolerance is 1 - 0.5/0.85 = 41.2%.
    expect(tol.toDecimalPlaces(3).toFixed()).toBe('0.412');
  });
});

describe('liquidation', () => {
  const stressedBook = () => {
    const c = cleanBook('100000');
    const debt = Money.of(c.eligibleCollateralValue.amount.times(D('0.90')), 'USD');
    const r = computeRisk({
      facility: facility({ creditLimit: usd('10000000'), principalBalance: debt }),
      collateral: c, policy, now: T0,
    });
    return { c, r };
  };

  it('does not fire below the liquidation threshold', () => {
    const c = cleanBook('100000');
    const r = computeRisk({
      facility: facility({ creditLimit: usd('10000000'), principalBalance: Money.of(c.eligibleCollateralValue.amount.times(D('0.5')), 'USD') }),
      collateral: c, policy, now: T0,
    });
    const t = evaluateTrigger(r, policy, null, T0, true);
    expect(t.shouldLiquidate).toBe(false);
    expect(t.reason).toBe('below_liquidation_threshold');
  });

  it('respects the cure window, then fires when it expires', () => {
    const { r } = stressedBook();
    expect(r.state).toBe('liquidation');

    const raisedAt = T0;
    const during = evaluateTrigger(r, policy, { raisedAt, cured: false }, new Date(T0.getTime() + 3_600_000), true);
    expect(during.shouldLiquidate).toBe(false);
    expect(during.withinRemediationWindow).toBe(true);

    const after = evaluateTrigger(r, policy, { raisedAt, cured: false }, new Date(T0.getTime() + 25 * 3_600_000), true);
    expect(after.shouldLiquidate).toBe(true);
  });

  it('overrides the cure window once collateral no longer covers the debt', () => {
    const c = cleanBook('100000');
    const debt = Money.of(c.eligibleCollateralValue.amount.times(D('1.05')), 'USD');
    const r = computeRisk({
      facility: facility({ creditLimit: usd('100000000'), principalBalance: debt }),
      collateral: c, policy, now: T0,
    });
    const t = evaluateTrigger(r, policy, { raisedAt: T0, cured: false }, new Date(T0.getTime() + 60_000), true);
    expect(t.shouldLiquidate).toBe(true);
    expect(t.reason).toBe('ltv_at_or_above_100pct_hard_floor');
  });

  it('refuses to fire where the jurisdiction forbids automated liquidation', () => {
    const { r } = stressedBook();
    const t = evaluateTrigger(r, policy, null, T0, false);
    expect(t.shouldLiquidate).toBe(false);
    expect(t.reason).toBe('automated_liquidation_not_permitted_in_jurisdiction');
  });

  it('sells only what is needed to reach the target LTV', () => {
    const { c, r } = stressedBook();
    const plan = planLiquidation({
      snapshot: r, collateral: c, policy, triggeredBy: 'test', now: T0,
    });
    expect(plan.sufficient).toBe(true);
    expect(plan.projectedLtvAfter!.lte(plan.targetLtv.plus(D('0.005')))).toBe(true);
    // Crucially: it does not liquidate the whole book.
    expect(plan.projectedCollateralAfter.isPositive()).toBe(true);
    expect(plan.totalNetProceeds.lt(r.eligibleCollateralValue)).toBe(true);
  });

  it('sells the cheapest, most liquid collateral first by default', () => {
    const { c, r } = stressedBook();
    const plan = planLiquidation({ snapshot: r, collateral: c, policy, triggeredBy: 'test', now: T0 });
    expect(plan.lots[0]!.symbol).toBe('USDC');
  });

  it('sells the riskiest collateral first under the de-risk strategy', () => {
    const { c, r } = stressedBook();
    const plan = planLiquidation({
      snapshot: r, collateral: c, policy, triggeredBy: 'test', strategy: 'de_risk', now: T0,
    });
    expect(plan.lots[0]!.symbol).toBe('BTC');
    expect(plan.sufficient).toBe(true);
  });

  it('spreads the sale across positions under pro-rata', () => {
    const { c, r } = stressedBook();
    const plan = planLiquidation({
      snapshot: r, collateral: c, policy, triggeredBy: 'test', strategy: 'pro_rata', now: T0,
    });
    expect(plan.lots.length).toBe(2);
    expect(plan.sufficient).toBe(true);
  });

  it('books slippage and fees against the proceeds', () => {
    const { c, r } = stressedBook();
    const plan = planLiquidation({ snapshot: r, collateral: c, policy, triggeredBy: 'test', now: T0 });
    for (const lot of plan.lots) {
      expect(lot.netProceeds.lt(lot.grossProceeds)).toBe(true);
      expect(lot.grossProceeds.minus(lot.estimatedSlippage).minus(lot.estimatedFees)
        .minus(lot.netProceeds).abs().amount.lte(D('0.01'))).toBe(true);
    }
  });

  it('reports insufficiency rather than pretending a shortfall is covered', () => {
    const c = cleanBook('100000');
    const debt = Money.of(c.eligibleCollateralValue.amount.times(D('3')), 'USD');
    const r = computeRisk({
      facility: facility({ creditLimit: usd('100000000'), principalBalance: debt }),
      collateral: c, policy, now: T0,
    });
    const plan = planLiquidation({ snapshot: r, collateral: c, policy, triggeredBy: 'test', now: T0 });
    expect(plan.sufficient).toBe(false);
    expect(plan.projectedDebtAfter.isPositive()).toBe(true);
  });

  it('plans nothing when there is nothing to do', () => {
    const c = cleanBook('100000');
    const r = computeRisk({ facility: facility(), collateral: c, policy, now: T0 });
    const plan = planLiquidation({ snapshot: r, collateral: c, policy, triggeredBy: 'test', now: T0 });
    expect(plan.lots).toHaveLength(0);
    expect(plan.totalNetProceeds.isZero()).toBe(true);
  });
});
