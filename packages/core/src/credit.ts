/**
 * Credit engine (PRD §11).
 *
 *   Credit Capacity = Base Collateral Capacity
 *                   x Portfolio Risk Adjustment
 *                   x Liquidity Adjustment
 *                   x Concentration Adjustment
 *                   x Customer / Repayment Adjustment
 *                   - Existing Exposure
 *
 * Every term is computed separately and kept on the decision, because PRD §16
 * requires the AI agent to explain *why* a limit is what it is, and an
 * explanation assembled after the fact from a single number is a fabrication.
 *
 * The engine is deliberately monotonic: no term can ever raise capacity above
 * the base collateral capacity. Adjustments only cut.
 */
import { clamp, D, Decimal, Money, ONE, pct, ZERO } from './money.js';
import { jurisdictionPolicy, tierPolicy, type RiskPolicy } from './policy.js';
import { shockedCollateralValue } from './collateral.js';
import type {
  CollateralSummary, CreditDecision, CreditFacility, CreditFactorBreakdown,
  UnderwritingInputs,
} from './types.js';

export interface CreditInputs {
  readonly customerId: string;
  readonly collateral: CollateralSummary;
  readonly underwriting: UnderwritingInputs;
  /** Debt already drawn against this facility, plus outstanding holds. */
  readonly existingExposure: Money;
  readonly previousLimit: Money | null;
  readonly policy: RiskPolicy;
  readonly now: Date;
}

/**
 * Portfolio risk adjustment.
 *
 * Asset volatility is already priced once, in the collateral haircut. Charging
 * for it again here would double-count it and drive credit lines far below
 * what the collateral actually supports. So this term prices something the
 * haircut cannot see: how the book as a whole behaves under a *specific
 * adverse scenario*, including correlation between positions.
 *
 * A book that retains at least the policy's expected share of its collateral
 * under the baseline scenario is unpenalised. One that holds up worse — because
 * it is concentrated in the shocked asset — is cut in proportion.
 */
export const portfolioRiskAdjustment = (
  collateral: CollateralSummary, policy: RiskPolicy,
): { factor: Decimal; survivalRatio: Decimal | null } => {
  const floor = D(policy.credit.minPortfolioRiskAdjustment);
  if (!collateral.eligibleCollateralValue.isPositive()) return { factor: ONE, survivalRatio: null };

  const scenario = policy.stressScenarios.find((sc) => sc.id === policy.credit.baselineStressScenarioId);
  if (!scenario) return { factor: ONE, survivalRatio: null };

  const survived = shockedCollateralValue(collateral, scenario, policy);
  const survivalRatio = survived.amount.dividedBy(collateral.eligibleCollateralValue.amount);
  const expected = D(policy.credit.expectedStressSurvival);

  if (survivalRatio.gte(expected)) return { factor: ONE, survivalRatio };
  return { factor: clamp(survivalRatio.dividedBy(expected), floor, ONE), survivalRatio };
};

/**
 * Liquidity adjustment.
 *
 * Per-asset market depth is already applied inside the collateral value. What
 * remains is a whole-book effect: a portfolio whose *average* liquidity sits
 * below the level we can reliably exit in a stressed window gets less credit,
 * because the risk is that we cannot unwind all of it at once.
 */
export const liquidityAdjustment = (
  weightedLiquidity: Decimal, policy: RiskPolicy,
): Decimal => {
  const adequate = D(policy.credit.adequateLiquidity);
  if (weightedLiquidity.gte(adequate)) return ONE;
  return clamp(
    weightedLiquidity.dividedBy(adequate), D(policy.credit.minLiquidityAdjustment), ONE,
  );
};

/**
 * Concentration adjustment.
 *
 * The collateral engine holds the binding concentration control: a per-asset
 * and per-issuer cap that cuts an over-weight position directly. Where that
 * cap has already bitten, concentration is paid for and this term stands at
 * 1.0. It only does work for books that are concentrated but still inside
 * every cap — the case the collateral engine deliberately leaves alone.
 */
export const concentrationAdjustment = (
  topConcentration: Decimal, capAlreadyBinding: boolean, policy: RiskPolicy,
): Decimal => {
  if (capAlreadyBinding) return ONE;
  const floor = D(policy.credit.minConcentrationAdjustment);
  const threshold = D('0.5');
  if (topConcentration.lte(threshold)) return ONE;
  const excess = topConcentration.minus(threshold).dividedBy(ONE.minus(threshold));
  return clamp(ONE.minus(excess.times(ONE.minus(floor))), floor, ONE);
};

/**
 * Customer / repayment adjustment — the only term that can exceed 1.0, and
 * only for customers with tenure and a clean repayment record.
 */
export const customerAdjustment = (u: UnderwritingInputs, policy: RiskPolicy): Decimal => {
  const cp = policy.credit;
  let adj = ONE;

  // Tenure: a new account earns none of the bonus, a matured one earns it all.
  const tenureProgress = clamp(D(u.tenureMonths).dividedBy(cp.tenureMaturityMonths), 0, 1);
  const repaymentQuality = u.onTimeRate ?? ZERO;
  adj = adj.plus(D(cp.repaymentBonus).times(tenureProgress).times(repaymentQuality));

  // Delinquencies cut hard and do not decay inside this calculation.
  adj = adj.minus(D(cp.delinquencyPenalty).times(u.delinquencies30d));

  // Fraud score bleeds capacity away continuously rather than at a cliff.
  adj = adj.minus(u.fraudScore.times(D('0.5')));

  return clamp(adj, D(cp.minCustomerAdjustment), D(cp.maxCustomerAdjustment));
};

/** Hard stops. Any reason here means no credit at all, regardless of collateral. */
export const underwritingDeclines = (u: UnderwritingInputs, policy: RiskPolicy): string[] => {
  const reasons: string[] = [];
  if (u.kycStatus !== 'approved') reasons.push(`kyc_${u.kycStatus}`);
  if (!u.sanctionsClear) reasons.push('sanctions_screening_not_clear');
  if (!u.pepReviewCleared) reasons.push('pep_review_outstanding');
  if (u.customerStatus === 'suspended' || u.customerStatus === 'closed') {
    reasons.push(`customer_${u.customerStatus}`);
  }
  const jp = jurisdictionPolicy(policy, u.jurisdiction);
  if (!jp?.enabled) reasons.push(`jurisdiction_not_enabled_${u.jurisdiction}`);
  if (jp?.requiresIncomeVerification && u.monthlyIncome === null) {
    reasons.push('income_verification_required');
  }
  if (u.fraudScore.gte(D(policy.fraud.declineThreshold))) reasons.push('fraud_risk_too_high');
  return reasons;
};

export const decideCredit = (input: CreditInputs): CreditDecision => {
  const { policy, collateral, underwriting: u, now } = input;
  const currency = policy.facilityCurrency;
  const tp = tierPolicy(policy, u.tier);
  const jp = jurisdictionPolicy(policy, u.jurisdiction);

  // Hard stops are compliance and account-status failures. They zero the
  // limit outright, whatever the collateral says.
  const declineReasons = underwritingDeclines(u, policy);
  const hardStop = declineReasons.length > 0;

  const advanceRate = D(policy.thresholds.maxOriginationLtv);
  const baseCollateralCapacity = collateral.eligibleCollateralValue.times(advanceRate);

  const { factor: fRisk, survivalRatio } = portfolioRiskAdjustment(collateral, policy);
  const fLiquidity = liquidityAdjustment(collateral.weightedLiquidity, policy);
  const fConcentration = concentrationAdjustment(
    collateral.topConcentration, collateral.concentrationCapBinding, policy,
  );
  const fCustomer = customerAdjustment(u, policy);

  const tierCap = Money.of(tp.maxCreditLimit, currency);
  const jurisdictionCap = Money.of(jp?.maxCreditLimit ?? '0', currency);

  let capacity = baseCollateralCapacity
    .times(fRisk).times(fLiquidity).times(fConcentration).times(fCustomer);

  // The customer adjustment is the one term that can exceed 1.0. Cap the
  // result at the unadjusted collateral capacity so a good payment history
  // can never lend against collateral that is not there.
  capacity = capacity.min(baseCollateralCapacity);

  const explanations: string[] = [];
  explanations.push(
    `Eligible collateral of ${collateral.eligibleCollateralValue.toDisplayString()} ${currency} supports a base capacity of ${baseCollateralCapacity.toDisplayString()} ${currency} at the ${pct(advanceRate, 0)} advance rate.`,
  );
  if (fRisk.lt(ONE) && survivalRatio) {
    explanations.push(`Under our baseline adverse scenario your collateral would retain ${pct(survivalRatio)} of its eligible value, below the ${pct(D(policy.credit.expectedStressSurvival))} we look for, which reduces capacity by ${pct(ONE.minus(fRisk))}.`);
  }
  if (fLiquidity.lt(ONE)) {
    explanations.push(`Collateral liquidity of ${pct(collateral.weightedLiquidity)} is below the ${pct(D(policy.credit.adequateLiquidity))} we consider adequate for an orderly exit, which reduces capacity by ${pct(ONE.minus(fLiquidity))}.`);
  }
  if (collateral.concentrationCapBinding) {
    explanations.push(`Your largest position is ${pct(collateral.topConcentration)} of eligible collateral, so a concentration cap has already been applied to its collateral value.`);
  } else if (fConcentration.lt(ONE)) {
    explanations.push(`Your largest position is ${pct(collateral.topConcentration)} of eligible collateral, which reduces capacity by ${pct(ONE.minus(fConcentration))}.`);
  }
  if (fCustomer.gt(ONE)) {
    explanations.push(`Account tenure and repayment history add ${pct(fCustomer.minus(ONE))}.`);
  } else if (fCustomer.lt(ONE)) {
    explanations.push(`Account history reduces capacity by ${pct(ONE.minus(fCustomer))}.`);
  }

  // Income multiple, where the policy sets one and income is verified.
  if (policy.credit.incomeMultipleCap && u.monthlyIncome) {
    const incomeCap = u.monthlyIncome.times(12).times(D(policy.credit.incomeMultipleCap));
    if (incomeCap.lt(capacity)) {
      explanations.push(`Capacity is capped at ${policy.credit.incomeMultipleCap}x verified annual income.`);
      capacity = incomeCap;
    }
  }

  if (tierCap.lt(capacity)) {
    explanations.push(`Capacity is capped at the ${u.tier} tier ceiling of ${tierCap.toDisplayString()} ${currency}.`);
    capacity = tierCap;
  }
  if (jurisdictionCap.lt(capacity)) {
    explanations.push(`Capacity is capped at the ${u.jurisdiction} programme ceiling of ${jurisdictionCap.toDisplayString()} ${currency}.`);
    capacity = jurisdictionCap;
  }

  // Round DOWN to a clean step — never round a credit line up.
  let creditLimit = capacity.roundDownToStep(tp.limitStep).clampPositive();
  const steppedCapacity = creditLimit;

  // The tier minimum is an *origination* floor: it decides whether we open a
  // facility, not whether we keep one open. Applying it to a live account
  // whose collateral has fallen would zero the limit of a customer carrying a
  // balance and put them instantly over limit — a harm they did not cause.
  const minLimit = Money.of(tp.minCreditLimit, currency);
  const hasDrawnBalance = input.existingExposure.isPositive();
  if (!hardStop && creditLimit.lt(minLimit) && !hasDrawnBalance) {
    declineReasons.push('below_minimum_viable_limit');
    explanations.push(`Calculated capacity is below the ${u.tier} minimum of ${minLimit.toDisplayString()} ${currency}.`);
  }

  if (declineReasons.length > 0) creditLimit = Money.zero(currency);

  // A live facility's limit may not fall below what is already drawn. The risk
  // engine governs that exposure through the LTV ladder and, if it comes to
  // it, the liquidation path — not by retroactively shrinking the limit.
  if (!hardStop && creditLimit.lt(input.existingExposure)) {
    explanations.push(
      `Calculated capacity of ${creditLimit.toDisplayString()} ${currency} is below your drawn balance, so the limit is held at the current balance of ${input.existingExposure.toDisplayString()} ${currency}. New spending is governed by your risk state.`,
    );
    creditLimit = input.existingExposure;
  }

  const breakdown: CreditFactorBreakdown = {
    baseCollateralCapacity,
    steppedCapacity,
    advanceRate,
    portfolioRiskAdjustment: fRisk,
    liquidityAdjustment: fLiquidity,
    concentrationAdjustment: fConcentration,
    customerAdjustment: fCustomer,
    tierCap,
    jurisdictionCap,
    existingExposure: input.existingExposure,
  };

  if (collateral.degraded) {
    explanations.push('Some collateral pricing or verification is currently degraded, so this decision is deliberately conservative.');
  }

  return {
    customerId: input.customerId,
    currency,
    approved: !hardStop && creditLimit.isPositive(),
    creditLimit,
    previousLimit: input.previousLimit,
    breakdown,
    declineReasons,
    explanations,
    policyVersion: policy.version,
    decidedAt: now,
  };
};

// ---------------------------------------------------------------------------
// Facility arithmetic
// ---------------------------------------------------------------------------

/** Everything the customer currently owes: principal + interest + fees. */
export const totalDebt = (f: CreditFacility): Money =>
  f.principalBalance.plus(f.interestBalance).plus(f.feeBalance);

/** Debt plus outstanding authorization holds — what the limit is measured against. */
export const totalExposure = (f: CreditFacility): Money => totalDebt(f).plus(f.holdsTotal);

export const availableCredit = (f: CreditFacility): Money =>
  f.creditLimit.minus(totalExposure(f)).clampPositive();

export const utilization = (f: CreditFacility): Decimal | null =>
  f.creditLimit.isZero() ? null : totalExposure(f).amount.dividedBy(f.creditLimit.amount);

/**
 * Daily interest accrual on the revolving principal.
 * Uses an actual/365 day count on the settled principal only — interest does
 * not compound on itself within a statement cycle, and holds are not debt.
 */
export const accrueDailyInterest = (f: CreditFacility, days = 1): Money => {
  if (!f.principalBalance.isPositive() || f.aprBps <= 0) return Money.zero(f.currency);
  const dailyRate = D(f.aprBps).dividedBy(10_000).dividedBy(365);
  return f.principalBalance.times(dailyRate).times(days).round();
};

/** APR for a facility, widened for risk and narrowed for premium tiers. */
export const pricedAprBps = (policy: RiskPolicy, tier: import('./types.js').Tier, weightedVolatility: Decimal): number => {
  const base = policy.credit.baseAprBps;
  const tierDiscount = { WEALTH: 0, WEALTH_PLUS: 75, PRIVATE: 150, ULTRA: 250 }[tier];
  const volPremium = weightedVolatility.times(300).toDecimalPlaces(0).toNumber();
  return Math.max(0, base - tierDiscount + volPremium);
};

export const minimumPayment = (statementBalance: Money, policy: RiskPolicy): Money => {
  if (!statementBalance.isPositive()) return Money.zero(statementBalance.currency);
  const rated = statementBalance.times(D(policy.credit.minimumPaymentRate));
  const floor = Money.of(policy.credit.minimumPaymentFloor, statementBalance.currency);
  // Never demand more than the whole balance.
  return rated.max(floor).min(statementBalance).roundUp();
};
