/**
 * Operations console API (PRD §22).
 *
 * Two rules shape every endpoint here:
 *   - role-based access, checked per route, and
 *   - dual approval for anything that can move money, change a limit by hand,
 *     sell a customer's collateral or promote a risk policy.
 *
 * PRD §22: "No single operations user should be able to bypass critical risk
 * controls." So the high-impact routes do not act — they file an approval
 * request. A second operator with the right role executes it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  D, getActivePolicyVersion, getPolicy, listPolicyVersions, setActivePolicy,
  validatePolicy, type Jurisdiction,
} from '@wealthcard/core';
import { requireOperator } from '../auth.js';
import { money, query, queryOne, toNumeric, transaction } from '../db.js';
import { audit } from '../audit.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { amountString, clientIp, parse } from './helpers.js';
import type { AppContext } from '../context.js';
import { findFacility, loadCustomer } from '../services/credit.js';
import { computeWealth } from '../services/wealth.js';
import { previousSnapshot, stressReport } from '../services/risk.js';
import { runReconciliation } from '../services/ledger.js';
import { cancelLiquidation, executeLiquidation } from '../services/liquidation.js';
import { refreshCustomer } from '../services/orchestrator.js';
import { setCardStatus } from '../services/cards.js';

/** Actions that may not be performed by a single operator. */
const DUAL_APPROVAL_ACTIONS = new Set([
  'credit.manual_limit_override',
  'liquidation.execute',
  'facility.write_off',
  'policy.activate',
  'customer.close',
]);

export const registerAdminRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  app.get('/v1/admin/customers', async (req, reply) => {
    const operator = requireOperator(req.principal, 'support', 'risk', 'compliance', 'admin');
    const q = parse(z.object({
      search: z.string().max(200).optional(),
      state: z.enum(['healthy', 'watch', 'restricted', 'remediation', 'liquidation']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }), req.query);

    const rows = await query<{
      id: string; email: string; legal_name: string; jurisdiction: string; tier: string;
      status: string; kyc_status: string; credit_limit: string | null;
      principal_balance: string | null; state: string | null; health_percent: string | null;
      effective_ltv: string | null; created_at: Date;
    }>(
      ctx.pool,
      `SELECT c.id, c.email, c.legal_name, c.jurisdiction, c.tier, c.status, c.kyc_status,
              f.credit_limit::text, f.principal_balance::text,
              r.state::text, r.health_percent::text, r.effective_ltv::text, c.created_at
         FROM customers c
         LEFT JOIN credit_facilities f ON f.customer_id = c.id
         LEFT JOIN LATERAL (
           SELECT state, health_percent, effective_ltv FROM risk_snapshots
            WHERE customer_id = c.id ORDER BY computed_at DESC LIMIT 1
         ) r ON TRUE
        WHERE ($1::text IS NULL OR c.legal_name ILIKE '%'||$1||'%' OR c.email ILIKE '%'||$1||'%')
          AND ($2::text IS NULL OR r.state::text = $2)
        ORDER BY
          CASE r.state::text
            WHEN 'liquidation' THEN 0 WHEN 'remediation' THEN 1
            WHEN 'restricted' THEN 2 WHEN 'watch' THEN 3 ELSE 4 END,
          c.created_at DESC
        LIMIT $3`,
      [q.search ?? null, q.state ?? null, q.limit],
    );

    await audit(ctx.pool, {
      actorType: 'operator', actorId: operator.operatorId,
      action: 'admin.customers_listed', entityType: 'customer', entityId: 'list',
      after: { search: q.search ?? null, results: rows.length }, ip: clientIp(req),
    });

    return reply.send({
      customers: rows.map((c) => ({
        id: c.id, email: c.email, legalName: c.legal_name,
        jurisdiction: c.jurisdiction, tier: c.tier, status: c.status, kycStatus: c.kyc_status,
        creditLimit: c.credit_limit ? money(c.credit_limit).toFixedString() : null,
        balance: c.principal_balance ? money(c.principal_balance).toFixedString() : null,
        riskState: c.state,
        healthPercent: c.health_percent,
        effectiveLtv: c.effective_ltv ? D(c.effective_ltv).times(100).toDecimalPlaces(2).toFixed() : null,
        createdAt: c.created_at.toISOString(),
      })),
    });
  });

  app.get('/v1/admin/customers/:id', async (req, reply) => {
    const operator = requireOperator(req.principal, 'support', 'risk', 'compliance', 'admin');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);

    const customer = await loadCustomer(ctx.pool, id);
    const facility = await findFacility(ctx.pool, id);
    const snapshot = await previousSnapshot(ctx.pool, id);
    const wealth = await computeWealth(ctx, ctx.pool, id, customer.jurisdiction as Jurisdiction);

    const [cards, transactions, alerts, marginCalls, liquidations] = await Promise.all([
      query(ctx.pool, 'SELECT id, form, last4, status, exp_month, exp_year FROM cards WHERE customer_id = $1', [id]),
      query(ctx.pool, `SELECT id, merchant_name, category, billing_amount::text, status, authorized_at
                         FROM transactions WHERE customer_id = $1 ORDER BY authorized_at DESC LIMIT 25`, [id]),
      query(ctx.pool, `SELECT id, kind, severity, title, status, created_at FROM alerts
                        WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 25`, [id]),
      query(ctx.pool, `SELECT id, raised_at, deadline_at, required_amount::text, cured_at, cure_method
                         FROM margin_calls WHERE customer_id = $1 ORDER BY raised_at DESC LIMIT 10`, [id]),
      query(ctx.pool, `SELECT id, status, triggered_by, total_net_proceeds::text, planned_at, executed_at
                         FROM liquidations WHERE customer_id = $1 ORDER BY planned_at DESC LIMIT 10`, [id]),
    ]);

    await audit(ctx.pool, {
      actorType: 'operator', actorId: operator.operatorId,
      action: 'admin.customer_viewed', entityType: 'customer', entityId: id, ip: clientIp(req),
    });

    return reply.send({
      customer: {
        id: customer.id, email: customer.email, legalName: customer.legal_name,
        jurisdiction: customer.jurisdiction, tier: customer.tier, status: customer.status,
        kycStatus: customer.kyc_status, sanctionsClear: customer.sanctions_clear,
        pepReviewCleared: customer.pep_review_cleared, fraudScore: customer.fraud_score,
        createdAt: customer.created_at.toISOString(),
      },
      facility: facility ? {
        creditLimit: facility.creditLimit.toFixedString(),
        principalBalance: facility.principalBalance.toFixedString(),
        interestBalance: facility.interestBalance.toFixedString(),
        feeBalance: facility.feeBalance.toFixedString(),
        holds: facility.holdsTotal.toFixedString(),
        apr: D(facility.aprBps).dividedBy(100).toFixed(2),
        status: facility.status,
      } : null,
      risk: snapshot ? {
        state: snapshot.state,
        healthPercent: snapshot.healthPercent.toFixed(1),
        effectiveLtv: snapshot.effectiveLtv?.times(100).toDecimalPlaces(2).toFixed() ?? null,
        triggeredRules: snapshot.triggeredRules,
        computedAt: snapshot.computedAt.toISOString(),
      } : null,
      collateral: {
        eligibleValue: wealth.collateral.eligibleCollateralValue.toFixedString(),
        marketValue: wealth.collateral.totalMarketValue.toFixedString(),
        positions: wealth.collateral.positions.map((p) => ({
          symbol: p.symbol, quantity: p.quantity.toFixed(),
          marketValue: p.marketValue.toFixedString(),
          eligibleValue: p.eligibleValue.toFixedString(),
          haircut: p.haircut.times(100).toDecimalPlaces(2).toFixed(),
          eligible: p.eligible, reasons: p.ineligibilityReasons,
        })),
      },
      stress: snapshot ? stressReport(snapshot, wealth.collateral) : null,
      cards, transactions, alerts, marginCalls, liquidations,
    });
  });

  /** Freeze or unfreeze a card from the console. */
  app.post('/v1/admin/customers/:id/cards/:cardId/status', async (req, reply) => {
    const operator = requireOperator(req.principal, 'support', 'risk', 'admin');
    const params = parse(z.object({ id: z.string().uuid(), cardId: z.string().uuid() }), req.params);
    const body = parse(z.object({
      status: z.enum(['active', 'frozen', 'cancelled', 'lost_stolen']),
      reason: z.string().min(3).max(500),
    }), req.body);

    await setCardStatus(ctx, ctx.pool, params.cardId, params.id, body.status, {
      type: 'operator', id: operator.operatorId,
    });
    await audit(ctx.pool, {
      actorType: 'operator', actorId: operator.operatorId,
      action: 'admin.card_status_changed', entityType: 'card', entityId: params.cardId,
      after: { status: body.status, reason: body.reason }, ip: clientIp(req),
    });
    return reply.send({ ok: true });
  });

  app.post('/v1/admin/customers/:id/refresh', async (req, reply) => {
    const operator = requireOperator(req.principal, 'risk', 'admin');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const result = await refreshCustomer(ctx, ctx.pool, id, { type: 'operator', id: operator.operatorId });
    return reply.send({
      riskState: result.evaluation.snapshot.state,
      healthPercent: result.evaluation.snapshot.healthPercent.toFixed(1),
      limitChanged: result.limitChanged,
      liquidationPlanned: result.liquidation?.liquidationId ?? null,
    });
  });

  // --- Dual approval --------------------------------------------------------

  app.post('/v1/admin/approvals', async (req, reply) => {
    const operator = requireOperator(req.principal, 'risk', 'compliance', 'admin');
    const body = parse(z.object({
      action: z.string().min(3).max(100),
      entityType: z.string().min(1).max(50),
      entityId: z.string().min(1).max(100),
      payload: z.record(z.unknown()).default({}),
      justification: z.string().min(10).max(1000),
    }), req.body);

    if (!DUAL_APPROVAL_ACTIONS.has(body.action)) {
      throw badRequest('action_not_dual_approved',
        `"${body.action}" is not an action that goes through approval. Call its endpoint directly.`,
        { dualApprovalActions: [...DUAL_APPROVAL_ACTIONS] });
    }

    const row = await queryOne<{ id: string }>(
      ctx.pool,
      `INSERT INTO approval_requests (action, entity_type, entity_id, payload, justification, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [body.action, body.entityType, body.entityId, JSON.stringify(body.payload),
       body.justification, operator.operatorId],
    );

    await audit(ctx.pool, {
      actorType: 'operator', actorId: operator.operatorId,
      action: 'admin.approval_requested', entityType: 'approval_request', entityId: row!.id,
      after: { action: body.action, entityId: body.entityId }, ip: clientIp(req),
    });

    return reply.code(201).send({ approvalId: row!.id, status: 'pending' });
  });

  app.get('/v1/admin/approvals', async (req, reply) => {
    requireOperator(req.principal, 'risk', 'compliance', 'admin');
    const rows = await query<{
      id: string; action: string; entity_type: string; entity_id: string;
      payload: Record<string, unknown>; justification: string; status: string;
      requested_by: string; requester: string; requested_at: Date;
    }>(
      ctx.pool,
      `SELECT a.*, o.name AS requester FROM approval_requests a
         JOIN operators o ON o.id = a.requested_by
        WHERE a.status = 'pending' ORDER BY a.requested_at`,
    );
    return reply.send({
      approvals: rows.map((a) => ({
        id: a.id, action: a.action, entityType: a.entity_type, entityId: a.entity_id,
        payload: a.payload, justification: a.justification,
        requestedBy: a.requester, requestedAt: a.requested_at.toISOString(),
      })),
    });
  });

  /**
   * Approve and execute. The four-eyes constraint is enforced by the database
   * as well as here, so a bug in this handler still cannot let one operator
   * approve their own request.
   */
  app.post('/v1/admin/approvals/:id/approve', async (req, reply) => {
    const operator = requireOperator(req.principal, 'risk', 'compliance', 'admin');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);

    const request = await transaction(ctx.pool, async (tx) => {
      const row = await queryOne<{
        id: string; action: string; entity_type: string; entity_id: string;
        payload: Record<string, unknown>; status: string; requested_by: string;
      }>(tx, 'SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE', [id]);

      if (!row) throw notFound('Approval request');
      if (row.status !== 'pending') throw conflict('already_resolved', `This request is already ${row.status}`);
      if (row.requested_by === operator.operatorId) {
        throw forbidden('You cannot approve a request you raised yourself');
      }

      await query(
        tx,
        `UPDATE approval_requests SET status = 'approved', approved_by = $2, resolved_at = now() WHERE id = $1`,
        [id, operator.operatorId],
      );
      return row;
    });

    // Execute outside the approval transaction: a liquidation talks to a
    // custodian, which must not happen while holding that row lock.
    let result: unknown = { executed: false };

    switch (request.action) {
      case 'liquidation.execute':
        result = await executeLiquidation(ctx, ctx.pool, request.entity_id, {
          type: 'operator', id: operator.operatorId,
        });
        break;

      case 'credit.manual_limit_override': {
        const limit = money(String(request.payload.creditLimit ?? '0'));
        await query(
          ctx.pool,
          'UPDATE credit_facilities SET credit_limit = $2, updated_at = now() WHERE customer_id = $1',
          [request.entity_id, toNumeric(limit)],
        );
        result = { creditLimit: limit.toFixedString() };
        break;
      }

      case 'policy.activate': {
        const version = String(request.payload.policyVersion ?? '');
        const errors = validatePolicy(getPolicy(version));
        if (errors.length > 0) {
          throw badRequest('policy_invalid', 'That policy version does not pass validation', { errors });
        }
        setActivePolicy(version);
        await query(
          ctx.pool,
          `INSERT INTO policy_activations (policy_version, activated_by, approval_id, notes)
           VALUES ($1,$2,$3,$4)`,
          [version, operator.operatorId, id, String(request.payload.notes ?? '')],
        );
        result = { activePolicyVersion: version };
        break;
      }

      case 'customer.close':
        await query(ctx.pool, `UPDATE customers SET status = 'closed' WHERE id = $1`, [request.entity_id]);
        result = { closed: true };
        break;

      case 'facility.write_off':
        result = { note: 'Write-off recorded for manual finance processing' };
        break;

      default:
        throw badRequest('unknown_action', `No executor is registered for "${request.action}"`);
    }

    await query(ctx.pool, 'UPDATE approval_requests SET executed_at = now() WHERE id = $1', [id]);
    await audit(ctx.pool, {
      actorType: 'operator', actorId: operator.operatorId,
      action: 'admin.approval_executed', entityType: 'approval_request', entityId: id,
      after: { action: request.action, result }, ip: clientIp(req),
    });

    return reply.send({ approved: true, action: request.action, result });
  });

  app.post('/v1/admin/approvals/:id/reject', async (req, reply) => {
    const operator = requireOperator(req.principal, 'risk', 'compliance', 'admin');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ reason: z.string().min(5).max(500) }), req.body);

    const updated = await query(
      ctx.pool,
      `UPDATE approval_requests
          SET status = 'rejected', approved_by = $2, rejection_reason = $3, resolved_at = now()
        WHERE id = $1 AND status = 'pending' AND requested_by <> $2
        RETURNING id`,
      [id, operator.operatorId, body.reason],
    );
    if (updated.length === 0) {
      throw conflict('cannot_reject', 'This request is not pending, or you raised it yourself');
    }
    return reply.send({ rejected: true });
  });

  // --- Risk operations ------------------------------------------------------

  app.get('/v1/admin/liquidations', async (req, reply) => {
    requireOperator(req.principal, 'risk', 'admin');
    const rows = await query(
      ctx.pool,
      `SELECT l.id, l.customer_id, c.legal_name, l.status, l.triggered_by, l.strategy,
              l.debt_before::text, l.collateral_before::text, l.plan,
              l.total_net_proceeds::text, l.planned_at, l.executed_at
         FROM liquidations l JOIN customers c ON c.id = l.customer_id
        ORDER BY l.planned_at DESC LIMIT 100`,
    );
    return reply.send({ liquidations: rows });
  });

  app.post('/v1/admin/liquidations/:id/cancel', async (req, reply) => {
    const operator = requireOperator(req.principal, 'risk', 'admin');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ reason: z.string().min(5).max(500) }), req.body);
    await cancelLiquidation(ctx.pool, id, operator.operatorId, body.reason);
    return reply.send({ cancelled: true });
  });

  /** Daily reconciliation (PRD §22). */
  app.get('/v1/admin/reconciliation', async (req, reply) => {
    requireOperator(req.principal, 'risk', 'compliance', 'admin');
    const report = await runReconciliation(ctx.pool);
    return reply.send({
      runAt: report.runAt.toISOString(),
      entryCount: report.entryCount,
      balanced: report.trialBalance.balanced,
      totalDebits: report.trialBalance.totalDebits.toFixedString(),
      totalCredits: report.trialBalance.totalCredits.toFixedString(),
      residual: report.trialBalance.residual.toFixedString(),
      breaks: report.breaks.map((b) => ({
        kind: b.kind, detail: b.detail,
        amount: b.amount?.toFixedString() ?? null, reference: b.reference,
      })),
      income: {
        interchange: report.income.revenue.interchange.toFixedString(),
        interest: report.income.revenue.interest.toFixedString(),
        fx: report.income.revenue.fx.toFixedString(),
        membership: report.income.revenue.membership.toFixedString(),
        rewardsCost: report.income.expenses.rewards.toFixedString(),
        creditLoss: report.income.expenses.creditLoss.toFixedString(),
        liquidationCost: report.income.expenses.liquidationCost.toFixedString(),
        totalRevenue: report.income.totalRevenue.toFixedString(),
        totalExpense: report.income.totalExpense.toFixedString(),
        grossProfit: report.income.grossProfit.toFixedString(),
        grossMargin: report.income.grossMargin.times(100).toDecimalPlaces(2).toFixed(),
      },
    });
  });

  /** Policy versioning (PRD §22 "model/risk parameter versioning"). */
  app.get('/v1/admin/policies', async (req, reply) => {
    requireOperator(req.principal, 'risk', 'compliance', 'admin');
    const active = getActivePolicyVersion();
    const history = await query(
      ctx.pool,
      `SELECT p.policy_version, p.activated_at, o.name AS activated_by, p.notes
         FROM policy_activations p LEFT JOIN operators o ON o.id = p.activated_by
        ORDER BY p.activated_at DESC LIMIT 50`,
    );
    return reply.send({
      activeVersion: active,
      available: listPolicyVersions().map((v) => ({
        version: v,
        valid: validatePolicy(getPolicy(v)).length === 0,
        validationErrors: validatePolicy(getPolicy(v)),
      })),
      active: getPolicy(active),
      history,
    });
  });

  /** Audit log (PRD §22). Read-only, for everyone with console access. */
  app.get('/v1/admin/audit', async (req, reply) => {
    requireOperator(req.principal, 'compliance', 'risk', 'admin');
    const q = parse(z.object({
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      actorId: z.string().optional(),
      action: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }), req.query);

    const rows = await query(
      ctx.pool,
      `SELECT id, actor_type, actor_id, action, entity_type, entity_id,
              before_state, after_state, policy_version, occurred_at
         FROM audit_log
        WHERE ($1::text IS NULL OR entity_type = $1)
          AND ($2::text IS NULL OR entity_id = $2)
          AND ($3::text IS NULL OR actor_id = $3)
          AND ($4::text IS NULL OR action = $4)
        ORDER BY occurred_at DESC LIMIT $5`,
      [q.entityType ?? null, q.entityId ?? null, q.actorId ?? null, q.action ?? null, q.limit],
    );
    return reply.send({ entries: rows });
  });

  /** AI interactions, including anything the grounding check rejected. */
  app.get('/v1/admin/ai-interactions', async (req, reply) => {
    requireOperator(req.principal, 'compliance', 'risk', 'admin');
    const q = parse(z.object({
      rejectedOnly: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }), req.query);

    const rows = await query(
      ctx.pool,
      `SELECT a.id, a.customer_id, c.legal_name, a.question, a.intent, a.answer,
              a.model_used, a.model_name, a.grounding_rejected, a.grounding_violations,
              a.cited_fact_keys, a.latency_ms, a.policy_version, a.created_at
         FROM ai_interactions a JOIN customers c ON c.id = a.customer_id
        WHERE ($1 = FALSE OR a.grounding_rejected)
        ORDER BY a.created_at DESC LIMIT $2`,
      [q.rejectedOnly, q.limit],
    );
    return reply.send({ interactions: rows });
  });

  /** Portfolio-level KPIs (PRD §26). */
  app.get('/v1/admin/metrics', async (req, reply) => {
    requireOperator(req.principal, 'risk', 'compliance', 'admin');

    const [portfolio, states, spend, fraud] = await Promise.all([
      queryOne<{
        customers: string; funded: string; total_limit: string; total_balance: string;
        total_collateral: string;
      }>(
        ctx.pool,
        `SELECT COUNT(*)::text AS customers,
                COUNT(*) FILTER (WHERE f.principal_balance > 0)::text AS funded,
                COALESCE(SUM(f.credit_limit),0)::text AS total_limit,
                COALESCE(SUM(f.principal_balance + f.interest_balance + f.fee_balance),0)::text AS total_balance,
                COALESCE((SELECT SUM(eligible_collateral_value) FROM (
                  SELECT DISTINCT ON (customer_id) eligible_collateral_value
                    FROM risk_snapshots ORDER BY customer_id, computed_at DESC
                ) s),0)::text AS total_collateral
           FROM customers c LEFT JOIN credit_facilities f ON f.customer_id = c.id`,
      ),
      query<{ state: string; count: string }>(
        ctx.pool,
        `SELECT state::text, COUNT(*)::text AS count FROM (
           SELECT DISTINCT ON (customer_id) customer_id, state
             FROM risk_snapshots ORDER BY customer_id, computed_at DESC
         ) s GROUP BY state`,
      ),
      queryOne<{ count: string; volume: string; points: string }>(
        ctx.pool,
        `SELECT COUNT(*)::text AS count,
                COALESCE(SUM(billing_amount),0)::text AS volume,
                COALESCE(SUM(points_earned),0)::text AS points
           FROM transactions WHERE settled_at > now() - interval '30 days'`,
      ),
      queryOne<{ total: string; declined: string; avg_latency: string }>(
        ctx.pool,
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE NOT approved)::text AS declined,
                COALESCE(AVG(latency_ms),0)::text AS avg_latency
           FROM authorizations WHERE decided_at > now() - interval '30 days'`,
      ),
    ]);

    const totalAuth = Number(fraud?.total ?? '0');
    const declined = Number(fraud?.declined ?? '0');

    return reply.send({
      portfolio: {
        customers: Number(portfolio?.customers ?? '0'),
        fundedCustomers: Number(portfolio?.funded ?? '0'),
        totalCreditLimit: money(portfolio?.total_limit ?? '0').toFixedString(),
        totalOutstanding: money(portfolio?.total_balance ?? '0').toFixedString(),
        totalEligibleCollateral: money(portfolio?.total_collateral ?? '0').toFixedString(),
        portfolioLtv: money(portfolio?.total_collateral ?? '0').isPositive()
          ? money(portfolio?.total_balance ?? '0').amount
              .dividedBy(money(portfolio?.total_collateral ?? '1').amount)
              .times(100).toDecimalPlaces(2).toFixed()
          : '0.00',
      },
      riskDistribution: Object.fromEntries(states.map((s) => [s.state, Number(s.count)])),
      payments: {
        transactions30d: Number(spend?.count ?? '0'),
        volume30d: money(spend?.volume ?? '0').toFixedString(),
        pointsIssued30d: D(spend?.points ?? '0').toFixed(0),
        authorizations30d: totalAuth,
        approvalRate: totalAuth > 0
          ? (((totalAuth - declined) / totalAuth) * 100).toFixed(2) : '100.00',
        avgAuthLatencyMs: Number(fraud?.avg_latency ?? '0').toFixed(1),
      },
    });
  });
};
