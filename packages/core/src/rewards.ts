/**
 * Rewards engine (PRD §15).
 *
 * Points are a real liability the moment they are earned, so the engine is
 * built around the economics rather than the marketing: every accrual has a
 * cost, every cost lands in the ledger, and the caps that keep the programme
 * solvent are enforced here rather than trusted to a campaign config.
 */
import { clamp, D, Decimal, Money, ZERO } from './money.js';
import { tierPolicy, type RiskPolicy } from './policy.js';
import type { MerchantCategory, RedemptionKind, RewardEntry, Tier } from './types.js';

/** Cash value of one point when redeemed as a statement credit. */
export const POINT_VALUE_USD = '0.01';

/** Redemption value per point, by redemption route. Travel is worth more. */
const REDEMPTION_VALUE: Record<RedemptionKind, string> = {
  statement_credit: '0.010',
  travel: '0.015',
  transfer_partner: '0.013',
  crypto: '0.009',
};

export interface EarnInput {
  readonly tier: Tier;
  readonly category: MerchantCategory;
  readonly billingAmount: Money;
  /** Bonus-category spend already posted this calendar month. */
  readonly bonusSpendThisMonth: Money;
  readonly policy: RiskPolicy;
}

export interface EarnResult {
  readonly points: Decimal;
  readonly baseRate: Decimal;
  readonly effectiveRate: Decimal;
  /** Spend that earned the category multiplier. */
  readonly bonusEligibleSpend: Money;
  /** Spend that fell past the monthly cap and earned the base rate only. */
  readonly baseOnlySpend: Money;
  readonly capReached: boolean;
  /** Accrual cost booked to the ledger at redemption value. */
  readonly accrualCost: Money;
  readonly explanation: string;
}

/**
 * Points for one transaction.
 *
 * Bonus categories are capped monthly. When a transaction straddles the cap
 * the spend is split: the part under the cap earns the multiplier, the rest
 * earns the base rate. Silently dropping the whole transaction to base rate
 * at the boundary is the kind of detail customers notice and resent.
 */
export const computeEarn = (input: EarnInput): EarnResult => {
  const tp = tierPolicy(input.policy, input.tier);
  const currency = input.billingAmount.currency;
  const baseRate = D(tp.baseEarnRate);

  const multiplier = tp.categoryMultipliers[input.category];
  const capRaw = D(tp.bonusCategoryMonthlyCap);
  const uncapped = capRaw.isNegative();

  // Refunds and reversals arrive as negative spend; they claw points back at
  // the base rate rather than trying to reconstruct which cap bucket the
  // original purchase consumed.
  if (!input.billingAmount.isPositive()) {
    const points = input.billingAmount.amount.times(baseRate).toDecimalPlaces(0, Decimal.ROUND_CEIL);
    return {
      points, baseRate, effectiveRate: baseRate,
      bonusEligibleSpend: Money.zero(currency),
      baseOnlySpend: input.billingAmount,
      capReached: false,
      accrualCost: Money.of(points.times(D(POINT_VALUE_USD)), currency).round(),
      explanation: `${points.toFixed()} points reversed at the ${baseRate} point base rate.`,
    };
  }

  if (!multiplier) {
    const points = input.billingAmount.amount.times(baseRate).toDecimalPlaces(0, Decimal.ROUND_FLOOR);
    return {
      points, baseRate, effectiveRate: baseRate,
      bonusEligibleSpend: Money.zero(currency),
      baseOnlySpend: input.billingAmount,
      capReached: false,
      accrualCost: Money.of(points.times(D(POINT_VALUE_USD)), currency).round(),
      explanation: `${points.toFixed()} points at the ${baseRate}x base rate on ${input.billingAmount.toFixedString()} ${currency}.`,
    };
  }

  const rate = D(multiplier);
  const cap = uncapped ? null : Money.of(capRaw, currency);
  const remainingCap = cap
    ? cap.minus(input.bonusSpendThisMonth).clampPositive()
    : input.billingAmount;

  const bonusEligibleSpend = input.billingAmount.min(remainingCap);
  const baseOnlySpend = input.billingAmount.minus(bonusEligibleSpend);

  const points = bonusEligibleSpend.amount.times(rate)
    .plus(baseOnlySpend.amount.times(baseRate))
    .toDecimalPlaces(0, Decimal.ROUND_FLOOR);

  const effectiveRate = input.billingAmount.isPositive()
    ? points.dividedBy(input.billingAmount.amount) : baseRate;

  const capReached = cap !== null && !remainingCap.isPositive();

  const explanation = baseOnlySpend.isPositive()
    ? `${points.toFixed()} points: ${bonusEligibleSpend.toFixedString()} at ${rate}x (${input.category.replace('_', ' ')}) and ${baseOnlySpend.toFixedString()} at ${baseRate}x after the monthly bonus cap.`
    : `${points.toFixed()} points at ${rate}x on ${input.category.replace('_', ' ')} spend of ${input.billingAmount.toFixedString()} ${currency}.`;

  return {
    points, baseRate, effectiveRate, bonusEligibleSpend, baseOnlySpend, capReached,
    accrualCost: Money.of(points.times(D(POINT_VALUE_USD)), currency).round(),
    explanation,
  };
};

export const pointsBalance = (entries: readonly RewardEntry[]): {
  posted: Decimal; pending: Decimal; lifetimeEarned: Decimal; redeemed: Decimal;
} => {
  let posted = ZERO, pending = ZERO, lifetimeEarned = ZERO, redeemed = ZERO;
  for (const e of entries) {
    switch (e.type) {
      case 'earn_pending': pending = pending.plus(e.points); break;
      case 'earn_posted':
        // Posting moves points out of pending and into the redeemable balance.
        pending = pending.minus(e.points);
        posted = posted.plus(e.points);
        lifetimeEarned = lifetimeEarned.plus(e.points);
        break;
      case 'reversal':
        posted = posted.minus(e.points.abs());
        lifetimeEarned = lifetimeEarned.minus(e.points.abs());
        break;
      case 'redemption':
        posted = posted.minus(e.points.abs());
        redeemed = redeemed.plus(e.points.abs());
        break;
      case 'expiry': posted = posted.minus(e.points.abs()); break;
      case 'adjustment': posted = posted.plus(e.points); break;
    }
  }
  return {
    posted: posted.lt(0) ? ZERO : posted,
    pending: pending.lt(0) ? ZERO : pending,
    lifetimeEarned, redeemed,
  };
};

export const redemptionValue = (points: Decimal, kind: RedemptionKind, currency: string): Money =>
  Money.of(points.times(D(REDEMPTION_VALUE[kind])), currency).round(Decimal.ROUND_FLOOR);

export const pointsForValue = (value: Money, kind: RedemptionKind): Decimal =>
  value.amount.dividedBy(D(REDEMPTION_VALUE[kind])).toDecimalPlaces(0, Decimal.ROUND_CEIL);

export interface RedemptionCheck {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly value: Money;
}

/** Minimum redeemable balance, by route. Keeps servicing costs sane. */
const MINIMUM_POINTS: Record<RedemptionKind, number> = {
  statement_credit: 1_000, travel: 2_000, transfer_partner: 5_000, crypto: 2_500,
};

export const checkRedemption = (
  availablePoints: Decimal, requestedPoints: Decimal, kind: RedemptionKind,
  currency: string, jurisdictionAllowsCrypto: boolean,
): RedemptionCheck => {
  const value = redemptionValue(requestedPoints, kind, currency);

  if (requestedPoints.lte(0)) {
    return { allowed: false, reason: 'redemption_amount_must_be_positive', value };
  }
  if (requestedPoints.gt(availablePoints)) {
    return { allowed: false, reason: 'insufficient_points', value };
  }
  if (requestedPoints.lt(MINIMUM_POINTS[kind])) {
    return { allowed: false, reason: `minimum_${MINIMUM_POINTS[kind]}_points_for_${kind}`, value };
  }
  if (kind === 'crypto' && !jurisdictionAllowsCrypto) {
    return { allowed: false, reason: 'crypto_redemption_not_permitted_in_jurisdiction', value };
  }
  return { allowed: true, reason: null, value };
};

/**
 * Rewards cost as a share of spend — the number that tells you whether the
 * programme is affordable (PRD §26 "reward cost as % of spend").
 */
export const rewardsCostRatio = (accrualCost: Money, spend: Money): Decimal =>
  spend.isPositive() ? accrualCost.amount.dividedBy(spend.amount) : ZERO;

export interface TierBenefits {
  readonly tier: Tier;
  readonly annualFee: Money;
  readonly loungeVisitsPerYear: number;
  readonly loungeUnlimited: boolean;
  readonly conciergeIncluded: boolean;
  readonly fxMarkupBps: number;
  readonly baseEarnRate: string;
  readonly categoryMultipliers: Readonly<Partial<Record<MerchantCategory, string>>>;
  readonly bonusCategoryMonthlyCap: string | null;
}

export const benefitsForTier = (policy: RiskPolicy, tier: Tier): TierBenefits => {
  const tp = tierPolicy(policy, tier);
  return {
    tier,
    annualFee: Money.of(tp.annualFee, policy.facilityCurrency),
    loungeVisitsPerYear: tp.loungeVisitsPerYear < 0 ? Number.POSITIVE_INFINITY : tp.loungeVisitsPerYear,
    loungeUnlimited: tp.loungeVisitsPerYear < 0,
    conciergeIncluded: tp.conciergeIncluded,
    fxMarkupBps: tp.fxMarkupBps,
    baseEarnRate: tp.baseEarnRate,
    categoryMultipliers: tp.categoryMultipliers,
    bonusCategoryMonthlyCap: D(tp.bonusCategoryMonthlyCap).isNegative() ? null : tp.bonusCategoryMonthlyCap,
  };
};

/** Whether a lounge visit is covered by the tier allowance. */
export const loungeVisitCovered = (
  policy: RiskPolicy, tier: Tier, visitsUsedThisYear: number,
): { covered: boolean; remaining: number | null } => {
  const tp = tierPolicy(policy, tier);
  if (tp.loungeVisitsPerYear < 0) return { covered: true, remaining: null };
  const remaining = Math.max(0, tp.loungeVisitsPerYear - visitsUsedThisYear);
  return { covered: remaining > 0, remaining };
};

/** Progress toward the next tier, driven by eligible collateral and annual spend. */
export const tierProgress = (
  currentTier: Tier, eligibleCollateral: Money, trailingAnnualSpend: Money,
): { nextTier: Tier | null; collateralRequired: Money; spendRequired: Money; progress: Decimal } => {
  const ladder: { tier: Tier; collateral: string; spend: string }[] = [
    { tier: 'WEALTH_PLUS', collateral: '100000', spend: '25000' },
    { tier: 'PRIVATE', collateral: '500000', spend: '100000' },
    { tier: 'ULTRA', collateral: '2500000', spend: '500000' },
  ];
  const currentIndex = ['WEALTH', 'WEALTH_PLUS', 'PRIVATE', 'ULTRA'].indexOf(currentTier);
  const next = ladder[currentIndex];
  const currency = eligibleCollateral.currency;

  if (!next) {
    return {
      nextTier: null, collateralRequired: Money.zero(currency),
      spendRequired: Money.zero(currency), progress: D(1),
    };
  }

  const collateralRequired = Money.of(next.collateral, currency);
  const spendRequired = Money.of(next.spend, currency);
  const collateralProgress = clamp(eligibleCollateral.amount.dividedBy(collateralRequired.amount), 0, 1);
  const spendProgress = clamp(trailingAnnualSpend.amount.dividedBy(spendRequired.amount), 0, 1);

  return {
    nextTier: next.tier,
    collateralRequired: collateralRequired.minus(eligibleCollateral).clampPositive(),
    spendRequired: spendRequired.minus(trailingAnnualSpend).clampPositive(),
    // Either route qualifies, so progress is the better of the two.
    progress: collateralProgress.gt(spendProgress) ? collateralProgress : spendProgress,
  };
};
