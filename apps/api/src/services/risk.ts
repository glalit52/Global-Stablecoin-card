/**
 * Risk service: snapshots, state-change alerting, margin calls.
 *
 * This is the loop PRD §12.1 calls for — recompute on price movement, detect a
 * threshold crossing, tell the customer, and escalate on a clock. The domain
 * core decides *what* the state is; this module decides what to *do* about a
 * change in it.
 */
import type pg from 'pg';
import {
  collateralCallAmount, computeRisk, D, Decimal, drawdownTolerance, getPolicy,
  isAtLeast, Money, pct, repaymentToTarget, RISK_STATE_ORDER, runAllStressScenarios,
  type CollateralSummary, type CreditFacility, type RiskSnapshot, type RiskState,
} from '@wealthcard/core';
import { money, query, queryOne, toNumeric, toNumericOrNull, type Db } from '../db.js';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';

export interface OpenMarginCall {
  readonly id: string;
  readonly raisedAt: Date;
  readonly deadlineAt: Date;
  readonly requiredAmount: Money;
}

export const openMarginCall = async (db: Db, customerId: string): Promise<OpenMarginCall | null> => {
  const row = await queryOne<{
    id: string; raised_at: Date; deadline_at: Date; required_amount: string;
  }>(
    db,
    `SELECT id, raised_at, deadline_at, required_amount::text
       FROM margin_calls WHERE customer_id = $1 AND cured_at IS NULL
       ORDER BY raised_at DESC, id DESC LIMIT 1`,
    [customerId],
  );
  return row ? {
    id: row.id, raisedAt: row.raised_at, deadlineAt: row.deadline_at,
    requiredAmount: money(row.required_amount),
  } : null;
};

export const buildSnapshot = async (
  db: Db, facility: CreditFacility, collateral: CollateralSummary, now: Date,
): Promise<RiskSnapshot> => {
  const call = await openMarginCall(db, facility.customerId);
  return computeRisk({
    facility, collateral, policy: getPolicy(), now,
    ...(call ? { openMarginCall: true } : {}),
  });
};

export const persistSnapshot = async (
  db: Db, snapshot: RiskSnapshot, collateral: CollateralSummary,
): Promise<void> => {
  await query(
    db,
    `INSERT INTO risk_snapshots
       (customer_id, gross_ltv, effective_ltv, health_factor, health_percent, state,
        total_debt, eligible_collateral_value, total_market_value, top_concentration,
        withdrawable_collateral, safe_spend_capacity, triggered_rules, positions,
        degraded, policy_version, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      snapshot.customerId,
      toNumericOrNull(snapshot.grossLtv), toNumericOrNull(snapshot.effectiveLtv),
      toNumericOrNull(snapshot.healthFactor), snapshot.healthPercent.toFixed(2),
      snapshot.state, toNumeric(snapshot.totalDebt),
      toNumeric(snapshot.eligibleCollateralValue), toNumeric(snapshot.totalMarketValue),
      snapshot.topConcentration.toDecimalPlaces(8).toFixed(),
      toNumeric(snapshot.withdrawableCollateral), toNumeric(snapshot.safeSpendCapacity),
      snapshot.triggeredRules,
      JSON.stringify(collateral.positions.map((p) => ({
        symbol: p.symbol, assetClass: p.assetClass,
        quantity: p.quantity.toFixed(),
        marketValue: p.marketValue.toFixedString(),
        eligibleValue: p.eligibleValue.toFixedString(),
        haircut: p.haircut.toFixed(),
        liquidityAdjustment: p.liquidityAdjustment.toFixed(),
        concentrationAdjustment: p.concentrationAdjustment.toFixed(),
        concentration: p.concentration.toFixed(),
        eligible: p.eligible,
        ineligibilityReasons: p.ineligibilityReasons,
        priceAsOf: p.priceAsOf.toISOString(),
      }))),
      snapshot.degraded, snapshot.policyVersion, snapshot.computedAt,
    ],
  );
};

export const previousSnapshot = async (
  db: Db, customerId: string,
): Promise<RiskSnapshot | null> => {
  const row = await queryOne<{
    customer_id: string; gross_ltv: string | null; effective_ltv: string | null;
    health_factor: string | null; health_percent: string; state: RiskState;
    total_debt: string; eligible_collateral_value: string; total_market_value: string;
    top_concentration: string; withdrawable_collateral: string; safe_spend_capacity: string;
    triggered_rules: string[]; degraded: boolean; policy_version: string; computed_at: Date;
  }>(
    db,
    // The id tiebreaker matters: snapshots can share a timestamp, and without
    // it "the previous snapshot" is whichever row Postgres happens to return.
    `SELECT * FROM risk_snapshots WHERE customer_id = $1
      ORDER BY computed_at DESC, id DESC LIMIT 1`,
    [customerId],
  );
  if (!row) return null;
  return {
    customerId: row.customer_id,
    currency: 'USD',
    grossLtv: row.gross_ltv === null ? null : D(row.gross_ltv),
    effectiveLtv: row.effective_ltv === null ? null : D(row.effective_ltv),
    healthFactor: row.health_factor === null ? null : D(row.health_factor),
    healthPercent: D(row.health_percent),
    state: row.state,
    totalDebt: money(row.total_debt),
    eligibleCollateralValue: money(row.eligible_collateral_value),
    totalMarketValue: money(row.total_market_value),
    topConcentration: D(row.top_concentration),
    withdrawableCollateral: money(row.withdrawable_collateral),
    safeSpendCapacity: money(row.safe_spend_capacity),
    triggeredRules: row.triggered_rules,
    degraded: row.degraded,
    policyVersion: row.policy_version,
    computedAt: row.computed_at,
  };
};

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export interface AlertInput {
  readonly kind: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly body: string;
  readonly actionLabel?: string;
  readonly actionHref?: string;
  /** Suppresses a repeat while an identical alert is still open. */
  readonly dedupeKey?: string;
}

export const raiseAlert = async (
  ctx: AppContext, db: Db, customerId: string, alert: AlertInput,
): Promise<string | null> => {
  const row = await queryOne<{ id: string }>(
    db,
    `INSERT INTO alerts (customer_id, kind, severity, title, body, action_label, action_href, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [customerId, alert.kind, alert.severity, alert.title, alert.body,
     alert.actionLabel ?? null, alert.actionHref ?? null, alert.dedupeKey ?? null],
  );
  if (!row) return null; // deduplicated

  await ctx.partners.notifier.send({
    customerId,
    channel: alert.severity === 'critical' ? 'push' : 'in_app',
    title: alert.title,
    body: alert.body,
    critical: alert.severity === 'critical',
    ...(alert.actionHref ? { deepLink: alert.actionHref } : {}),
  }, `alert_${row.id}`);

  return row.id;
};

/** Clear open alerts of a kind once the condition behind them is gone. */
export const resolveAlerts = async (
  db: Db, customerId: string, kinds: readonly string[],
): Promise<void> => {
  await query(
    db,
    `UPDATE alerts SET status = 'resolved', acknowledged_at = now()
      WHERE customer_id = $1 AND status = 'open' AND kind = ANY($2)`,
    [customerId, kinds],
  );
};

const stateNarrative = (
  state: RiskState, snapshot: RiskSnapshot, requiredAmount: Money,
): { severity: 'info' | 'warning' | 'critical'; title: string; body: string } => {
  const ltv = snapshot.effectiveLtv ? pct(snapshot.effectiveLtv) : 'n/a';
  switch (state) {
    case 'watch':
      return {
        severity: 'info',
        title: 'Your account has moved to Watch',
        body: `Your loan-to-value is ${ltv} and your portfolio health is ${snapshot.healthPercent.toFixed(1)}%. Nothing is restricted — we are letting you know early so you have time to act if markets keep moving.`,
      };
    case 'restricted':
      return {
        severity: 'warning',
        title: 'New discretionary spending is paused',
        body: `Your loan-to-value has reached ${ltv}. Essential and recurring payments continue as normal. Adding collateral or repaying ${requiredAmount.toFixedString()} ${snapshot.currency} would restore full spending.`,
      };
    case 'remediation':
      return {
        severity: 'critical',
        title: 'Action required: add collateral or repay',
        body: `Your loan-to-value has reached ${ltv}. To avoid a forced sale of collateral, add ${requiredAmount.toFixedString()} ${snapshot.currency} of eligible collateral or repay an equivalent amount.`,
      };
    case 'liquidation':
      return {
        severity: 'critical',
        title: 'Collateral sale may begin',
        body: `Your loan-to-value has reached ${ltv}, the contractual liquidation threshold. We may sell collateral to restore your account. Repaying or adding collateral now still stops this.`,
      };
    case 'healthy':
    default:
      return {
        severity: 'info',
        title: 'Your account is healthy again',
        body: `Your loan-to-value is back to ${ltv} and full spending is restored.`,
      };
  }
};

export interface RiskEvaluation {
  readonly snapshot: RiskSnapshot;
  readonly previousState: RiskState | null;
  readonly stateChanged: boolean;
  readonly marginCallRaised: boolean;
  readonly alertIds: readonly string[];
}

/**
 * Compare a fresh snapshot against the last one and act on the difference.
 *
 * Alerts fire on a *change* of state, not on every tick — a customer sitting
 * at Watch for a week should hear from us once, not four thousand times. The
 * dedupe key on the alerts table enforces that even if this logic is wrong.
 */
export const evaluateAndAlert = async (
  ctx: AppContext, tx: pg.PoolClient, snapshot: RiskSnapshot, collateral: CollateralSummary,
): Promise<RiskEvaluation> => {
  const policy = getPolicy();
  const previous = await previousSnapshot(tx, snapshot.customerId);
  const previousState = previous?.state ?? null;
  const stateChanged = previousState !== null && previousState !== snapshot.state;

  await persistSnapshot(tx, snapshot, collateral);

  const alertIds: string[] = [];
  let marginCallRaised = false;

  const escalated = previousState === null
    ? snapshot.state !== 'healthy'
    : RISK_STATE_ORDER.indexOf(snapshot.state) > RISK_STATE_ORDER.indexOf(previousState);
  const recovered = previousState !== null
    && RISK_STATE_ORDER.indexOf(snapshot.state) < RISK_STATE_ORDER.indexOf(previousState);

  if (stateChanged || (previousState === null && snapshot.state !== 'healthy')) {
    const required = collateralCallAmount(snapshot, policy);
    const narrative = stateNarrative(snapshot.state, snapshot, required);

    if (escalated || (recovered && snapshot.state === 'healthy')) {
      const actionable = snapshot.state !== 'healthy';
      const id = await raiseAlert(ctx, tx, snapshot.customerId, {
        kind: 'risk_state_change',
        severity: narrative.severity,
        title: narrative.title,
        body: narrative.body,
        ...(actionable ? { actionLabel: 'Add collateral or repay', actionHref: '/collateral' } : {}),
        dedupeKey: `risk_state_${snapshot.state}`,
      });
      if (id) alertIds.push(id);
    }

    if (recovered) {
      // Stale warnings are worse than no warnings: clear anything the
      // customer has already acted on.
      await resolveAlerts(tx, snapshot.customerId, ['risk_state_change', 'margin_call', 'liquidation_warning']);
    }

    await audit(tx, {
      actorType: 'system', actorId: 'risk_engine',
      action: 'risk.state_changed',
      entityType: 'customer', entityId: snapshot.customerId,
      before: previousState ? { state: previousState } : null,
      after: {
        state: snapshot.state,
        effectiveLtv: snapshot.effectiveLtv?.toFixed() ?? null,
        triggeredRules: snapshot.triggeredRules,
      },
      policyVersion: snapshot.policyVersion,
    });
  }

  // A margin call is raised once per breach, and only while one is not open.
  if (isAtLeast(snapshot.state, 'remediation')) {
    const existing = await openMarginCall(tx, snapshot.customerId);
    if (!existing) {
      const required = collateralCallAmount(snapshot, policy);
      const deadline = new Date(
        snapshot.computedAt.getTime() + policy.thresholds.remediationWindowHours * 3_600_000,
      );
      await query(
        tx,
        `INSERT INTO margin_calls
           (customer_id, raised_at, deadline_at, ltv_at_raise, required_amount, policy_version)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [snapshot.customerId, snapshot.computedAt, deadline,
         toNumericOrNull(snapshot.effectiveLtv) ?? '0', toNumeric(required), snapshot.policyVersion],
      );
      marginCallRaised = true;

      const id = await raiseAlert(ctx, tx, snapshot.customerId, {
        kind: 'margin_call',
        severity: 'critical',
        title: 'Margin call',
        body: `Add ${required.toFixedString()} ${snapshot.currency} of eligible collateral, or repay ${repaymentToTarget(snapshot, policy).toFixedString()} ${snapshot.currency}, by ${deadline.toISOString()}. After that we may sell collateral to restore your account.`,
        actionLabel: 'Resolve now',
        actionHref: '/collateral',
        dedupeKey: 'margin_call_open',
      });
      if (id) alertIds.push(id);

      await audit(tx, {
        actorType: 'system', actorId: 'risk_engine',
        action: 'risk.margin_call_raised',
        entityType: 'customer', entityId: snapshot.customerId,
        after: { requiredAmount: required.toFixedString(), deadline: deadline.toISOString() },
        policyVersion: snapshot.policyVersion,
      });
    }
  } else {
    // Cure the call the moment the account is back inside the ladder.
    const existing = await openMarginCall(tx, snapshot.customerId);
    if (existing) {
      await query(
        tx, `UPDATE margin_calls SET cured_at = now(), cure_method = 'position_recovered' WHERE id = $1`,
        [existing.id],
      );
      await resolveAlerts(tx, snapshot.customerId, ['margin_call']);
    }
  }

  // Concentration and depeg notices ride alongside the state machine.
  if (snapshot.topConcentration.gt(D('0.85')) && snapshot.totalDebt.isPositive()) {
    const id = await raiseAlert(ctx, tx, snapshot.customerId, {
      kind: 'concentration',
      severity: 'info',
      title: 'Your collateral is highly concentrated',
      body: `${pct(snapshot.topConcentration)} of your eligible collateral sits in a single asset, which reduces how much we can lend against it. Adding a different eligible asset would raise your capacity without adding value.`,
      dedupeKey: 'concentration_high',
    });
    if (id) alertIds.push(id);
  }

  for (const position of collateral.positions) {
    if (position.ineligibilityReasons.includes('depeg_detected')) {
      const id = await raiseAlert(ctx, tx, snapshot.customerId, {
        kind: 'depeg', severity: 'critical',
        title: `${position.symbol} is trading away from its peg`,
        body: `${position.symbol} is no longer being counted as collateral while it trades materially away from $1.00. Your borrowing capacity has been reduced accordingly.`,
        dedupeKey: `depeg_${position.symbol}`,
      });
      if (id) alertIds.push(id);
    }
    if (position.ineligibilityReasons.includes('stale_price')) {
      const id = await raiseAlert(ctx, tx, snapshot.customerId, {
        kind: 'price_stale', severity: 'warning',
        title: `We have lost pricing for ${position.symbol}`,
        body: `${position.symbol} is temporarily not counted as collateral because we cannot verify a recent price. It will be restored automatically when pricing recovers.`,
        dedupeKey: `stale_${position.symbol}`,
      });
      if (id) alertIds.push(id);
    }
  }

  return { snapshot, previousState, stateChanged, marginCallRaised, alertIds };
};

export const stressReport = (snapshot: RiskSnapshot, collateral: CollateralSummary) => {
  const policy = getPolicy();
  return {
    scenarios: runAllStressScenarios(snapshot, collateral, policy).map((r) => ({
      id: r.scenario.id,
      label: r.scenario.label,
      eligibleCollateralValue: r.eligibleCollateralValue.toFixedString(),
      effectiveLtv: r.effectiveLtv?.toDecimalPlaces(4).toFixed() ?? null,
      healthFactor: r.healthFactor?.toDecimalPlaces(4).toFixed() ?? null,
      state: r.state,
      collateralShortfall: r.collateralShortfall.toFixedString(),
      survives: r.survives,
    })),
    drawdownTolerance: drawdownTolerance(snapshot, policy)?.toDecimalPlaces(4).toFixed() ?? null,
  };
};

export { Decimal };
