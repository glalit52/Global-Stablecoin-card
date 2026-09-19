/**
 * Risk engine (PRD §12).
 *
 * Owns the LTV ladder, the health factor, the five limit states of PRD §11.3,
 * and the stress-testing harness. Like the collateral and credit engines it is
 * a pure function: the caller supplies the clock and the data, so every
 * snapshot is reproducible from its inputs during an audit.
 */
import { clamp, D, Decimal, Money, ONE, ZERO } from './money.js';
import { type RiskPolicy } from './policy.js';
import { shockedEligibleValue } from './collateral.js';
import { totalDebt } from './credit.js';
import type {
  CollateralSummary, CreditFacility, RiskSnapshot, RiskState,
  StressResult, StressScenario,
} from './types.js';
import { RISK_STATE_ORDER } from './types.js';

export const worseOf = (a: RiskState, b: RiskState): RiskState =>
  RISK_STATE_ORDER.indexOf(a) >= RISK_STATE_ORDER.indexOf(b) ? a : b;

export const isAtLeast = (state: RiskState, threshold: RiskState): boolean =>
  RISK_STATE_ORDER.indexOf(state) >= RISK_STATE_ORDER.indexOf(threshold);

/** Map an effective LTV onto the PRD §11.3 ladder. */
export const stateForLtv = (ltv: Decimal | null, policy: RiskPolicy): RiskState => {
  if (ltv === null) return 'healthy';
  const t = policy.thresholds;
  if (ltv.gte(D(t.liquidationLtv))) return 'liquidation';
  if (ltv.gte(D(t.remediationLtv))) return 'remediation';
  if (ltv.gte(D(t.restrictedLtv))) return 'restricted';
  if (ltv.gte(D(t.watchLtv))) return 'watch';
  return 'healthy';
};

export interface RiskInputs {
  readonly facility: CreditFacility;
  readonly collateral: CollateralSummary;
  readonly policy: RiskPolicy;
  readonly now: Date;
  /** Set when a margin call is already running; keeps the state from
   *  silently relaxing below `remediation` inside the cure window. */
  readonly openMarginCall?: boolean;
}

export const computeRisk = (input: RiskInputs): RiskSnapshot => {
  const { facility, collateral, policy, now } = input;
  const currency = policy.facilityCurrency;
  const t = policy.thresholds;

  const debt = totalDebt(facility);
  // Holds are not debt, but they are committed spend, so risk is measured on
  // the full exposure. Ignoring holds would let a customer authorize their way
  // past the liquidation threshold before anything settled.
  const exposure = debt.plus(facility.holdsTotal);
  const collateralValue = collateral.eligibleCollateralValue;

  const effectiveLtv = collateralValue.isPositive() && exposure.isPositive()
    ? exposure.amount.dividedBy(collateralValue.amount) : (exposure.isPositive() ? null : ZERO);
  const grossLtv = collateral.totalMarketValue.isPositive() && exposure.isPositive()
    ? exposure.amount.dividedBy(collateral.totalMarketValue.amount) : (exposure.isPositive() ? null : ZERO);

  const liquidationThreshold = D(t.liquidationThreshold);
  const healthFactor = exposure.isPositive()
    ? collateralValue.amount.times(liquidationThreshold).dividedBy(exposure.amount)
    : null;

  const triggeredRules: string[] = [];

  // Debt with no collateral behind it is the worst state there is; it cannot
  // be expressed as an LTV, so it is handled explicitly rather than falling
  // through `stateForLtv`'s null branch.
  let state: RiskState;
  if (exposure.isPositive() && !collateralValue.isPositive()) {
    state = 'liquidation';
    triggeredRules.push('no_eligible_collateral_against_outstanding_exposure');
  } else {
    state = stateForLtv(effectiveLtv, policy);
    if (effectiveLtv && state !== 'healthy') triggeredRules.push(`ltv_${state}`);
  }

  // Non-LTV escalations. These can only make the state worse.
  if (collateral.degraded) {
    triggeredRules.push('degraded_pricing_or_verification');
    if (exposure.isPositive()) state = worseOf(state, 'watch');
  }
  if (collateral.topConcentration.gt(D('0.9')) && exposure.isPositive()) {
    triggeredRules.push('single_asset_concentration_above_90pct');
    state = worseOf(state, 'watch');
  }
  if (facility.status === 'restricted') {
    triggeredRules.push('facility_restricted_by_operations');
    state = worseOf(state, 'restricted');
  }
  if (facility.status === 'frozen' || facility.status === 'defaulted') {
    triggeredRules.push(`facility_${facility.status}`);
    state = worseOf(state, 'remediation');
  }
  if (input.openMarginCall) {
    triggeredRules.push('open_margin_call');
    state = worseOf(state, 'remediation');
  }

  // Display health: headroom between the collateral we hold and the collateral
  // the liquidation threshold demands.
  let healthPercent = D(100);
  if (exposure.isPositive()) {
    if (!collateralValue.isPositive()) healthPercent = ZERO;
    else {
      const requiredCollateral = exposure.amount.dividedBy(D(t.liquidationLtv));
      healthPercent = clamp(ONE.minus(requiredCollateral.dividedBy(collateralValue.amount)), 0, 1).times(100);
    }
  }

  // Collateral releasable while staying inside the origination LTV.
  let withdrawableCollateral = collateralValue;
  if (exposure.isPositive()) {
    const requiredForHealthy = exposure.amount.dividedBy(D(t.maxOriginationLtv));
    withdrawableCollateral = Money.of(
      collateralValue.amount.minus(requiredForHealthy), currency,
    ).clampPositive();
  }

  // Additional spend available before the account would enter `watch`,
  // bounded by the contractual credit limit.
  const watchCeiling = Money.of(collateralValue.amount.times(D(t.watchLtv)), currency);
  const riskHeadroom = watchCeiling.minus(exposure).clampPositive();
  const limitHeadroom = facility.creditLimit.minus(exposure).clampPositive();
  const safeSpendCapacity = riskHeadroom.min(limitHeadroom).roundDown();

  return {
    customerId: facility.customerId,
    currency,
    grossLtv,
    effectiveLtv,
    healthFactor,
    healthPercent: healthPercent.toDecimalPlaces(1),
    state,
    totalDebt: debt,
    eligibleCollateralValue: collateralValue,
    totalMarketValue: collateral.totalMarketValue,
    topConcentration: collateral.topConcentration,
    withdrawableCollateral: withdrawableCollateral.roundDown(),
    safeSpendCapacity,
    triggeredRules,
    degraded: collateral.degraded,
    policyVersion: policy.version,
    computedAt: now,
  };
};

/**
 * What the account would look like after a given amount of new spend.
 * Drives the "how much can I safely spend?" answer and the pre-authorization
 * impact preview, without mutating anything.
 */
export const projectAfterSpend = (
  snapshot: RiskSnapshot, amount: Money, policy: RiskPolicy,
): { ltv: Decimal | null; state: RiskState; healthPercent: Decimal } => {
  const exposure = snapshot.totalDebt.plus(amount);
  if (!snapshot.eligibleCollateralValue.isPositive()) {
    return { ltv: null, state: exposure.isPositive() ? 'liquidation' : 'healthy', healthPercent: ZERO };
  }
  const ltv = exposure.amount.dividedBy(snapshot.eligibleCollateralValue.amount);
  const required = exposure.amount.dividedBy(D(policy.thresholds.liquidationLtv));
  const healthPercent = clamp(
    ONE.minus(required.dividedBy(snapshot.eligibleCollateralValue.amount)), 0, 1,
  ).times(100).toDecimalPlaces(1);
  return { ltv, state: stateForLtv(ltv, policy), healthPercent };
};

/** Collateral that must be added to bring the account back to the target LTV. */
export const collateralCallAmount = (
  snapshot: RiskSnapshot, policy: RiskPolicy, targetLtv?: Decimal,
): Money => {
  const target = targetLtv ?? D(policy.thresholds.liquidationTargetLtv);
  if (!snapshot.totalDebt.isPositive() || target.lte(0)) return Money.zero(snapshot.currency);
  const required = snapshot.totalDebt.amount.dividedBy(target);
  return Money.of(required.minus(snapshot.eligibleCollateralValue.amount), snapshot.currency)
    .clampPositive().roundUp();
};

/** Repayment that would bring the account back to the target LTV. */
export const repaymentToTarget = (
  snapshot: RiskSnapshot, policy: RiskPolicy, targetLtv?: Decimal,
): Money => {
  const target = targetLtv ?? D(policy.thresholds.liquidationTargetLtv);
  if (!snapshot.totalDebt.isPositive()) return Money.zero(snapshot.currency);
  const maxDebt = snapshot.eligibleCollateralValue.amount.times(target);
  return Money.of(snapshot.totalDebt.amount.minus(maxDebt), snapshot.currency)
    .clampPositive().roundUp().min(snapshot.totalDebt);
};

// ---------------------------------------------------------------------------
// Stress testing (PRD §12.2)
// ---------------------------------------------------------------------------

export const runStressScenario = (
  snapshot: RiskSnapshot, collateral: CollateralSummary,
  scenario: StressScenario, policy: RiskPolicy,
): StressResult => {
  const currency = policy.facilityCurrency;
  const stressedCollateral = collateral.positions.reduce(
    (acc, p) => acc.plus(shockedEligibleValue(p, scenario, policy)), Money.zero(currency),
  );

  const debt = snapshot.totalDebt;
  const effectiveLtv = stressedCollateral.isPositive() && debt.isPositive()
    ? debt.amount.dividedBy(stressedCollateral.amount)
    : (debt.isPositive() ? null : ZERO);

  const healthFactor = debt.isPositive() && stressedCollateral.isPositive()
    ? stressedCollateral.amount.times(D(policy.thresholds.liquidationThreshold)).dividedBy(debt.amount)
    : null;

  const state: RiskState = debt.isPositive() && !stressedCollateral.isPositive()
    ? 'liquidation'
    : stateForLtv(effectiveLtv, policy);

  // Collateral we would need to add to get back below the remediation line.
  const remediationCeiling = D(policy.thresholds.remediationLtv);
  const requiredCollateral = debt.isPositive()
    ? debt.amount.dividedBy(remediationCeiling) : ZERO;
  const collateralShortfall = Money.of(
    requiredCollateral.minus(stressedCollateral.amount), currency,
  ).clampPositive().roundUp();

  return {
    scenario,
    eligibleCollateralValue: stressedCollateral.roundDown(),
    effectiveLtv,
    healthFactor,
    state,
    collateralShortfall,
    // "Survives" means the scenario does not force a margin call, not merely
    // that it avoids liquidation.
    survives: !isAtLeast(state, 'remediation'),
  };
};

export const runAllStressScenarios = (
  snapshot: RiskSnapshot, collateral: CollateralSummary, policy: RiskPolicy,
): StressResult[] =>
  policy.stressScenarios.map((s) => runStressScenario(snapshot, collateral, s, policy));

/**
 * The largest uniform drawdown across all collateral the account could absorb
 * before hitting the liquidation threshold. A single, honest number for the UI:
 * "BTC can fall 47% before we would have to act."
 */
export const drawdownTolerance = (snapshot: RiskSnapshot, policy: RiskPolicy): Decimal | null => {
  if (!snapshot.totalDebt.isPositive()) return null;
  if (!snapshot.eligibleCollateralValue.isPositive()) return ZERO;
  const liquidationCollateral = snapshot.totalDebt.amount.dividedBy(D(policy.thresholds.liquidationLtv));
  const tolerance = ONE.minus(liquidationCollateral.dividedBy(snapshot.eligibleCollateralValue.amount));
  return clamp(tolerance, 0, 1);
};
