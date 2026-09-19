/**
 * Orchestration: the one path that revalues a customer end to end.
 *
 *   custody balances -> prices -> collateral -> credit decision
 *                                            -> risk snapshot -> alerts
 *                                                             -> liquidation plan
 *
 * Every entry point that could change a customer's position calls this, so
 * there is exactly one ordering of those steps in the system. Two callers with
 * slightly different orderings is how a platform ends up with a credit limit
 * computed from one set of prices and a risk state computed from another.
 */
import type pg from 'pg';
import { getPolicy, type Jurisdiction } from '@wealthcard/core';
import { transaction } from '../db.js';
import type { AppContext } from '../context.js';
import { loadCustomer, repriceCredit, type CustomerRow } from './credit.js';
import { computeWealth, type WealthView } from './wealth.js';
import { evaluateAndAlert, type RiskEvaluation } from './risk.js';
import { planIfTriggered, type PlanOutcome } from './liquidation.js';
import { buildSnapshot } from './risk.js';
import { syncHolds } from './ledger.js';

export interface RefreshResult {
  readonly customer: CustomerRow;
  readonly wealth: WealthView;
  readonly evaluation: RiskEvaluation;
  readonly limitChanged: boolean;
  readonly liquidation: PlanOutcome | null;
}

export const refreshCustomer = async (
  ctx: AppContext, pool: pg.Pool, customerId: string,
  actor: { type: 'customer' | 'operator' | 'system'; id: string } = { type: 'system', id: 'scheduler' },
): Promise<RefreshResult> => {
  const now = ctx.now();
  const customer = await loadCustomer(pool, customerId);

  // Pricing and collateral run outside the transaction: they are the slow part
  // (three feeds over the network) and they take no locks.
  const wealth = await computeWealth(ctx, pool, customerId, customer.jurisdiction as Jurisdiction);

  return transaction(pool, async (tx) => {
    await tx.query('SELECT id FROM credit_facilities WHERE customer_id = $1 FOR UPDATE', [customerId]);

    const { facility, limitChanged } = await repriceCredit(tx, customer, wealth.collateral, now, actor);
    await syncHolds(tx, customerId, facility.currency);

    const snapshot = await buildSnapshot(tx, { ...facility }, wealth.collateral, now);
    const evaluation = await evaluateAndAlert(ctx, tx, snapshot, wealth.collateral);

    // Only plan a sale once the account is actually at the liquidation line;
    // planIfTriggered re-checks the cure window and jurisdiction rules itself.
    const liquidation = snapshot.state === 'liquidation'
      ? await planIfTriggered(
          ctx, tx, snapshot, wealth.collateral, customer.jurisdiction as Jurisdiction,
        )
      : null;

    return { customer, wealth, evaluation, limitChanged, liquidation };
  });
};

export { getPolicy };
