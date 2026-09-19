import { describe, it, expect } from 'vitest';
import {
  accrueDailyInterest, availableCredit, computeCollateral, concentrationAdjustment,
  customerAdjustment, D, decideCredit, getPolicy, liquidityAdjustment, minimumPayment,
  Money, portfolioRiskAdjustment, pricedAprBps, totalDebt, totalExposure, utilization,
  valuePortfolio, validatePolicy,
} from '../src/index.js';
import { ctx, facility, holding, price, T0, underwriting, usd } from './helpers.js';

const policy = getPolicy();

const collateralOf = (
  holdings: Parameters<typeof holding>[0][], prices: ReturnType<typeof price>[],
) => {
  const { valued } = valuePortfolio(holdings.map(holding), ctx(prices));
  return computeCollateral({ customerId: 'cust_1', jurisdiction: 'US', valued, policy, now: T0 });
};

const balanced = () => collateralOf(
  [
    { symbol: 'BTC', assetClass: 'BTC', quantity: D('3') },
    { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('200000') },
  ],
  [price('BTC', '100000'), price('USDC', '1.00')],
);

describe('policy governance', () => {
  it('ships a valid MVP policy', () => {
    expect(validatePolicy(policy)).toEqual([]);
  });

  it('catches an inverted threshold ladder', () => {
    const broken = { ...policy, thresholds: { ...policy.thresholds, watchLtv: '0.40' } };
    expect(validatePolicy(broken).join(' ')).toMatch(/watchLtv.*must exceed maxOriginationLtv/);
  });

  it('catches a liquidation target that cannot cure a margin call', () => {
    const broken = { ...policy, thresholds: { ...policy.thresholds, liquidationTargetLtv: '0.80' } };
    expect(validatePolicy(broken).join(' ')).toMatch(/liquidationTargetLtv must be below remediationLtv/);
  });

  it('catches a jurisdiction permitting an unlisted stablecoin', () => {
    const broken = {
      ...policy,
      jurisdictions: { ...policy.jurisdictions, US: { ...policy.jurisdictions.US, permittedStablecoins: ['USDC', 'DAI'] } },
    };
    expect(validatePolicy(broken).join(' ')).toMatch(/permits DAI which is not on the global stablecoin whitelist/);
  });

  it('is frozen against mutation at runtime', () => {
    expect(() => { (policy.thresholds as { watchLtv: string }).watchLtv = '0.99'; }).toThrow();
  });
});

describe('credit adjustment terms', () => {
  it('leaves a resilient book unpenalised on portfolio risk', () => {
    // A stablecoin-heavy book barely moves under a BTC shock.
    const c = collateralOf(
      [{ symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('500000') },
       { symbol: 'BTC', assetClass: 'BTC', quantity: D('1') }],
      [price('USDC', '1.00'), price('BTC', '100000')],
    );
    const { factor } = portfolioRiskAdjustment(c, policy);
    expect(factor.toFixed()).toBe('1');
  });

  it('does not charge twice for volatility already in the haircut', () => {
    // An all-BTC book still retains 70% under a 30% shock, which is above the
    // 60% expectation, so the term stands at 1.0.
    const c = collateralOf([{ symbol: 'BTC', assetClass: 'BTC', quantity: D('5') }], [price('BTC', '100000')]);
    const { factor, survivalRatio } = portfolioRiskAdjustment(c, policy);
    expect(survivalRatio!.toDecimalPlaces(2).toFixed()).toBe('0.7');
    expect(factor.toFixed()).toBe('1');
  });

  it('cuts capacity for a book that fails the baseline scenario', () => {
    const c = collateralOf([{ symbol: 'BTC', assetClass: 'BTC', quantity: D('5') }], [price('BTC', '100000')]);
    const harsh = { ...policy, credit: { ...policy.credit, expectedStressSurvival: '0.95' } };
    const { factor } = portfolioRiskAdjustment(c, harsh);
    expect(factor.lt(1)).toBe(true);
    expect(factor.gte(D(policy.credit.minPortfolioRiskAdjustment))).toBe(true);
  });

  it('leaves an adequately liquid book alone and cuts an illiquid one', () => {
    expect(liquidityAdjustment(D('0.90'), policy).toFixed()).toBe('1');
    expect(liquidityAdjustment(D('0.85'), policy).toFixed()).toBe('1');
    const thin = liquidityAdjustment(D('0.50'), policy);
    expect(thin.lt(1)).toBe(true);
    expect(thin.gte(D(policy.credit.minLiquidityAdjustment))).toBe(true);
  });

  it('does not charge for concentration the collateral cap already priced', () => {
    expect(concentrationAdjustment(D('1.0'), true, policy).toFixed()).toBe('1');
    // Concentrated but inside every cap: the credit term does the work.
    expect(concentrationAdjustment(D('1.0'), false, policy).toFixed()).toBe('0.6');
    expect(concentrationAdjustment(D('0.4'), false, policy).toFixed()).toBe('1');
  });

  it('rewards tenure and clean repayment, punishes delinquency and fraud', () => {
    const clean = customerAdjustment(underwriting(), policy);
    expect(clean.toFixed()).toBe('1.1');

    const newAccount = customerAdjustment(underwriting({ tenureMonths: 0 }), policy);
    expect(newAccount.toFixed()).toBe('1');

    const late = customerAdjustment(underwriting({ delinquencies30d: 2 }), policy);
    expect(late.toFixed()).toBe('0.8');

    const risky = customerAdjustment(underwriting({ fraudScore: D('0.6') }), policy);
    expect(risky.toFixed()).toBe('0.8');

    // Floors and ceilings hold.
    const awful = customerAdjustment(underwriting({ delinquencies30d: 10, fraudScore: D('0.8') }), policy);
    expect(awful.toFixed()).toBe('0.5');
  });
});

describe('credit decision', () => {
  it('produces a limit consistent with the PRD §11.2 chain', () => {
    const c = balanced();
    const d = decideCredit({
      customerId: 'cust_1', collateral: c, underwriting: underwriting(),
      existingExposure: Money.zero('USD'), previousLimit: null, policy, now: T0,
    });
    expect(d.approved).toBe(true);
    // 3 BTC = 300,000 -> 189,000 eligible; 200,000 USDC -> 193,060 eligible.
    // Total 382,060 x 0.50 advance = 191,030 base capacity.
    expect(d.breakdown.baseCollateralCapacity.toFixedString()).toBe('191030.00');
    expect(d.breakdown.advanceRate.toFixed()).toBe('0.5');
    // All portfolio terms at 1.0, customer at 1.10, capped at base capacity.
    expect(d.creditLimit.toFixedString()).toBe('191000.00');
    expect(d.explanations.length).toBeGreaterThan(0);
  });

  it('never lets a good payment record lend against collateral that is not there', () => {
    const c = balanced();
    const d = decideCredit({
      customerId: 'cust_1', collateral: c, underwriting: underwriting({ tenureMonths: 60 }),
      existingExposure: Money.zero('USD'), previousLimit: null, policy, now: T0,
    });
    expect(d.breakdown.customerAdjustment.gt(1)).toBe(true);
    expect(d.creditLimit.lte(d.breakdown.baseCollateralCapacity)).toBe(true);
  });

  it('rounds the limit down to the tier step, never up', () => {
    const c = collateralOf(
      [{ symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('123456') },
       { symbol: 'BTC', assetClass: 'BTC', quantity: D('1') }],
      [price('USDC', '1.00'), price('BTC', '100000')],
    );
    const d = decideCredit({
      customerId: 'cust_1', collateral: c, underwriting: underwriting(),
      existingExposure: Money.zero('USD'), previousLimit: null, policy, now: T0,
    });
    expect(d.creditLimit.amount.mod(1000).toFixed()).toBe('0');
    expect(d.creditLimit.lte(d.breakdown.baseCollateralCapacity)).toBe(true);
  });

  it('declines on every hard underwriting stop', () => {
    const c = balanced();
    const cases: [Partial<Parameters<typeof underwriting>[0]>, string][] = [
      [{ kycStatus: 'pending' }, 'kyc_pending'],
      [{ sanctionsClear: false }, 'sanctions_screening_not_clear'],
      [{ pepReviewCleared: false }, 'pep_review_outstanding'],
      [{ customerStatus: 'suspended' }, 'customer_suspended'],
      [{ jurisdiction: 'GB' }, 'jurisdiction_not_enabled_GB'],
      [{ fraudScore: D('0.9') }, 'fraud_risk_too_high'],
    ];
    for (const [over, reason] of cases) {
      const d = decideCredit({
        customerId: 'cust_1', collateral: c, underwriting: underwriting(over),
        existingExposure: Money.zero('USD'), previousLimit: null, policy, now: T0,
      });
      expect(d.approved, reason).toBe(false);
      expect(d.declineReasons).toContain(reason);
      expect(d.creditLimit.isZero()).toBe(true);
    }
  });

  it('requires income verification where the jurisdiction demands it', () => {
    const c = balanced();
    const withoutIncome = decideCredit({
      customerId: 'cust_1', collateral: c, underwriting: underwriting({ jurisdiction: 'SG' }),
      existingExposure: Money.zero('USD'), previousLimit: null, policy, now: T0,
    });
    expect(withoutIncome.declineReasons).toContain('income_verification_required');

    const withIncome = decideCredit({
      customerId: 'cust_1', collateral: c,
      underwriting: underwriting({ jurisdiction: 'SG', monthlyIncome: usd('30000') }),
      existingExposure: Money.zero('USD'), previousLimit: null, policy, now: T0,
    });
    expect(withIncome.approved).toBe(true);
  });

  it('caps at the tier ceiling', () => {
    const c = collateralOf(
      [{ symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('400000') },
       { symbol: 'BTC', assetClass: 'BTC', quantity: D('2') }],
      [price('USDC', '1.00'), price('BTC', '100000')],
    );
    const d = decideCredit({
      customerId: 'cust_1', collateral: c, underwriting: underwriting({ tier: 'WEALTH' }),
      existingExposure: Money.zero('USD'), previousLimit: null, policy, now: T0,
    });
    expect(d.creditLimit.toFixedString()).toBe('50000.00');
    expect(d.explanations.join(' ')).toMatch(/WEALTH tier ceiling/);
  });

  it('declines when capacity falls below the tier minimum', () => {
    const c = collateralOf([{ symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('2000') }], [price('USDC', '1.00')]);
    const d = decideCredit({
      customerId: 'cust_1', collateral: c, underwriting: underwriting({ tier: 'PRIVATE' }),
      existingExposure: Money.zero('USD'), previousLimit: null, policy, now: T0,
    });
    expect(d.declineReasons).toContain('below_minimum_viable_limit');
  });

  it('never cuts a live limit below the drawn balance', () => {
    const crashed = collateralOf([{ symbol: 'BTC', assetClass: 'BTC', quantity: D('0.2') }], [price('BTC', '100000')]);
    const drawn = usd('40000');
    const d = decideCredit({
      customerId: 'cust_1', collateral: crashed, underwriting: underwriting(),
      existingExposure: drawn, previousLimit: usd('150000'), policy, now: T0,
    });
    expect(d.creditLimit.gte(drawn)).toBe(true);
    expect(d.explanations.join(' ')).toMatch(/below your drawn balance/);
  });

  it('gives zero capacity for zero collateral without throwing', () => {
    const empty = collateralOf([], []);
    const d = decideCredit({
      customerId: 'cust_1', collateral: empty, underwriting: underwriting(),
      existingExposure: Money.zero('USD'), previousLimit: null, policy, now: T0,
    });
    expect(d.approved).toBe(false);
    expect(d.creditLimit.isZero()).toBe(true);
  });

  it('flags a conservative decision when data is degraded', () => {
    const stale = new Date(T0.getTime() - 3_600_000);
    const { valued } = valuePortfolio(
      [holding({ symbol: 'BTC', assetClass: 'BTC', quantity: D('3') })],
      ctx([price('BTC', '100000', stale)]),
    );
    const c = computeCollateral({ customerId: 'cust_1', jurisdiction: 'US', valued, policy, now: T0 });
    const d = decideCredit({
      customerId: 'cust_1', collateral: c, underwriting: underwriting(),
      existingExposure: Money.zero('USD'), previousLimit: null, policy, now: T0,
    });
    expect(d.explanations.join(' ')).toMatch(/degraded/);
  });

  it('stamps the policy version on every decision', () => {
    const d = decideCredit({
      customerId: 'cust_1', collateral: balanced(), underwriting: underwriting(),
      existingExposure: Money.zero('USD'), previousLimit: null, policy, now: T0,
    });
    expect(d.policyVersion).toBe(policy.version);
  });
});

describe('facility arithmetic', () => {
  it('counts holds against the limit but not against debt', () => {
    const f = facility({
      creditLimit: usd('100000'), principalBalance: usd('20000'),
      interestBalance: usd('150'), feeBalance: usd('50'), holdsTotal: usd('5000'),
    });
    expect(totalDebt(f).toFixedString()).toBe('20200.00');
    expect(totalExposure(f).toFixedString()).toBe('25200.00');
    expect(availableCredit(f).toFixedString()).toBe('74800.00');
    expect(utilization(f)!.toFixed()).toBe('0.252');
  });

  it('clamps available credit at zero when over limit', () => {
    const f = facility({ creditLimit: usd('1000'), principalBalance: usd('1500') });
    expect(availableCredit(f).toFixedString()).toBe('0.00');
  });

  it('accrues interest on settled principal only', () => {
    const f = facility({ principalBalance: usd('36500'), holdsTotal: usd('10000'), aprBps: 1000 });
    // 36,500 x 10% / 365 = 10.00 a day. Holds earn nothing.
    expect(accrueDailyInterest(f).toFixedString()).toBe('10.00');
    expect(accrueDailyInterest(f, 30).toFixedString()).toBe('300.00');
    expect(accrueDailyInterest(facility()).toFixedString()).toBe('0.00');
  });

  it('prices APR by tier and volatility', () => {
    expect(pricedAprBps(policy, 'WEALTH', D('0'))).toBe(1150);
    expect(pricedAprBps(policy, 'ULTRA', D('0'))).toBe(900);
    expect(pricedAprBps(policy, 'PRIVATE', D('0.5'))).toBe(1150);
  });

  it('never demands a minimum payment above the balance', () => {
    expect(minimumPayment(usd('10000'), policy).toFixedString()).toBe('200.00');
    expect(minimumPayment(usd('100'), policy).toFixedString()).toBe('35.00');
    expect(minimumPayment(usd('20'), policy).toFixedString()).toBe('20.00');
    expect(minimumPayment(usd('0'), policy).toFixedString()).toBe('0.00');
  });
});
