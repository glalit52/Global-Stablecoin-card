/**
 * Liquidation engine (PRD §12.3).
 *
 * Produces a *plan*, never an execution. Planning and execution are separated
 * on purpose: the plan is a deterministic, inspectable artefact that operations
 * can review, that the audit trail can store verbatim, and that a test can
 * assert on. Execution lives in the API layer behind an explicit,
 * dual-approved action.
 *
 * Sizing solves for the exact amount of collateral to sell rather than
 * liquidating everything, because over-liquidation is itself a harm to the
 * customer: they lose upside they did not need to lose.
 */
import { D, Decimal, Money, ONE, ZERO } from './money.js';
import { resolveAssetPolicy, type RiskPolicy } from './policy.js';
import { liquidationOrder } from './collateral.js';
import { isAtLeast } from './risk.js';
import type {
  CollateralPosition, CollateralSummary, LiquidationLot, LiquidationPlan, RiskSnapshot,
} from './types.js';

/** How the engine chooses what to sell first. PRD §12.3 "configurable asset priority rules". */
export type LiquidationStrategy =
  /** Cheapest execution first (stablecoins, then cash, then majors). Minimises
   *  realised cost but leaves the book more volatile than it found it. */
  | 'lowest_cost'
  /** Sell the most volatile collateral first. Costs more to execute but the
   *  surviving book is materially safer, so fewer repeat liquidations. */
  | 'de_risk'
  /** Take from every position in proportion to its eligible value. Preserves
   *  the customer's allocation; the default where a mandate requires it. */
  | 'pro_rata';

export interface LiquidationTrigger {
  readonly shouldLiquidate: boolean;
  readonly reason: string;
  /** When a margin call was raised, the moment the cure window closes. */
  readonly remediationDeadline: Date | null;
  readonly withinRemediationWindow: boolean;
}

export interface MarginCallState {
  readonly raisedAt: Date;
  readonly cured: boolean;
}

/**
 * Decide whether a forced sale is permitted right now.
 *
 * Two independent gates, both of which must open:
 *   1. the account is at or past the contractual liquidation LTV, and
 *   2. either the cure window from the margin call has expired, or the account
 *      has blown so far through the threshold that waiting is itself the risk.
 */
export const evaluateTrigger = (
  snapshot: RiskSnapshot,
  policy: RiskPolicy,
  marginCall: MarginCallState | null,
  now: Date,
  jurisdictionPermitsAutomation: boolean,
): LiquidationTrigger => {
  const t = policy.thresholds;

  if (!jurisdictionPermitsAutomation) {
    return {
      shouldLiquidate: false,
      reason: 'automated_liquidation_not_permitted_in_jurisdiction',
      remediationDeadline: null,
      withinRemediationWindow: false,
    };
  }

  if (!snapshot.totalDebt.isPositive()) {
    return { shouldLiquidate: false, reason: 'no_outstanding_debt', remediationDeadline: null, withinRemediationWindow: false };
  }

  if (!isAtLeast(snapshot.state, 'liquidation')) {
    // Below the liquidation line: a margin call may still be running, but no
    // forced sale is authorised.
    const deadline = marginCall && !marginCall.cured
      ? new Date(marginCall.raisedAt.getTime() + t.remediationWindowHours * 3_600_000)
      : null;
    return {
      shouldLiquidate: false,
      reason: isAtLeast(snapshot.state, 'remediation') ? 'margin_call_open_cure_window_running' : 'below_liquidation_threshold',
      remediationDeadline: deadline,
      withinRemediationWindow: deadline !== null && now < deadline,
    };
  }

  const deadline = marginCall && !marginCall.cured
    ? new Date(marginCall.raisedAt.getTime() + t.remediationWindowHours * 3_600_000)
    : null;
  const withinWindow = deadline !== null && now < deadline;

  // A gapping market can carry an account past the point where the cure window
  // is protective. Once the collateral no longer covers the debt at all,
  // waiting converts a customer loss into an unsecured credit loss.
  const breachedHardFloor = snapshot.effectiveLtv !== null && snapshot.effectiveLtv.gte(ONE);

  if (withinWindow && !breachedHardFloor) {
    return { shouldLiquidate: false, reason: 'cure_window_running', remediationDeadline: deadline, withinRemediationWindow: true };
  }

  return {
    shouldLiquidate: true,
    reason: breachedHardFloor ? 'ltv_at_or_above_100pct_hard_floor' : 'ltv_above_liquidation_threshold_and_cure_window_expired',
    remediationDeadline: deadline,
    withinRemediationWindow: false,
  };
};

const orderPositions = (
  collateral: CollateralSummary, policy: RiskPolicy, strategy: LiquidationStrategy,
): CollateralPosition[] => {
  const sellable = liquidationOrder(collateral.positions, policy);
  if (strategy === 'lowest_cost') return sellable;
  if (strategy === 'de_risk') {
    return [...sellable].sort((a, b) => {
      const pa = resolveAssetPolicy(policy, a.assetClass, a.symbol);
      const pb = resolveAssetPolicy(policy, b.assetClass, b.symbol);
      // Highest haircut is the best available proxy for "riskiest".
      const byRisk = b.haircut.comparedTo(a.haircut);
      if (byRisk !== 0) return byRisk;
      return pa.liquidationPriority - pb.liquidationPriority;
    });
  }
  return sellable; // pro_rata handled during sizing
};

export interface LiquidationInputs {
  readonly snapshot: RiskSnapshot;
  readonly collateral: CollateralSummary;
  readonly policy: RiskPolicy;
  readonly triggeredBy: string;
  readonly strategy?: LiquidationStrategy;
  /** Override the LTV the sale restores the account to. */
  readonly targetLtv?: Decimal;
  readonly now: Date;
}

/**
 * Build the plan.
 *
 * For one position, selling market value `m` yields net proceeds `m x r`
 * (r = 1 - slippage - fee) and removes `m x k` of eligible collateral
 * (k = eligibleValue / marketValue for that position). To land on the target:
 *
 *     (D - m x r) / (C - m x k) = target
 *  => m = (D - target x C) / (r - target x k)
 *
 * The denominator is positive for any sane policy (r close to 1, target < 1,
 * k <= 1), so the solution is well defined and we never divide by ~0.
 */
export const planLiquidation = (input: LiquidationInputs): LiquidationPlan => {
  const { snapshot, collateral, policy, now } = input;
  const currency = policy.facilityCurrency;
  const strategy = input.strategy ?? 'lowest_cost';
  const targetLtv = input.targetLtv ?? D(policy.thresholds.liquidationTargetLtv);

  const debtBefore = snapshot.totalDebt;
  const collateralBefore = snapshot.eligibleCollateralValue;

  const lots: LiquidationLot[] = [];
  let remainingDebt = debtBefore;
  let remainingCollateral = collateralBefore;
  let totalNetProceeds = Money.zero(currency);

  const ordered = orderPositions(collateral, policy, strategy);

  // Pro-rata sizes every lot up front against one global requirement instead
  // of walking positions until the need is met.
  const proRataShare = (() => {
    if (strategy !== 'pro_rata') return null;
    const totalEligible = ordered.reduce((a, p) => a.plus(p.eligibleValue), Money.zero(currency));
    if (!totalEligible.isPositive()) return null;
    // Blended r and k across the book, then solve once.
    let weightedR = ZERO, weightedK = ZERO;
    for (const p of ordered) {
      const ap = resolveAssetPolicy(policy, p.assetClass, p.symbol);
      const share = p.eligibleValue.amount.dividedBy(totalEligible.amount);
      weightedR = weightedR.plus(ONE.minus(D(ap.liquidationSlippage)).minus(D(ap.liquidationFee)).times(share));
      weightedK = weightedK.plus(
        (p.marketValue.isPositive() ? p.eligibleValue.amount.dividedBy(p.marketValue.amount) : ZERO).times(share),
      );
    }
    const denom = weightedR.minus(targetLtv.times(weightedK));
    if (denom.lte(0)) return null;
    const need = debtBefore.amount.minus(targetLtv.times(collateralBefore.amount));
    if (need.lte(0)) return null;
    const totalMarketToSell = need.dividedBy(denom);
    const totalMarket = ordered.reduce((a, p) => a.plus(p.marketValue), Money.zero(currency));
    return totalMarket.isPositive() ? totalMarketToSell.dividedBy(totalMarket.amount) : null;
  })();

  for (const position of ordered) {
    if (!position.marketValue.isPositive()) continue;

    const ap = resolveAssetPolicy(policy, position.assetClass, position.symbol);
    const slippageRate = D(ap.liquidationSlippage);
    const feeRate = D(ap.liquidationFee);
    const r = ONE.minus(slippageRate).minus(feeRate);
    const k = position.eligibleValue.amount.dividedBy(position.marketValue.amount);

    let marketValueToSell: Money;

    if (proRataShare !== null) {
      marketValueToSell = position.marketValue.times(proRataShare);
    } else {
      const need = remainingDebt.amount.minus(targetLtv.times(remainingCollateral.amount));
      if (need.lte(0)) break; // target already met

      const denom = r.minus(targetLtv.times(k));
      if (denom.lte(0)) continue; // selling this asset cannot improve the ratio

      marketValueToSell = Money.of(need.dividedBy(denom), currency);
    }

    marketValueToSell = marketValueToSell.min(position.marketValue).clampPositive();
    if (!marketValueToSell.isPositive()) continue;

    const unitPrice = position.quantity.isZero()
      ? ZERO
      : position.marketValue.amount.dividedBy(position.quantity);
    const quantity = unitPrice.isZero() ? ZERO : marketValueToSell.amount.dividedBy(unitPrice);

    const grossProceeds = marketValueToSell;
    const estimatedSlippage = grossProceeds.times(slippageRate).roundUp();
    const estimatedFees = grossProceeds.times(feeRate).roundUp();
    const netProceeds = grossProceeds.minus(estimatedSlippage).minus(estimatedFees).roundDown();

    lots.push({
      assetId: position.assetId,
      symbol: position.symbol,
      quantity: quantity.toDecimalPlaces(18, Decimal.ROUND_FLOOR),
      estimatedPrice: unitPrice,
      grossProceeds,
      estimatedSlippage,
      estimatedFees,
      netProceeds,
      reason: `${strategy}: priority ${ap.liquidationPriority}, haircut ${position.haircut.times(100).toDecimalPlaces(1)}%`,
    });

    totalNetProceeds = totalNetProceeds.plus(netProceeds);
    remainingDebt = remainingDebt.minus(netProceeds).clampPositive();
    remainingCollateral = remainingCollateral
      .minus(Money.of(marketValueToSell.amount.times(k), currency)).clampPositive();

    if (proRataShare === null && !remainingDebt.isPositive()) break;
  }

  const projectedLtvAfter = remainingCollateral.isPositive() && remainingDebt.isPositive()
    ? remainingDebt.amount.dividedBy(remainingCollateral.amount)
    : (remainingDebt.isPositive() ? null : ZERO);

  // A rounding-tolerant success test: landing a hair above the target because
  // of 2dp settlement rounding is not a failed plan.
  const tolerance = D('0.005');
  const sufficient = projectedLtvAfter === null
    ? !remainingDebt.isPositive()
    : projectedLtvAfter.lte(targetLtv.plus(tolerance));

  return {
    customerId: snapshot.customerId,
    currency,
    triggeredBy: input.triggeredBy,
    targetLtv,
    debtBefore,
    collateralBefore,
    lots,
    totalNetProceeds: totalNetProceeds.roundDown(),
    projectedDebtAfter: remainingDebt.roundUp(),
    projectedCollateralAfter: remainingCollateral.roundDown(),
    projectedLtvAfter,
    sufficient,
    policyVersion: policy.version,
    plannedAt: now,
  };
};

/** Customer-facing summary of a plan. Used in the warning notice and by the AI agent. */
export const describePlan = (plan: LiquidationPlan): string => {
  if (plan.lots.length === 0) {
    return 'No collateral sale is required at this time.';
  }
  const parts = plan.lots.map(
    (l) => `${l.quantity.toDecimalPlaces(8).toFixed()} ${l.symbol} (about ${l.netProceeds.toFixedString()} ${plan.currency} net)`,
  );
  const outcome = plan.sufficient
    ? `This would bring your loan-to-value back to about ${plan.targetLtv.times(100).toDecimalPlaces(0)}%.`
    : 'This would not fully restore the target loan-to-value; additional collateral or repayment is required.';
  return `To restore your account we would sell ${parts.join(', ')}, raising ${plan.totalNetProceeds.toFixedString()} ${plan.currency} against a balance of ${plan.debtBefore.toFixedString()} ${plan.currency}. ${outcome}`;
};
