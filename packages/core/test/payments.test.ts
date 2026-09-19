import { describe, it, expect } from 'vitest';
import {
  assessFraud, authorize, categoryForMcc, checkRedemption, computeCollateral, computeEarn,
  computeRisk, D, getPolicy, haversineKm, maxSafeSpend, Money, pointsBalance, previewSpend,
  redemptionValue, rewardsCostRatio, tierProgress, valuePortfolio,
  type AuthorizationRequest, type FraudContext, type MerchantCategory, type RewardEntry,
} from '../src/index.js';
import { card, controls, ctx, facility, holding, price, T0, usd } from './helpers.js';

const policy = getPolicy();

const book = () => {
  const { valued } = valuePortfolio(
    [
      holding({ symbol: 'BTC', assetClass: 'BTC', quantity: D('5') }),
      holding({ symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('300000') }),
    ],
    ctx([price('BTC', '100000'), price('USDC', '1.00')]),
  );
  return computeCollateral({ customerId: 'cust_1', jurisdiction: 'US', valued, policy, now: T0 });
};

const fraudCtx = (over: Partial<FraudContext> = {}): FraudContext => ({
  recent: [],
  averageTicket: usd('150'),
  knownCountries: new Set(['US']),
  knownDevices: new Set(['dev_1']),
  accountAgeDays: 400,
  travelNoticeCountries: new Set(),
  policy,
  now: T0,
  ...over,
});

const req = (over: Partial<AuthorizationRequest> = {}): AuthorizationRequest => ({
  requestId: 'req_1',
  cardId: 'card_1',
  amount: usd('120'),
  merchantId: 'm_1',
  merchantName: 'Whole Foods',
  mcc: '5411',
  merchantCountry: 'US',
  entryMode: 'contactless',
  isRecurring: false,
  requestedAt: T0,
  deviceId: 'dev_1',
  ...over,
});

const authCtx = (over: Partial<Parameters<typeof authorize>[1]> = {}) => {
  const collateral = book();
  const f = over.facility ?? facility({ creditLimit: usd('200000') });
  return {
    card: card(),
    facility: f,
    risk: computeRisk({ facility: f, collateral, policy, now: T0 }),
    tier: 'PRIVATE' as const,
    fraud: fraudCtx(),
    fxRate: null,
    spentToday: Money.zero('USD'),
    spentThisMonth: Money.zero('USD'),
    stepUpSatisfied: false,
    policy,
    now: T0,
    ...over,
  };
};

describe('authorization', () => {
  it('approves an ordinary grocery tap', () => {
    const d = authorize(req(), authCtx());
    expect(d.approved).toBe(true);
    expect(d.declineCode).toBeNull();
    expect(d.billingAmount.toFixedString()).toBe('120.00');
    expect(d.checks.every((c) => c.passed)).toBe(true);
    expect(d.authorizationId).toBe('auth_req_1');
  });

  it('records an ordered audit trace on every decision', () => {
    const d = authorize(req(), authCtx());
    const names = d.checks.map((c) => c.name);
    expect(names).toContain('card_status');
    expect(names).toContain('available_credit');
    expect(names.indexOf('card_status')).toBeLessThan(names.indexOf('available_credit'));
  });

  it('declines a frozen card with the right network code', () => {
    const d = authorize(req(), authCtx({ card: card({ status: 'frozen' }) }));
    expect(d.approved).toBe(false);
    expect(d.declineCode).toBe('62_restricted_card');
    expect(d.checks.find((c) => c.name === 'card_status')!.passed).toBe(false);
  });

  it('declines an expired card at the end of its expiry month', () => {
    const c = card({ expMonth: 5, expYear: 2026 });
    expect(authorize(req(), authCtx({ card: c, now: new Date('2026-05-31T23:59:00Z') })).declineCode).toBeNull();
    expect(authorize(req(), authCtx({ card: c, now: new Date('2026-06-01T00:00:00Z') })).declineCode).toBe('54_expired_card');
  });

  it('honours merchant, country and channel controls', () => {
    expect(authorize(req({ mcc: '7995' }), authCtx({ card: card({ controls: controls({ blockedMccs: ['7995'] }) }) })).declineCode).toBe('57_txn_not_permitted');
    expect(authorize(req({ merchantCountry: 'RU' }), authCtx({ card: card({ controls: controls({ blockedCountries: ['RU'] }) }) })).declineCode).toBe('57_txn_not_permitted');
    expect(authorize(req({ entryMode: 'atm', mcc: '6011' }), authCtx({ card: card({ controls: controls({ atmEnabled: false }) }) })).declineCode).toBe('57_txn_not_permitted');
  });

  it('declines for insufficient credit', () => {
    const f = facility({ creditLimit: usd('1000'), principalBalance: usd('950') });
    const d = authorize(req({ amount: usd('100') }), authCtx({ facility: f }));
    expect(d.declineCode).toBe('51_insufficient_funds');
    expect(d.checks.find((c) => c.name === 'available_credit')!.detail).toMatch(/50.00 USD available/);
  });

  it('converts FX and charges the tier markup before testing the limit', () => {
    const d = authorize(
      req({ amount: Money.of('1000', 'EUR'), merchantCountry: 'FR', merchantName: 'Paris Bistro', mcc: '5812' }),
      authCtx({ fxRate: D('1.08'), tier: 'WEALTH' }),
    );
    expect(d.approved).toBe(true);
    // 1000 EUR x 1.08 = 1080 USD, plus a 100bps WEALTH markup = 10.80.
    expect(d.billingAmount.toFixedString()).toBe('1090.80');
    expect(d.fxFee.toFixedString()).toBe('10.80');
  });

  it('charges no FX markup on the top tiers', () => {
    const d = authorize(
      req({ amount: Money.of('1000', 'EUR'), merchantCountry: 'FR' }),
      authCtx({ fxRate: D('1.08'), tier: 'PRIVATE' }),
    );
    expect(d.fxFee.isZero()).toBe(true);
    expect(d.billingAmount.toFixedString()).toBe('1080.00');
  });

  it('declines rather than guessing when no FX rate exists', () => {
    const d = authorize(req({ amount: Money.of('1000', 'JPY'), merchantCountry: 'JP' }), authCtx({ fxRate: null }));
    expect(d.declineCode).toBe('96_system_error');
  });

  it('enforces per-transaction, daily and monthly card limits', () => {
    const lim = controls({ perTransactionLimit: usd('500'), dailyLimit: usd('1000'), monthlyLimit: usd('5000') });
    expect(authorize(req({ amount: usd('600') }), authCtx({ card: card({ controls: lim }) })).declineCode).toBe('61_exceeds_limit');
    expect(authorize(req({ amount: usd('400') }), authCtx({ card: card({ controls: lim }), spentToday: usd('700') })).declineCode).toBe('65_exceeds_frequency');
    expect(authorize(req({ amount: usd('400') }), authCtx({ card: card({ controls: lim }), spentThisMonth: usd('4800') })).declineCode).toBe('65_exceeds_frequency');
  });

  it('pauses discretionary spend but not essentials when restricted', () => {
    const collateral = book();
    const f = facility({
      creditLimit: usd('10000000'),
      principalBalance: Money.of(collateral.eligibleCollateralValue.amount.times(D('0.72')), 'USD'),
    });
    const risk = computeRisk({ facility: f, collateral, policy, now: T0 });
    expect(risk.state).toBe('restricted');

    const luxury = authorize(req({ mcc: '5944', merchantName: 'Jeweller', amount: usd('200') }), authCtx({ facility: f, risk }));
    expect(luxury.declineCode).toBe('62_restricted_card');

    // Groceries are essential, so they still go through the risk gate...
    const groceries = authorize(req({ mcc: '5411', amount: usd('200') }), authCtx({ facility: f, risk }));
    expect(groceries.checks.find((c) => c.name === 'risk_state')!.passed).toBe(true);
  });

  it('blocks spend that would breach the LTV ceiling even inside the limit', () => {
    const collateral = book();
    const f = facility({
      creditLimit: usd('100000000'),
      principalBalance: Money.of(collateral.eligibleCollateralValue.amount.times(D('0.65')), 'USD'),
    });
    const risk = computeRisk({ facility: f, collateral, policy, now: T0 });
    const d = authorize(req({ amount: usd('100000') }), authCtx({ facility: f, risk }));
    expect(d.declineCode).toBe('62_restricted_card');
    expect(d.checks.find((c) => c.name === 'projected_ltv')!.passed).toBe(false);
  });

  it('returns the original decision when the network replays a request', () => {
    const first = authorize(req(), authCtx());
    const replay = authorize(req(), authCtx({ duplicateOf: first }));
    expect(replay.authorizationId).toBe(first.authorizationId);
    expect(replay.approved).toBe(first.approved);
    expect(replay.billingAmount.toFixedString()).toBe(first.billingAmount.toFixedString());
  });

  it('demands step-up on a high-risk merchant and accepts it once satisfied', () => {
    const without = authorize(req({ mcc: '6051', merchantName: 'Exchange' }), authCtx());
    expect(without.declineCode).toBe('59_suspected_fraud');
    const withStepUp = authorize(req({ mcc: '6051', merchantName: 'Exchange' }), authCtx({ stepUpSatisfied: true }));
    expect(withStepUp.approved).toBe(true);
  });
});

describe('fraud signals', () => {
  it('scores a familiar transaction at zero', () => {
    const a = assessFraud(req(), fraudCtx());
    expect(a.score.toFixed()).toBe('0');
    expect(a.decline).toBe(false);
  });

  it('flags velocity and card-testing declines', () => {
    const recent = Array.from({ length: 9 }, (_, i) => ({
      amount: usd('20'), at: new Date(T0.getTime() - i * 30_000),
      merchantCountry: 'US', declined: i < 4,
    }));
    const a = assessFraud(req(), fraudCtx({ recent }));
    expect(a.signals.map((s) => s.code)).toEqual(expect.arrayContaining(['velocity', 'decline_probing']));
    expect(a.requireStepUp).toBe(true);
  });

  it('flags impossible travel for card-present transactions only', () => {
    const prior = {
      amount: usd('50'), at: new Date(T0.getTime() - 3_600_000),
      merchantCountry: 'US', geo: { lat: 40.71, lon: -74.01 }, declined: false,
    };
    const tokyo = { lat: 35.68, lon: 139.69 };
    const present = assessFraud(
      req({ merchantCountry: 'JP', geo: tokyo, entryMode: 'contactless' }),
      fraudCtx({ recent: [prior] }),
    );
    expect(present.signals.map((s) => s.code)).toContain('impossible_travel');

    const online = assessFraud(
      req({ merchantCountry: 'JP', geo: tokyo, entryMode: 'ecommerce' }),
      fraudCtx({ recent: [prior] }),
    );
    expect(online.signals.map((s) => s.code)).not.toContain('impossible_travel');
  });

  it('suppresses the new-country signal when travel notice is on file', () => {
    const noNotice = assessFraud(req({ merchantCountry: 'AE' }), fraudCtx());
    expect(noNotice.signals.map((s) => s.code)).toContain('new_country');
    const withNotice = assessFraud(req({ merchantCountry: 'AE' }), fraudCtx({ travelNoticeCountries: new Set(['AE']) }));
    expect(withNotice.signals.map((s) => s.code)).not.toContain('new_country');
  });

  it('flags an outsized ticket against the trailing average', () => {
    const a = assessFraud(req({ amount: usd('5000') }), fraudCtx({ averageTicket: usd('150') }));
    expect(a.signals.map((s) => s.code)).toContain('amount_anomaly');
  });

  it('never declines a recurring charge on signals alone', () => {
    const recent = Array.from({ length: 12 }, (_, i) => ({
      amount: usd('20'), at: new Date(T0.getTime() - i * 10_000), merchantCountry: 'US', declined: true,
    }));
    const a = assessFraud(req({ isRecurring: true, merchantCountry: 'AE', entryMode: 'ecommerce' }), fraudCtx({ recent }));
    expect(a.score.gt(D('0.5'))).toBe(true);
    expect(a.decline).toBe(false);
  });

  it('measures distance correctly', () => {
    const km = haversineKm({ lat: 40.71, lon: -74.01 }, { lat: 51.51, lon: -0.13 });
    expect(km).toBeGreaterThan(5500);
    expect(km).toBeLessThan(5600);
    expect(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBe(0);
  });

  it('maps merchant category codes to spend categories', () => {
    expect(categoryForMcc('5411')).toBe('groceries');
    expect(categoryForMcc('5541')).toBe('fuel_ev');
    expect(categoryForMcc('5812')).toBe('dining');
    expect(categoryForMcc('7011')).toBe('hotels');
    expect(categoryForMcc('6011')).toBe('cash_advance');
    expect(categoryForMcc('not-a-code')).toBe('other');
  });
});

describe('rewards', () => {
  it('applies the category multiplier under the cap', () => {
    const r = computeEarn({
      tier: 'PRIVATE', category: 'travel', billingAmount: usd('1000'),
      bonusSpendThisMonth: Money.zero('USD'), policy,
    });
    expect(r.points.toFixed()).toBe('4000'); // 4x travel on PRIVATE
    expect(r.capReached).toBe(false);
  });

  it('splits a transaction that straddles the monthly bonus cap', () => {
    const r = computeEarn({
      tier: 'PRIVATE', category: 'travel', billingAmount: usd('4000'),
      bonusSpendThisMonth: usd('3000'), policy, // cap is 5,000
    });
    // 2,000 at 4x = 8,000 points, 2,000 at the 1x base = 2,000 points.
    expect(r.points.toFixed()).toBe('10000');
    expect(r.bonusEligibleSpend.toFixedString()).toBe('2000.00');
    expect(r.baseOnlySpend.toFixedString()).toBe('2000.00');
    expect(r.explanation).toMatch(/after the monthly bonus cap/);
  });

  it('drops to the base rate once the cap is exhausted', () => {
    const r = computeEarn({
      tier: 'PRIVATE', category: 'travel', billingAmount: usd('1000'),
      bonusSpendThisMonth: usd('5000'), policy,
    });
    expect(r.points.toFixed()).toBe('1000'); // base rate only
    expect(r.capReached).toBe(true);
  });

  it('caps the top tier too, so the rewards liability stays bounded', () => {
    // Uncapped 5x at a cent a point is a 5% rebate funded by 1.85%
    // interchange. Every tier has to have a ceiling.
    const r = computeEarn({
      tier: 'ULTRA', category: 'travel', billingAmount: usd('100000'),
      bonusSpendThisMonth: Money.zero('USD'), policy,
    });
    // 10,000 at 5x = 50,000 points, 90,000 at the 1x base = 90,000 points.
    expect(r.points.toFixed()).toBe('140000');
    expect(r.capReached).toBe(false);
    expect(r.effectiveRate.lt(D('1.5'))).toBe(true);
  });

  it('leaves every tier margin-positive on a realistic month of spend', () => {
    // The sustainability condition from PRD §15.1: interchange plus the
    // amortised annual fee must cover the rewards accrued. It is not enough
    // for rewards to be "competitive" — an uncapped multiplier at a cent a
    // point loses money on every single transaction.
    const month: [MerchantCategory, string][] = [
      ['travel', '12000'], ['hotels', '8000'], ['dining', '6000'],
      ['groceries', '3000'], ['retail', '9000'], ['ecommerce', '7000'],
    ];

    for (const tier of ['WEALTH', 'WEALTH_PLUS', 'PRIVATE', 'ULTRA'] as const) {
      let bonusSpend = Money.zero('USD');
      let cost = Money.zero('USD');
      let spend = Money.zero('USD');

      for (const [category, amount] of month) {
        const billingAmount = usd(amount);
        const r = computeEarn({ tier, category, billingAmount, bonusSpendThisMonth: bonusSpend, policy });
        cost = cost.plus(r.accrualCost);
        spend = spend.plus(billingAmount);
        bonusSpend = bonusSpend.plus(r.bonusEligibleSpend);
      }

      // A conservative blended interchange rate across those categories.
      const interchange = spend.times(D('0.0165'));
      const monthlyFee = Money.of(policy.tiers[tier].annualFee, 'USD').dividedBy(12);
      const margin = interchange.plus(monthlyFee).minus(cost);

      expect(margin.isPositive(), `${tier} rewards margin`).toBe(true);
      // And the accrual cost must stay in a sane band even before the fee.
      expect(rewardsCostRatio(cost, spend).lt(D('0.02')), `${tier} accrual ratio`).toBe(true);
    }
  });

  it('makes the blended rate fall as spend grows past the bonus cap', () => {
    // The cap is what bounds the liability: the more a customer spends, the
    // closer their effective rate moves to the base rate.
    const small = computeEarn({
      tier: 'ULTRA', category: 'travel', billingAmount: usd('5000'),
      bonusSpendThisMonth: Money.zero('USD'), policy,
    });
    const large = computeEarn({
      tier: 'ULTRA', category: 'travel', billingAmount: usd('100000'),
      bonusSpendThisMonth: Money.zero('USD'), policy,
    });
    expect(small.effectiveRate.gt(large.effectiveRate)).toBe(true);
    expect(large.effectiveRate.lt(D('1.5'))).toBe(true);
  });

  it('claws points back on a refund', () => {
    const r = computeEarn({
      tier: 'PRIVATE', category: 'travel', billingAmount: usd('-1000'),
      bonusSpendThisMonth: Money.zero('USD'), policy,
    });
    expect(r.points.isNegative()).toBe(true);
  });

  it('books an accrual cost for every point earned', () => {
    const r = computeEarn({
      tier: 'PRIVATE', category: 'dining', billingAmount: usd('500'),
      bonusSpendThisMonth: Money.zero('USD'), policy,
    });
    expect(r.points.toFixed()).toBe('2000'); // 4x dining
    expect(r.accrualCost.toFixedString()).toBe('20.00');
    expect(rewardsCostRatio(r.accrualCost, usd('500')).toFixed()).toBe('0.04');
  });

  it('tracks pending, posted and redeemed balances', () => {
    const e = (over: Partial<RewardEntry>): RewardEntry => ({
      entryId: 'r', customerId: 'c1', type: 'earn_pending', points: D('0'),
      transactionId: null, category: null, rateApplied: null,
      description: '', occurredAt: T0, ...over,
    });
    const b = pointsBalance([
      e({ type: 'earn_pending', points: D('5000') }),
      e({ type: 'earn_posted', points: D('5000') }),
      e({ type: 'earn_pending', points: D('1200') }),
      e({ type: 'redemption', points: D('2000') }),
    ]);
    expect(b.posted.toFixed()).toBe('3000');
    expect(b.pending.toFixed()).toBe('1200');
    expect(b.redeemed.toFixed()).toBe('2000');
    expect(b.lifetimeEarned.toFixed()).toBe('5000');
  });

  it('values redemptions by route', () => {
    expect(redemptionValue(D('10000'), 'statement_credit', 'USD').toFixedString()).toBe('100.00');
    expect(redemptionValue(D('10000'), 'travel', 'USD').toFixedString()).toBe('150.00');
  });

  it('refuses redemptions that break the rules', () => {
    expect(checkRedemption(D('10000'), D('500'), 'statement_credit', 'USD', true).reason).toMatch(/minimum_1000/);
    expect(checkRedemption(D('100'), D('5000'), 'statement_credit', 'USD', true).reason).toBe('insufficient_points');
    expect(checkRedemption(D('10000'), D('-5'), 'statement_credit', 'USD', true).reason).toMatch(/must_be_positive/);
    expect(checkRedemption(D('10000'), D('5000'), 'crypto', 'USD', false).reason).toMatch(/not_permitted_in_jurisdiction/);
    expect(checkRedemption(D('10000'), D('5000'), 'statement_credit', 'USD', true).allowed).toBe(true);
  });

  it('reports progress toward the next tier by the better of two routes', () => {
    const p = tierProgress('WEALTH', usd('60000'), usd('5000'));
    expect(p.nextTier).toBe('WEALTH_PLUS');
    expect(p.progress.toFixed()).toBe('0.6');
    expect(p.collateralRequired.toFixedString()).toBe('40000.00');

    const top = tierProgress('ULTRA', usd('10000000'), usd('1000000'));
    expect(top.nextTier).toBeNull();
  });
});

describe('spend guidance', () => {
  it('answers "how much can I spend" with the risk-bounded number', () => {
    const collateral = book();
    const f = facility({ creditLimit: usd('100000000') });
    const risk = computeRisk({ facility: f, collateral, policy, now: T0 });
    const safe = maxSafeSpend(f, risk, policy);
    // The watch ceiling, not the credit limit, binds here.
    expect(safe.toFixedString()).toBe(collateral.eligibleCollateralValue.times(D('0.6')).roundDown().toFixedString());
    expect(safe.lt(f.creditLimit)).toBe(true);
  });

  it('previews the impact of a purchase without committing it', () => {
    const collateral = book();
    const f = facility({ creditLimit: usd('200000'), principalBalance: usd('10000') });
    const risk = computeRisk({ facility: f, collateral, policy, now: T0 });
    const p = previewSpend(usd('25000'), f, risk, policy, D('75000'));
    expect(p.affordable).toBe(true);
    expect(p.availableCreditAfter.toFixedString()).toBe('165000.00');
    expect(p.ltvAfter!.gt(risk.effectiveLtv!)).toBe(true);
    expect(p.explanation).toMatch(/would leave/);
  });

  it('says plainly when a purchase is unaffordable', () => {
    const collateral = book();
    const f = facility({ creditLimit: usd('1000') });
    const risk = computeRisk({ facility: f, collateral, policy, now: T0 });
    const p = previewSpend(usd('5000'), f, risk, policy, D('0'));
    expect(p.affordable).toBe(false);
    expect(p.explanation).toMatch(/above your available credit/);
  });
});
