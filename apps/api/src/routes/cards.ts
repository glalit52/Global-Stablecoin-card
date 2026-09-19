/** Card management, transactions and repayment (PRD §13, §21). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { D, getPolicy, minimumPayment, Money, totalDebt } from '@wealthcard/core';
import { requireCustomer, requireStepUp } from '../auth.js';
import { money, query, queryOne } from '../db.js';
import { notFound } from '../errors.js';
import { amountString, currencyCode, parse } from './helpers.js';
import type { AppContext } from '../context.js';
import {
  issueCard, listCards, provisionWallet, revealCard, setCardStatus, updateControls,
} from '../services/cards.js';
import { applyRepayment, authorizeTransaction, settleAuthorization } from '../services/payments.js';
import { findFacility, loadCustomer } from '../services/credit.js';
import { redeem, rewardsSummary } from '../services/rewards.js';
import { refreshCustomer } from '../services/orchestrator.js';
import { computeWealth } from '../services/wealth.js';

export const registerCardRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  app.get('/v1/cards', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    return reply.send({ cards: await listCards(ctx.pool, principal.customerId) });
  });

  app.post('/v1/cards', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const body = parse(z.object({
      form: z.enum(['virtual', 'physical']),
      nameOnCard: z.string().min(2).max(64),
    }), req.body);
    const card = await issueCard(ctx, ctx.pool, principal.customerId, body.form, body.nameOnCard);
    return reply.code(201).send(card);
  });

  app.post('/v1/cards/:id/status', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      status: z.enum(['active', 'frozen', 'inactive', 'cancelled', 'lost_stolen']),
    }), req.body);

    await setCardStatus(ctx, ctx.pool, id, principal.customerId, body.status, {
      type: 'customer', id: principal.customerId,
    });
    return reply.send({ ok: true, status: body.status });
  });

  app.patch('/v1/cards/:id/controls', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      blockedMccs: z.array(z.string().regex(/^\d{4}$/)).optional(),
      allowedCountries: z.array(z.string().length(2)).optional(),
      blockedCountries: z.array(z.string().length(2)).optional(),
      atmEnabled: z.boolean().optional(),
      onlineEnabled: z.boolean().optional(),
      contactlessEnabled: z.boolean().optional(),
      internationalEnabled: z.boolean().optional(),
      perTransactionLimit: amountString.nullable().optional(),
      dailyLimit: amountString.nullable().optional(),
      monthlyLimit: amountString.nullable().optional(),
    }), req.body);

    const controls = await updateControls(ctx, ctx.pool, id, principal.customerId, body);
    return reply.send({
      controls: {
        ...controls,
        perTransactionLimit: controls.perTransactionLimit?.toFixedString() ?? null,
        dailyLimit: controls.dailyLimit?.toFixedString() ?? null,
        monthlyLimit: controls.monthlyLimit?.toFixedString() ?? null,
      },
    });
  });

  /** Reveal the card number. Requires a fresh step-up signature. */
  app.post('/v1/cards/:id/reveal', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    requireStepUp(principal, 'reveal_card');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const secrets = await revealCard(ctx, ctx.pool, id, principal.customerId);
    // Never cached: this response contains the PAN.
    return reply.header('cache-control', 'no-store').send(secrets);
  });

  app.post('/v1/cards/:id/wallet', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ wallet: z.enum(['apple_pay', 'google_pay']) }), req.body);
    const result = await provisionWallet(ctx, ctx.pool, id, principal.customerId, body.wallet);
    return reply.send(result);
  });

  /**
   * POST /card/authorize — the network-facing authorization endpoint (PRD §21).
   *
   * In production this is called by the card processor, not the customer app.
   * It is exposed here so the whole payment path can be driven end to end.
   */
  app.post('/v1/card/authorize', async (req, reply) => {
    const body = parse(z.object({
      requestId: z.string().min(8).max(128),
      cardId: z.string().uuid(),
      amount: amountString,
      currency: currencyCode.default('USD'),
      merchantId: z.string().min(1).max(64),
      merchantName: z.string().min(1).max(120),
      mcc: z.string().regex(/^\d{4}$/),
      merchantCountry: z.string().length(2),
      entryMode: z.enum(['contactless', 'chip', 'ecommerce', 'atm', 'wallet', 'manual']),
      isRecurring: z.boolean().default(false),
      deviceId: z.string().optional(),
      geo: z.object({ lat: z.number(), lon: z.number() }).optional(),
    }), req.body);

    const decision = await authorizeTransaction(ctx, ctx.pool, body);

    return reply.code(decision.approved ? 200 : 402).send({
      requestId: decision.requestId,
      approved: decision.approved,
      authorizationId: decision.authorizationId,
      billingAmount: decision.billingAmount.toFixedString(),
      fxRate: decision.fxRate?.toDecimalPlaces(6).toFixed() ?? null,
      fxFee: decision.fxFee.toFixedString(),
      declineCode: decision.declineCode,
      declineReason: decision.declineReason,
      availableCreditAfter: decision.availableCreditAfter.toFixedString(),
      fraudScore: decision.fraudScore.toDecimalPlaces(3).toFixed(),
      checks: decision.checks,
      latencyMs: decision.latencyMs,
    });
  });

  /** Settlement callback from the processor. */
  app.post('/v1/card/settle', async (req, reply) => {
    const body = parse(z.object({
      requestId: z.string().min(8),
      settledAmount: amountString.optional(),
    }), req.body);
    const result = await settleAuthorization(ctx, ctx.pool, body.requestId, body.settledAmount);
    // Refresh so the customer's risk state reflects the new balance at once.
    const auth = await queryOne<{ customer_id: string }>(
      ctx.pool, 'SELECT customer_id FROM authorizations WHERE request_id = $1', [body.requestId],
    );
    if (auth) await refreshCustomer(ctx, ctx.pool, auth.customer_id);
    return reply.send(result);
  });

  /** GET /transactions — transaction history (PRD §21). */
  app.get('/v1/transactions', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const q = parse(z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      category: z.string().optional(),
      includeDeclined: z.coerce.boolean().default(false),
    }), req.query);

    const rows = await query<{
      id: string; merchant_name: string; mcc: string; category: string;
      merchant_country: string; original_amount: string; original_currency: string;
      billing_amount: string; fx_rate: string | null; fx_fee: string;
      points_earned: string; status: string; authorized_at: Date; settled_at: Date | null;
    }>(
      ctx.pool,
      `SELECT * FROM transactions
        WHERE customer_id = $1 AND ($2::text IS NULL OR category = $2)
        ORDER BY authorized_at DESC LIMIT $3 OFFSET $4`,
      [principal.customerId, q.category ?? null, q.limit, q.offset],
    );

    const declined = q.includeDeclined
      ? await query<{
          request_id: string; merchant_name: string; mcc: string; merchant_country: string;
          original_amount: string; original_currency: string; decline_code: string | null;
          decline_reason: string | null; decided_at: Date;
        }>(
          ctx.pool,
          `SELECT request_id, merchant_name, mcc, merchant_country, original_amount::text,
                  original_currency, decline_code, decline_reason, decided_at
             FROM authorizations
            WHERE customer_id = $1 AND NOT approved
            ORDER BY decided_at DESC LIMIT 25`,
          [principal.customerId],
        )
      : [];

    return reply.send({
      transactions: rows.map((t) => ({
        id: t.id,
        merchantName: t.merchant_name,
        mcc: t.mcc,
        category: t.category,
        merchantCountry: t.merchant_country,
        originalAmount: money(t.original_amount, t.original_currency).toFixedString(),
        originalCurrency: t.original_currency,
        billingAmount: money(t.billing_amount).toFixedString(),
        fxRate: t.fx_rate ? D(t.fx_rate).toDecimalPlaces(6).toFixed() : null,
        fxFee: money(t.fx_fee).toFixedString(),
        pointsEarned: D(t.points_earned).toFixed(0),
        status: t.status,
        authorizedAt: t.authorized_at.toISOString(),
        settledAt: t.settled_at?.toISOString() ?? null,
      })),
      declined: declined.map((d) => ({
        requestId: d.request_id,
        merchantName: d.merchant_name,
        mcc: d.mcc,
        merchantCountry: d.merchant_country,
        amount: money(d.original_amount, d.original_currency).toFixedString(),
        currency: d.original_currency,
        declineCode: d.decline_code,
        declineReason: d.decline_reason,
        declinedAt: d.decided_at.toISOString(),
      })),
    });
  });

  /** POST /repayment — initiate a supported repayment (PRD §21). */
  app.post('/v1/repayment', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const body = parse(z.object({
      amount: amountString,
      source: z.enum(['fiat', 'stablecoin']).default('fiat'),
      idempotencyKey: z.string().min(8).max(128),
    }), req.body);

    const result = await applyRepayment(
      ctx, ctx.pool, principal.customerId, body.amount, body.source, body.idempotencyKey,
    );
    const refreshed = await refreshCustomer(ctx, ctx.pool, principal.customerId, {
      type: 'customer', id: principal.customerId,
    });
    const facility = await findFacility(ctx.pool, principal.customerId);

    return reply.send({
      repaymentId: result.repaymentId,
      duplicate: result.duplicate,
      applied: result.applied,
      balanceAfter: facility ? totalDebt(facility).toFixedString() : '0.00',
      availableCredit: facility
        ? facility.creditLimit.minus(totalDebt(facility)).minus(facility.holdsTotal).clampPositive().toFixedString()
        : '0.00',
      riskState: refreshed.evaluation.snapshot.state,
    });
  });

  app.get('/v1/statements', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const rows = await query<{
      id: string; period_start: Date; period_end: Date; opening_balance: string;
      purchases: string; interest_charged: string; fees_charged: string; payments: string;
      closing_balance: string; minimum_payment: string; due_date: Date; paid_at: Date | null;
    }>(
      ctx.pool,
      'SELECT * FROM statements WHERE customer_id = $1 ORDER BY period_end DESC LIMIT 24',
      [principal.customerId],
    );
    const facility = await findFacility(ctx.pool, principal.customerId);

    return reply.send({
      currentMinimumPayment: facility
        ? minimumPayment(totalDebt(facility), getPolicy()).toFixedString()
        : '0.00',
      statements: rows.map((s) => ({
        id: s.id,
        periodStart: s.period_start.toISOString().slice(0, 10),
        periodEnd: s.period_end.toISOString().slice(0, 10),
        openingBalance: money(s.opening_balance).toFixedString(),
        purchases: money(s.purchases).toFixedString(),
        interestCharged: money(s.interest_charged).toFixedString(),
        feesCharged: money(s.fees_charged).toFixedString(),
        payments: money(s.payments).toFixedString(),
        closingBalance: money(s.closing_balance).toFixedString(),
        minimumPayment: money(s.minimum_payment).toFixedString(),
        dueDate: s.due_date.toISOString().slice(0, 10),
        paidAt: s.paid_at?.toISOString() ?? null,
      })),
    });
  });

  /** GET /rewards — balance and ledger (PRD §21). */
  app.get('/v1/rewards', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const customer = await loadCustomer(ctx.pool, principal.customerId);
    const wealth = await computeWealth(
      ctx, ctx.pool, principal.customerId, customer.jurisdiction as never,
    );
    return reply.send(await rewardsSummary(
      ctx.pool, principal.customerId, customer.tier, wealth.collateral.eligibleCollateralValue,
    ));
  });

  app.post('/v1/rewards/redeem', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    requireStepUp(principal, 'redeem');
    const body = parse(z.object({
      kind: z.enum(['statement_credit', 'travel', 'crypto', 'transfer_partner']),
      points: z.string().regex(/^\d+$/),
    }), req.body);

    const customer = await loadCustomer(ctx.pool, principal.customerId);
    const result = await redeem(
      ctx, ctx.pool, principal.customerId, customer.tier, body.kind, body.points, customer.jurisdiction,
    );
    return reply.send(result);
  });

  app.post('/v1/lounge/visit', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const body = parse(z.object({
      loungeName: z.string().min(1).max(120),
      airportCode: z.string().length(3),
    }), req.body);

    const customer = await loadCustomer(ctx.pool, principal.customerId);
    const policy = getPolicy();
    const used = await queryOne<{ count: string }>(
      ctx.pool,
      `SELECT COUNT(*)::text AS count FROM lounge_visits
        WHERE customer_id = $1 AND visited_at >= date_trunc('year', now())`,
      [principal.customerId],
    );
    const allowance = policy.tiers[customer.tier].loungeVisitsPerYear;
    const covered = allowance < 0 || Number(used?.count ?? '0') < allowance;
    const charge = covered ? Money.zero('USD') : Money.of('45', 'USD');

    const row = await queryOne<{ id: string }>(
      ctx.pool,
      `INSERT INTO lounge_visits (customer_id, lounge_name, airport_code, covered, charged_amount)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [principal.customerId, body.loungeName, body.airportCode.toUpperCase(), covered, charge.toString()],
    );

    return reply.code(201).send({
      visitId: row!.id,
      covered,
      chargedAmount: charge.toFixedString(),
      visitsRemaining: allowance < 0 ? null : Math.max(0, allowance - Number(used?.count ?? '0') - 1),
    });
  });
};
