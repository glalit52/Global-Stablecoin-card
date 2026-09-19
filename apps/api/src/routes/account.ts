/**
 * The customer-facing account surface: PRD §21's GET /wealth, /collateral,
 * /credit, /risk, /alerts plus the collateral pledge/release actions.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  collateralCallAmount, D, describeIneligibility, getPolicy, maxSafeSpend, Money,
  previewSpend, repaymentToTarget, availableCredit, utilization, totalDebt,
  type Jurisdiction,
} from '@wealthcard/core';
import { requireCustomer, requireStepUp } from '../auth.js';
import { money, query, queryOne, transaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../audit.js';
import { amountString, clientIp, parse } from './helpers.js';
import type { AppContext } from '../context.js';
import { loadCustomer, findFacility, latestDecision } from '../services/credit.js';
import { computeWealth } from '../services/wealth.js';
import { previousSnapshot, stressReport, buildSnapshot } from '../services/risk.js';
import { refreshCustomer } from '../services/orchestrator.js';

export const registerAccountRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  /** GET /wealth — verified assets, total wealth and allocation (PRD §21). */
  app.get('/v1/wealth', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const customer = await loadCustomer(ctx.pool, principal.customerId);
    const wealth = await computeWealth(
      ctx, ctx.pool, principal.customerId, customer.jurisdiction as Jurisdiction,
    );

    const byClass = new Map<string, { marketValue: Money; eligibleValue: Money }>();
    for (const p of wealth.collateral.positions) {
      const cur = byClass.get(p.assetClass) ?? { marketValue: Money.zero('USD'), eligibleValue: Money.zero('USD') };
      byClass.set(p.assetClass, {
        marketValue: cur.marketValue.plus(p.marketValue),
        eligibleValue: cur.eligibleValue.plus(p.eligibleValue),
      });
    }

    return reply.send({
      totalWealth: wealth.collateral.totalMarketValue.toFixedString(),
      eligibleCollateral: wealth.collateral.eligibleCollateralValue.toFixedString(),
      currency: wealth.collateral.currency,
      computedAt: wealth.collateral.computedAt.toISOString(),
      degraded: wealth.collateral.degraded,
      unpricedSymbols: wealth.unpricedSymbols,
      allocation: [...byClass].map(([assetClass, v]) => ({
        assetClass,
        marketValue: v.marketValue.toFixedString(),
        eligibleValue: v.eligibleValue.toFixedString(),
        share: wealth.collateral.totalMarketValue.isPositive()
          ? v.marketValue.amount.dividedBy(wealth.collateral.totalMarketValue.amount)
              .times(100).toDecimalPlaces(2).toFixed()
          : '0.00',
      })),
      positions: wealth.collateral.positions.map((p) => ({
        assetId: p.assetId,
        symbol: p.symbol,
        assetClass: p.assetClass,
        quantity: p.quantity.toFixed(),
        marketValue: p.marketValue.toFixedString(),
        eligibleValue: p.eligibleValue.toFixedString(),
        eligible: p.eligible,
        haircut: p.haircut.times(100).toDecimalPlaces(2).toFixed(),
        liquidityAdjustment: p.liquidityAdjustment.toDecimalPlaces(4).toFixed(),
        concentrationAdjustment: p.concentrationAdjustment.toDecimalPlaces(4).toFixed(),
        concentration: p.concentration.times(100).toDecimalPlaces(2).toFixed(),
        priceAsOf: p.priceAsOf.toISOString(),
        ineligibilityReasons: p.ineligibilityReasons.map((r) => ({
          code: r, explanation: describeIneligibility(r),
        })),
      })),
    });
  });

  /** GET /collateral — eligible collateral and haircuts (PRD §21). */
  app.get('/v1/collateral', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const customer = await loadCustomer(ctx.pool, principal.customerId);
    const wealth = await computeWealth(
      ctx, ctx.pool, principal.customerId, customer.jurisdiction as Jurisdiction,
    );
    const policy = getPolicy();
    const snapshot = await previousSnapshot(ctx.pool, principal.customerId);

    return reply.send({
      eligibleCollateralValue: wealth.collateral.eligibleCollateralValue.toFixedString(),
      totalMarketValue: wealth.collateral.totalMarketValue.toFixedString(),
      topConcentration: wealth.collateral.topConcentration.times(100).toDecimalPlaces(2).toFixed(),
      weightedVolatility: wealth.collateral.weightedVolatility.toDecimalPlaces(4).toFixed(),
      weightedLiquidity: wealth.collateral.weightedLiquidity.toDecimalPlaces(4).toFixed(),
      concentrationCapBinding: wealth.collateral.concentrationCapBinding,
      withdrawable: snapshot?.withdrawableCollateral.toFixedString() ?? '0.00',
      advanceRate: D(policy.thresholds.maxOriginationLtv).times(100).toFixed(0),
      policyVersion: wealth.collateral.policyVersion,
      positions: wealth.collateral.positions.map((p) => ({
        assetId: p.assetId, symbol: p.symbol, assetClass: p.assetClass,
        quantity: p.quantity.toFixed(),
        marketValue: p.marketValue.toFixedString(),
        eligibleValue: p.eligibleValue.toFixedString(),
        eligibilityFactor: p.eligibilityFactor.toFixed(),
        haircut: p.haircut.times(100).toDecimalPlaces(2).toFixed(),
        eligible: p.eligible,
        ineligibilityReasons: p.ineligibilityReasons.map(describeIneligibility),
      })),
    });
  });

  /** GET /credit — limit, balance and available credit (PRD §21). */
  app.get('/v1/credit', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const facility = await findFacility(ctx.pool, principal.customerId);
    if (!facility) throw notFound('Credit facility');
    const decision = await latestDecision(ctx.pool, principal.customerId);
    const snapshot = await previousSnapshot(ctx.pool, principal.customerId);
    const policy = getPolicy();

    return reply.send({
      creditLimit: facility.creditLimit.toFixedString(),
      currentBalance: totalDebt(facility).toFixedString(),
      principalBalance: facility.principalBalance.toFixedString(),
      interestBalance: facility.interestBalance.toFixedString(),
      feeBalance: facility.feeBalance.toFixedString(),
      pendingAuthorizations: facility.holdsTotal.toFixedString(),
      availableCredit: availableCredit(facility).toFixedString(),
      safeSpendCapacity: snapshot
        ? maxSafeSpend(facility, snapshot, policy).toFixedString()
        : availableCredit(facility).toFixedString(),
      utilization: utilization(facility)?.times(100).toDecimalPlaces(2).toFixed() ?? null,
      apr: D(facility.aprBps).dividedBy(100).toFixed(2),
      status: facility.status,
      currency: facility.currency,
      decision: decision ? {
        approved: decision.approved,
        creditLimit: decision.creditLimit,
        previousLimit: decision.previousLimit,
        breakdown: decision.breakdown,
        declineReasons: decision.declineReasons,
        explanations: decision.explanations,
        policyVersion: decision.policyVersion,
        decidedAt: decision.decidedAt.toISOString(),
      } : null,
    });
  });

  /** GET /risk — LTV, health and risk state (PRD §21). */
  app.get('/v1/risk', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const snapshot = await previousSnapshot(ctx.pool, principal.customerId);
    if (!snapshot) throw notFound('Risk snapshot');
    const policy = getPolicy();

    const call = await queryOne<{ id: string; deadline_at: Date; required_amount: string }>(
      ctx.pool,
      `SELECT id, deadline_at, required_amount::text FROM margin_calls
        WHERE customer_id = $1 AND cured_at IS NULL
        ORDER BY raised_at DESC, id DESC LIMIT 1`,
      [principal.customerId],
    );

    return reply.send({
      state: snapshot.state,
      healthPercent: snapshot.healthPercent.toFixed(1),
      healthFactor: snapshot.healthFactor?.toDecimalPlaces(4).toFixed() ?? null,
      effectiveLtv: snapshot.effectiveLtv?.times(100).toDecimalPlaces(2).toFixed() ?? null,
      grossLtv: snapshot.grossLtv?.times(100).toDecimalPlaces(2).toFixed() ?? null,
      totalDebt: snapshot.totalDebt.toFixedString(),
      eligibleCollateralValue: snapshot.eligibleCollateralValue.toFixedString(),
      totalMarketValue: snapshot.totalMarketValue.toFixedString(),
      topConcentration: snapshot.topConcentration.times(100).toDecimalPlaces(2).toFixed(),
      withdrawableCollateral: snapshot.withdrawableCollateral.toFixedString(),
      safeSpendCapacity: snapshot.safeSpendCapacity.toFixedString(),
      triggeredRules: snapshot.triggeredRules,
      degraded: snapshot.degraded,
      collateralCallAmount: collateralCallAmount(snapshot, policy).toFixedString(),
      repaymentToTarget: repaymentToTarget(snapshot, policy).toFixedString(),
      thresholds: {
        watch: D(policy.thresholds.watchLtv).times(100).toFixed(0),
        restricted: D(policy.thresholds.restrictedLtv).times(100).toFixed(0),
        remediation: D(policy.thresholds.remediationLtv).times(100).toFixed(0),
        liquidation: D(policy.thresholds.liquidationLtv).times(100).toFixed(0),
      },
      marginCall: call ? {
        id: call.id,
        deadline: call.deadline_at.toISOString(),
        requiredAmount: money(call.required_amount).toFixedString(),
      } : null,
      policyVersion: snapshot.policyVersion,
      computedAt: snapshot.computedAt.toISOString(),
    });
  });

  /** Stress testing (PRD §12.2) exposed to the customer. */
  app.get('/v1/risk/stress', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const customer = await loadCustomer(ctx.pool, principal.customerId);
    const wealth = await computeWealth(
      ctx, ctx.pool, principal.customerId, customer.jurisdiction as Jurisdiction,
    );
    const snapshot = await previousSnapshot(ctx.pool, principal.customerId);
    if (!snapshot) throw notFound('Risk snapshot');
    return reply.send(stressReport(snapshot, wealth.collateral));
  });

  /** Model a purchase before making it — the PRD §7 "large purchase" journey. */
  app.post('/v1/credit/preview', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const body = parse(z.object({ amount: amountString }), req.body);

    const facility = await findFacility(ctx.pool, principal.customerId);
    if (!facility) throw notFound('Credit facility');
    const snapshot = await previousSnapshot(ctx.pool, principal.customerId);
    if (!snapshot) throw notFound('Risk snapshot');

    const preview = previewSpend(
      money(body.amount, facility.currency), facility, snapshot, getPolicy(), D(0),
    );

    return reply.send({
      amount: preview.amount.toFixedString(),
      affordable: preview.affordable,
      availableCreditAfter: preview.availableCreditAfter.toFixedString(),
      utilizationAfter: preview.utilizationAfter?.times(100).toDecimalPlaces(2).toFixed() ?? null,
      ltvAfter: preview.ltvAfter?.times(100).toDecimalPlaces(2).toFixed() ?? null,
      stateAfter: preview.stateAfter,
      healthPercentAfter: preview.healthPercentAfter.toFixed(1),
      drawdownToleranceAfter: preview.drawdownToleranceAfter?.times(100).toDecimalPlaces(0).toFixed() ?? null,
      explanation: preview.explanation,
    });
  });

  /** POST /collateral/add — pledge an asset (PRD §21). */
  app.post('/v1/collateral/add', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const body = parse(z.object({ assetId: z.string().uuid() }), req.body);

    const asset = await queryOne<{ id: string; symbol: string; quantity: string; pledged: boolean }>(
      ctx.pool,
      'SELECT id, symbol, quantity::text, pledged FROM assets WHERE id = $1 AND customer_id = $2',
      [body.assetId, principal.customerId],
    );
    if (!asset) throw notFound('Asset');
    if (asset.pledged) throw conflict('already_pledged', 'This asset is already pledged as collateral');

    const customer = await loadCustomer(ctx.pool, principal.customerId);
    if (customer.custody_account_id) {
      const pledge = await ctx.partners.custody.pledge(
        customer.custody_account_id, asset.symbol, D(asset.quantity), `pledge:${asset.id}`,
      );
      await query(
        ctx.pool, 'UPDATE assets SET pledged = TRUE, pledge_reference = $2, updated_at = now() WHERE id = $1',
        [asset.id, pledge.pledgeId],
      );
    } else {
      await query(ctx.pool, 'UPDATE assets SET pledged = TRUE, updated_at = now() WHERE id = $1', [asset.id]);
    }

    await audit(ctx.pool, {
      actorType: 'customer', actorId: principal.customerId,
      action: 'collateral.pledged', entityType: 'asset', entityId: asset.id,
      after: { symbol: asset.symbol, quantity: asset.quantity }, ip: clientIp(req),
    });

    const result = await refreshCustomer(ctx, ctx.pool, principal.customerId, {
      type: 'customer', id: principal.customerId,
    });

    return reply.send({
      pledged: true,
      symbol: asset.symbol,
      eligibleCollateralValue: result.wealth.collateral.eligibleCollateralValue.toFixedString(),
      creditLimit: result.evaluation.snapshot.eligibleCollateralValue.isPositive()
        ? (await findFacility(ctx.pool, principal.customerId))!.creditLimit.toFixedString()
        : '0.00',
      riskState: result.evaluation.snapshot.state,
    });
  });

  /**
   * POST /collateral/release — unpledge, subject to risk rules (PRD §21).
   *
   * The release is refused unless the account would remain inside the
   * origination LTV afterwards. This is the one place a customer can actively
   * make their own position worse, so it is gated on step-up as well.
   */
  app.post('/v1/collateral/release', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    requireStepUp(principal, 'release_collateral');
    const body = parse(z.object({ assetId: z.string().uuid() }), req.body);

    const customer = await loadCustomer(ctx.pool, principal.customerId);
    const asset = await queryOne<{ id: string; symbol: string; quantity: string; pledged: boolean; pledge_reference: string | null }>(
      ctx.pool,
      'SELECT id, symbol, quantity::text, pledged, pledge_reference FROM assets WHERE id = $1 AND customer_id = $2',
      [body.assetId, principal.customerId],
    );
    if (!asset) throw notFound('Asset');
    if (!asset.pledged) throw conflict('not_pledged', 'This asset is not currently pledged');

    // Model the release before performing it: compute collateral as if the
    // asset were already gone and check the resulting LTV.
    const wealth = await computeWealth(
      ctx, ctx.pool, principal.customerId, customer.jurisdiction as Jurisdiction,
    );
    const position = wealth.collateral.positions.find((p) => p.assetId === asset.id);
    const facility = await findFacility(ctx.pool, principal.customerId);
    if (!facility) throw notFound('Credit facility');

    const policy = getPolicy();
    const debt = totalDebt(facility).plus(facility.holdsTotal);
    const remaining = wealth.collateral.eligibleCollateralValue
      .minus(position?.eligibleValue ?? Money.zero('USD'));

    if (debt.isPositive()) {
      const maxDebt = remaining.times(D(policy.thresholds.maxOriginationLtv));
      if (debt.gt(maxDebt)) {
        throw badRequest('release_would_breach_ltv',
          `Releasing ${asset.symbol} would leave ${remaining.toFixedString()} of eligible collateral against a ${debt.toFixedString()} balance, above the ${D(policy.thresholds.maxOriginationLtv).times(100).toFixed(0)}% limit. Repay first or release a smaller position.`,
          {
            eligibleCollateralAfter: remaining.toFixedString(),
            currentDebt: debt.toFixedString(),
            maximumDebtAfterRelease: maxDebt.toFixedString(),
          });
      }
    }

    if (customer.custody_account_id && asset.pledge_reference) {
      await ctx.partners.custody.release(
        customer.custody_account_id, asset.pledge_reference, D(asset.quantity),
        `release:${asset.id}:${Date.now()}`,
      );
    }
    await query(
      ctx.pool,
      'UPDATE assets SET pledged = FALSE, pledge_reference = NULL, updated_at = now() WHERE id = $1',
      [asset.id],
    );

    await audit(ctx.pool, {
      actorType: 'customer', actorId: principal.customerId,
      action: 'collateral.released', entityType: 'asset', entityId: asset.id,
      after: { symbol: asset.symbol, quantity: asset.quantity }, ip: clientIp(req),
    });

    const result = await refreshCustomer(ctx, ctx.pool, principal.customerId, {
      type: 'customer', id: principal.customerId,
    });

    return reply.send({
      released: true,
      symbol: asset.symbol,
      eligibleCollateralValue: result.wealth.collateral.eligibleCollateralValue.toFixedString(),
      riskState: result.evaluation.snapshot.state,
    });
  });

  /** GET /alerts — risk, fraud and credit alerts (PRD §21). */
  app.get('/v1/alerts', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const q = parse(z.object({
      status: z.enum(['open', 'acknowledged', 'resolved', 'all']).default('open'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }), req.query);

    const rows = await query<{
      id: string; kind: string; severity: string; title: string; body: string;
      action_label: string | null; action_href: string | null; status: string; created_at: Date;
    }>(
      ctx.pool,
      `SELECT * FROM alerts
        WHERE customer_id = $1 AND ($2 = 'all' OR status = $2)
        ORDER BY
          CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          created_at DESC
        LIMIT $3`,
      [principal.customerId, q.status, q.limit],
    );

    return reply.send({
      alerts: rows.map((a) => ({
        id: a.id, kind: a.kind, severity: a.severity, title: a.title, body: a.body,
        actionLabel: a.action_label, actionHref: a.action_href, status: a.status,
        createdAt: a.created_at.toISOString(),
      })),
    });
  });

  app.post('/v1/alerts/:id/acknowledge', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const updated = await query(
      ctx.pool,
      `UPDATE alerts SET status = 'acknowledged', acknowledged_at = now()
        WHERE id = $1 AND customer_id = $2 AND status = 'open' RETURNING id`,
      [id, principal.customerId],
    );
    if (updated.length === 0) throw notFound('Open alert');
    return reply.send({ ok: true });
  });

  /** Force a revaluation. Useful after connecting an account. */
  app.post('/v1/account/refresh', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const result = await refreshCustomer(ctx, ctx.pool, principal.customerId, {
      type: 'customer', id: principal.customerId,
    });
    return reply.send({
      eligibleCollateralValue: result.wealth.collateral.eligibleCollateralValue.toFixedString(),
      riskState: result.evaluation.snapshot.state,
      healthPercent: result.evaluation.snapshot.healthPercent.toFixed(1),
      limitChanged: result.limitChanged,
      stateChanged: result.evaluation.stateChanged,
      alertsRaised: result.evaluation.alertIds.length,
    });
  });
};
