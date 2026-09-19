/**
 * Liquidation service (PRD §12.3).
 *
 * Planning and execution are separate calls on purpose. The plan is a
 * deterministic artefact operations can read before anything irreversible
 * happens; execution requires either an automated trigger that has cleared
 * every gate, or a dual-approved operator action.
 */
import type pg from 'pg';
import {
  describePlan, evaluateTrigger, getPolicy, liquidationProceedsEntry, Money,
  planLiquidation, type CollateralSummary, type Jurisdiction, type LiquidationPlan,
  type LiquidationStrategy, type RiskSnapshot,
} from '@wealthcard/core';
import { lockFacility, money, query, queryOne, toNumeric, toNumericOrNull, type Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';
import { postEntry, syncFacilityFromLedger } from './ledger.js';
import { openMarginCall, raiseAlert } from './risk.js';
import { applyRepayment } from './payments.js';
import { refreshCustomer } from './orchestrator.js';

export interface PlanOutcome {
  readonly permitted: boolean;
  readonly reason: string;
  readonly plan: LiquidationPlan | null;
  readonly liquidationId: string | null;
  readonly narrative: string;
}

/**
 * Evaluate the trigger and, when it fires, record a plan.
 *
 * Writing the plan even when it will not execute automatically is deliberate:
 * it gives operations something concrete to approve, and it captures what the
 * engine believed at the moment of the breach.
 */
export const planIfTriggered = async (
  ctx: AppContext, tx: pg.PoolClient, snapshot: RiskSnapshot,
  collateral: CollateralSummary, jurisdiction: Jurisdiction,
  strategy: LiquidationStrategy = 'lowest_cost',
): Promise<PlanOutcome> => {
  const policy = getPolicy();
  const now = ctx.now();
  const call = await openMarginCall(tx, snapshot.customerId);
  const jp = policy.jurisdictions[jurisdiction];

  const trigger = evaluateTrigger(
    snapshot, policy,
    call ? { raisedAt: call.raisedAt, cured: false } : null,
    now,
    jp?.automatedLiquidationPermitted ?? false,
  );

  if (!trigger.shouldLiquidate) {
    return { permitted: false, reason: trigger.reason, plan: null, liquidationId: null, narrative: '' };
  }

  const plan = planLiquidation({
    snapshot, collateral, policy, triggeredBy: trigger.reason, strategy, now,
  });

  const row = await queryOne<{ id: string }>(
    tx,
    `INSERT INTO liquidations
       (customer_id, margin_call_id, triggered_by, strategy, status, target_ltv,
        debt_before, collateral_before, plan, projected_ltv_after, policy_version, planned_at)
     VALUES ($1,$2,$3,$4,'planned',$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      snapshot.customerId, call?.id ?? null, trigger.reason, strategy,
      plan.targetLtv.toFixed(), toNumeric(plan.debtBefore), toNumeric(plan.collateralBefore),
      JSON.stringify({
        lots: plan.lots.map((l) => ({
          assetId: l.assetId, symbol: l.symbol, quantity: l.quantity.toFixed(),
          estimatedPrice: l.estimatedPrice.toFixed(),
          grossProceeds: l.grossProceeds.toFixedString(),
          estimatedSlippage: l.estimatedSlippage.toFixedString(),
          estimatedFees: l.estimatedFees.toFixedString(),
          netProceeds: l.netProceeds.toFixedString(),
          reason: l.reason,
        })),
        totalNetProceeds: plan.totalNetProceeds.toFixedString(),
        projectedDebtAfter: plan.projectedDebtAfter.toFixedString(),
        projectedCollateralAfter: plan.projectedCollateralAfter.toFixedString(),
        sufficient: plan.sufficient,
      }),
      toNumericOrNull(plan.projectedLtvAfter), plan.policyVersion, now,
    ],
  );

  for (const lot of plan.lots) {
    await query(
      tx,
      `INSERT INTO liquidation_lots
         (liquidation_id, symbol, quantity, estimated_price, gross_proceeds, fees, net_proceeds)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row!.id, lot.symbol, lot.quantity.toFixed(), lot.estimatedPrice.toFixed(),
       toNumeric(lot.grossProceeds), toNumeric(lot.estimatedSlippage.plus(lot.estimatedFees)),
       toNumeric(lot.netProceeds)],
    );
  }

  const narrative = describePlan(plan);

  await raiseAlert(ctx, tx, snapshot.customerId, {
    kind: 'liquidation_warning',
    severity: 'critical',
    title: 'Collateral sale scheduled',
    body: narrative,
    actionLabel: 'Repay or add collateral',
    actionHref: '/collateral',
    dedupeKey: `liquidation_${row!.id}`,
  });

  await audit(tx, {
    actorType: 'system', actorId: 'risk_engine',
    action: 'liquidation.planned',
    entityType: 'liquidation', entityId: row!.id,
    after: {
      triggeredBy: trigger.reason,
      lots: plan.lots.length,
      totalNetProceeds: plan.totalNetProceeds.toFixedString(),
      sufficient: plan.sufficient,
    },
    policyVersion: plan.policyVersion,
  });

  return { permitted: true, reason: trigger.reason, plan, liquidationId: row!.id, narrative };
};

/**
 * Execute a recorded plan at the custodian.
 *
 * Each lot carries its own idempotency key derived from the liquidation id and
 * the symbol, because the one thing worse than failing to sell is selling
 * twice. Proceeds are applied as a repayment so they flow through exactly the
 * same ledger path a customer payment would.
 */
export const executeLiquidation = async (
  ctx: AppContext, pool: pg.Pool, liquidationId: string,
  actor: { type: 'system' | 'operator'; id: string },
): Promise<{ executed: number; netProceeds: string; status: string }> => {
  const now = ctx.now();

  // Claim the liquidation first, in its own short transaction, so a slow
  // custodian call cannot hold a facility lock open for minutes.
  const claim = await pool.connect();
  let customerId: string;
  let custodyAccountId: string;
  try {
    await claim.query('BEGIN');
    const row = await queryOne<{ id: string; customer_id: string; status: string }>(
      claim, 'SELECT id, customer_id, status FROM liquidations WHERE id = $1 FOR UPDATE', [liquidationId],
    );
    if (!row) throw notFound('Liquidation');
    if (row.status === 'executed') throw conflict('already_executed', 'This liquidation has already run');
    if (row.status === 'cancelled') throw conflict('cancelled', 'This liquidation was cancelled');

    const customer = await queryOne<{ custody_account_id: string | null }>(
      claim, 'SELECT custody_account_id FROM customers WHERE id = $1', [row.customer_id],
    );
    if (!customer?.custody_account_id) {
      throw badRequest('no_custody_account', 'Customer has no custody account to sell from');
    }

    await query(claim, `UPDATE liquidations SET status = 'executing' WHERE id = $1`, [liquidationId]);
    await claim.query('COMMIT');
    customerId = row.customer_id;
    custodyAccountId = customer.custody_account_id;
  } catch (err) {
    try { await claim.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    claim.release();
  }

  const lots = await query<{ id: string; symbol: string; quantity: string }>(
    pool, 'SELECT id, symbol, quantity::text FROM liquidation_lots WHERE liquidation_id = $1', [liquidationId],
  );

  let totalNet = Money.zero('USD');
  let totalCost = Money.zero('USD');
  let executed = 0;

  for (const lot of lots) {
    const fill = await ctx.partners.custody.liquidate(
      custodyAccountId, lot.symbol, money(lot.quantity).amount,
      `liq:${liquidationId}:${lot.symbol}`,
    );
    await query(
      pool,
      `UPDATE liquidation_lots
          SET executed_price = $2, net_proceeds = $3, fees = $4, fill_reference = $5, executed_at = $6
        WHERE id = $1`,
      [lot.id, fill.executedPrice.toFixed(), toNumeric(fill.netProceeds),
       toNumeric(fill.fees), fill.fillId, now],
    );
    totalNet = totalNet.plus(fill.netProceeds);
    totalCost = totalCost.plus(fill.grossProceeds.minus(fill.netProceeds));
    executed += 1;
  }

  // Recognise the sale, then apply the proceeds against the balance.
  const finish = await pool.connect();
  try {
    await finish.query('BEGIN');
    await lockFacility(finish, customerId);

    if (totalNet.isPositive()) {
      await postEntry(finish, liquidationProceedsEntry(
        { entryId: `${liquidationId}:proceeds`, occurredAt: now, idempotencyKey: `liqproceeds:${liquidationId}` },
        liquidationId, totalNet, totalCost,
      ));
    }

    await query(
      finish,
      `UPDATE liquidations SET status = 'executed', total_net_proceeds = $2, executed_at = $3 WHERE id = $1`,
      [liquidationId, toNumeric(totalNet), now],
    );
    await finish.query('COMMIT');
  } catch (err) {
    try { await finish.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    finish.release();
  }

  if (totalNet.isPositive()) {
    await applyRepayment(
      ctx, pool, customerId, totalNet.toString(), 'liquidation',
      `liq-repay:${liquidationId}`, liquidationId,
    );
  }

  const settle = await pool.connect();
  try {
    await settle.query('BEGIN');
    await syncFacilityFromLedger(settle, customerId);
    // The sale is the cure. Recording it closes the margin call rather than
    // leaving the customer under an obligation they have already discharged.
    await query(
      settle,
      `UPDATE margin_calls SET cured_at = now(), cure_method = 'liquidation'
        WHERE customer_id = $1 AND cured_at IS NULL`,
      [customerId],
    );
    await raiseAlert(ctx, settle, customerId, {
      kind: 'liquidation_executed',
      severity: 'critical',
      title: 'Collateral was sold to restore your account',
      body: `We sold collateral raising ${totalNet.toDisplayString()} USD, which has been applied to your balance. Your account details show the exact assets and prices.`,
      actionLabel: 'View details',
      actionHref: '/activity',
    });
    await audit(settle, {
      actorType: actor.type, actorId: actor.id,
      action: 'liquidation.executed',
      entityType: 'liquidation', entityId: liquidationId,
      after: { lots: executed, netProceeds: totalNet.toFixedString(), cost: totalCost.toFixedString() },
    });
    await settle.query('COMMIT');
  } catch (err) {
    try { await settle.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    settle.release();
  }

  // Revalue immediately. Without this the customer's risk state still reads
  // `liquidation` from the snapshot taken before the sale, which is both wrong
  // and alarming to someone whose account has just been restored.
  await refreshCustomer(ctx, pool, customerId, actor);

  return { executed, netProceeds: totalNet.toFixedString(), status: 'executed' };
};

export const cancelLiquidation = async (
  db: Db, liquidationId: string, operatorId: string, reason: string,
): Promise<void> => {
  const row = await queryOne<{ status: string }>(
    db, 'SELECT status FROM liquidations WHERE id = $1', [liquidationId],
  );
  if (!row) throw notFound('Liquidation');
  if (row.status !== 'planned') {
    throw conflict('not_cancellable', `A liquidation in state "${row.status}" cannot be cancelled`);
  }
  await query(db, `UPDATE liquidations SET status = 'cancelled' WHERE id = $1`, [liquidationId]);
  await audit(db, {
    actorType: 'operator', actorId: operatorId,
    action: 'liquidation.cancelled',
    entityType: 'liquidation', entityId: liquidationId,
    after: { reason },
  });
};
