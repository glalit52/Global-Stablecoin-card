/** Rewards service: ledger reads, redemption and tier benefits. */
import type pg from 'pg';
import {
  benefitsForTier, checkRedemption, D, Decimal, getPolicy, jurisdictionPolicy,
  loungeVisitCovered, Money, pointsBalance, redemptionValue, rewardsRedemptionEntry,
  tierProgress, type Jurisdiction, type RedemptionKind, type RewardEntry, type Tier,
} from '@wealthcard/core';
import { lockFacility, money, query, queryOne, toNumeric, type Db } from '../db.js';
import { badRequest } from '../errors.js';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';
import { postEntry, syncFacilityFromLedger } from './ledger.js';

export const loadRewardEntries = async (
  db: Db, customerId: string, limit = 500,
): Promise<RewardEntry[]> => {
  const rows = await query<{
    id: string; type: RewardEntry['type']; points: string; transaction_id: string | null;
    category: string | null; rate_applied: string | null; description: string; occurred_at: Date;
  }>(
    db,
    `SELECT * FROM reward_entries WHERE customer_id = $1 ORDER BY occurred_at DESC LIMIT $2`,
    [customerId, limit],
  );
  return rows.map((r) => ({
    entryId: r.id,
    customerId,
    type: r.type,
    points: D(r.points),
    transactionId: r.transaction_id,
    category: r.category as RewardEntry['category'],
    rateApplied: r.rate_applied === null ? null : D(r.rate_applied),
    description: r.description,
    occurredAt: r.occurred_at,
  }));
};

export const rewardsSummary = async (
  db: Db, customerId: string, tier: Tier, eligibleCollateral: Money,
) => {
  const policy = getPolicy();
  const entries = await loadRewardEntries(db, customerId);
  const balance = pointsBalance(entries);

  const spend = await queryOne<{ total: string; rewards_cost: string }>(
    db,
    `SELECT COALESCE(SUM(t.billing_amount),0)::text AS total,
            COALESCE((SELECT SUM(accrual_cost) FROM reward_entries
                       WHERE customer_id = $1 AND occurred_at > now() - interval '365 days'),0)::text AS rewards_cost
       FROM transactions t
      WHERE t.customer_id = $1 AND t.settled_at > now() - interval '365 days'`,
    [customerId],
  );

  const trailingSpend = money(spend?.total ?? '0');
  const rewardsCost = money(spend?.rewards_cost ?? '0');

  const visits = await queryOne<{ count: string }>(
    db,
    `SELECT COUNT(*)::text AS count FROM lounge_visits
      WHERE customer_id = $1 AND visited_at >= date_trunc('year', now())`,
    [customerId],
  );
  const lounge = loungeVisitCovered(policy, tier, Number(visits?.count ?? '0'));
  const benefits = benefitsForTier(policy, tier);
  const progress = tierProgress(tier, eligibleCollateral, trailingSpend);

  return {
    points: {
      posted: balance.posted.toFixed(0),
      pending: balance.pending.toFixed(0),
      lifetimeEarned: balance.lifetimeEarned.toFixed(0),
      redeemed: balance.redeemed.toFixed(0),
      statementCreditValue: redemptionValue(balance.posted, 'statement_credit', 'USD').toFixedString(),
      travelValue: redemptionValue(balance.posted, 'travel', 'USD').toFixedString(),
    },
    tier: {
      current: tier,
      annualFee: benefits.annualFee.toFixedString(),
      baseEarnRate: benefits.baseEarnRate,
      categoryMultipliers: benefits.categoryMultipliers,
      bonusCategoryMonthlyCap: benefits.bonusCategoryMonthlyCap,
      fxMarkupBps: benefits.fxMarkupBps,
      conciergeIncluded: benefits.conciergeIncluded,
      loungeUnlimited: benefits.loungeUnlimited,
      loungeVisitsRemaining: lounge.remaining,
      nextTier: progress.nextTier,
      progressToNextTier: progress.progress.toDecimalPlaces(4).toFixed(),
      collateralToNextTier: progress.collateralRequired.toFixedString(),
      spendToNextTier: progress.spendRequired.toFixedString(),
    },
    economics: {
      trailingAnnualSpend: trailingSpend.toFixedString(),
      rewardsCost: rewardsCost.toFixedString(),
      rewardsCostPercentOfSpend: trailingSpend.isPositive()
        ? rewardsCost.amount.dividedBy(trailingSpend.amount).times(100).toDecimalPlaces(2).toFixed()
        : '0.00',
    },
    recent: entries.slice(0, 25).map((e) => ({
      id: e.entryId, type: e.type, points: e.points.toFixed(0),
      category: e.category, description: e.description,
      occurredAt: e.occurredAt.toISOString(),
    })),
  };
};

/**
 * Redeem points.
 *
 * Statement credit posts to the ledger so the rewards liability is genuinely
 * released against the customer's balance. Other routes record the redemption
 * and hand off to the fulfilment partner.
 */
export const redeem = async (
  ctx: AppContext, pool: pg.Pool, customerId: string, tier: Tier,
  kind: RedemptionKind, points: string, jurisdiction: string,
): Promise<{ redemptionId: string; points: string; value: string }> => {
  const now = ctx.now();
  const policy = getPolicy();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockFacility(client, customerId);

    const balance = pointsBalance(await loadRewardEntries(client, customerId));
    const requested = D(points);
    // Redeeming points into a digital asset is only offered where the
    // programme is actually live, since it is a regulated act in its own right.
    const cryptoAllowed = jurisdictionPolicy(policy, jurisdiction as Jurisdiction)?.enabled === true;

    const check = checkRedemption(balance.posted, requested, kind, 'USD', cryptoAllowed);
    if (!check.allowed) throw badRequest(check.reason ?? 'redemption_not_allowed', 'This redemption is not available');

    const row = await queryOne<{ id: string }>(
      client,
      `INSERT INTO redemptions (customer_id, kind, points, value_amount, currency)
       VALUES ($1,$2,$3,$4,'USD') RETURNING id`,
      [customerId, kind, requested.toFixed(), toNumeric(check.value)],
    );

    await query(
      client,
      `INSERT INTO reward_entries (customer_id, type, points, description, occurred_at)
       VALUES ($1,'redemption',$2,$3,$4)`,
      [customerId, requested.toFixed(), `Redeemed ${requested.toFixed(0)} points for ${kind.replace('_', ' ')}`, now],
    );

    if (kind === 'statement_credit') {
      await postEntry(client, rewardsRedemptionEntry(
        { entryId: row!.id, occurredAt: now, idempotencyKey: `redeem:${row!.id}` },
        customerId, row!.id, check.value,
      ));
      await syncFacilityFromLedger(client, customerId);
    }

    await audit(client, {
      actorType: 'customer', actorId: customerId,
      action: 'rewards.redeemed', entityType: 'redemption', entityId: row!.id,
      after: { kind, points: requested.toFixed(), value: check.value.toFixedString() },
    });

    await client.query('COMMIT');
    return { redemptionId: row!.id, points: requested.toFixed(0), value: check.value.toFixedString() };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
};

export { Decimal };
