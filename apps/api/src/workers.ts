/**
 * Background workers.
 *
 * Three loops, each doing one thing:
 *   - the market tick advances sandbox prices,
 *   - the risk tick revalues every live customer (PRD §12.1 "real-time
 *     monitoring"),
 *   - the daily tick accrues interest and expires stale authorization holds.
 *
 * Each loop is re-armed with setTimeout *after* the work finishes rather than
 * running on setInterval. An interval would stack overlapping runs the moment
 * one tick takes longer than its period, which under load is exactly when it
 * would hurt most.
 */
import type pg from 'pg';
import {
  accrueDailyInterest, getPolicy, interestAccrualEntry, membershipFeeEntry, Money,
  tierPolicy, type Tier,
} from '@wealthcard/core';
import { lockFacility, money, query, transaction } from './db.js';
import type { AppContext } from './context.js';
import { refreshCustomer } from './services/orchestrator.js';
import { loadFacility } from './services/credit.js';
import { postEntry, syncFacilityFromLedger, syncHolds } from './services/ledger.js';

export interface Workers {
  stop: () => void;
  runRiskTickNow: () => Promise<number>;
  runDailyAccrualNow: () => Promise<number>;
}

interface LiveCustomer { id: string; tier: Tier; openedAt: Date }

const liveCustomers = async (pool: pg.Pool): Promise<LiveCustomer[]> => {
  const rows = await query<{ id: string; tier: Tier; opened_at: Date }>(
    pool,
    `SELECT c.id, c.tier, f.opened_at FROM customers c
       JOIN credit_facilities f ON f.customer_id = c.id
      WHERE c.status IN ('active','restricted') AND f.status <> 'closed'`,
  );
  return rows.map((r) => ({ id: r.id, tier: r.tier, openedAt: r.opened_at }));
};

export const startWorkers = (ctx: AppContext, log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): Workers => {
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];

  const loop = (name: string, intervalMs: number, fn: () => Promise<void>): void => {
    const run = async () => {
      if (stopped) return;
      try {
        await fn();
      } catch (err) {
        log.error({ err, worker: name }, 'worker tick failed');
      } finally {
        if (!stopped) timers.push(setTimeout(run, intervalMs));
      }
    };
    timers.push(setTimeout(run, intervalMs));
  };

  const runRiskTick = async (): Promise<number> => {
    const customers = await liveCustomers(ctx.pool);
    let changed = 0;
    for (const c of customers) {
      try {
        const result = await refreshCustomer(ctx, ctx.pool, c.id);
        if (result.evaluation.stateChanged || result.limitChanged) changed += 1;
      } catch (err) {
        log.error({ err, customerId: c.id }, 'risk tick failed for customer');
      }
    }
    return changed;
  };

  /**
   * Daily accrual: interest on revolving principal, the annual membership fee
   * on its anniversary, and release of holds that never settled. A hold left
   * open forever would permanently consume credit the customer is entitled to.
   */
  const runDailyAccrual = async (): Promise<number> => {
    const policy = getPolicy();
    const now = ctx.now();
    const day = now.toISOString().slice(0, 10);
    const customers = await liveCustomers(ctx.pool);
    let accrued = 0;

    for (const { id: customerId, tier, openedAt } of customers) {
      try {
        await transaction(ctx.pool, async (tx) => {
          await lockFacility(tx, customerId);
          const facility = await loadFacility(tx, customerId);

          const interest = accrueDailyInterest(facility);
          if (interest.isPositive()) {
            await postEntry(tx, interestAccrualEntry(
              { entryId: `${facility.facilityId}:int:${day}`, occurredAt: now,
                idempotencyKey: `interest:${customerId}:${day}` },
              customerId, facility.facilityId, interest,
            ));
            accrued += 1;
          }

          // Membership fee on the account anniversary. The idempotency key
          // carries the year, so the posting happens exactly once even if the
          // worker runs many times that day.
          const fee = Money.of(tierPolicy(policy, tier).annualFee, facility.currency);
          const isAnniversary = now.getUTCMonth() === openedAt.getUTCMonth()
            && now.getUTCDate() === openedAt.getUTCDate();
          if (fee.isPositive() && isAnniversary) {
            await postEntry(tx, membershipFeeEntry(
              { entryId: `${facility.facilityId}:fee:${now.getUTCFullYear()}`, occurredAt: now,
                idempotencyKey: `membership:${customerId}:${now.getUTCFullYear()}` },
              customerId, facility.facilityId, fee,
              `${tier} annual membership fee`,
            ));
          }

          await syncFacilityFromLedger(tx, customerId, facility.currency);
        });
      } catch (err) {
        log.error({ err, customerId }, 'daily accrual failed');
      }
    }

    // Expire holds past their TTL and give the credit back.
    const expired = await query<{ customer_id: string }>(
      ctx.pool,
      `UPDATE authorizations SET hold_released = TRUE
        WHERE approved AND NOT hold_released AND expires_at IS NOT NULL AND expires_at < $1
        RETURNING customer_id`,
      [now],
    );
    for (const customerId of new Set(expired.map((e) => e.customer_id))) {
      await transaction(ctx.pool, async (tx) => {
        await lockFacility(tx, customerId);
        await syncHolds(tx, customerId);
      });
    }

    return accrued;
  };

  loop('market', ctx.config.marketTickSeconds * 1000, async () => {
    ctx.market.tick(1 / 24);
  });

  loop('risk', ctx.config.riskTickSeconds * 1000, async () => {
    const changed = await runRiskTick();
    if (changed > 0) log.info({ changed }, 'risk tick produced state or limit changes');
  });

  // Hourly, but each accrual is keyed by calendar day so it posts exactly once.
  loop('daily', 3_600_000, async () => {
    await runDailyAccrual();
  });

  return {
    stop: () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
    runRiskTickNow: runRiskTick,
    runDailyAccrualNow: runDailyAccrual,
  };
};

export { Money, money };
