/** POST /ai/query — the AI financial assistant (PRD §16, §21). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Jurisdiction } from '@wealthcard/core';
import { requireCustomer } from '../auth.js';
import { query } from '../db.js';
import { notFound } from '../errors.js';
import { parse } from './helpers.js';
import type { AppContext } from '../context.js';
import { ask } from '../services/agent.js';
import { findFacility, loadCustomer } from '../services/credit.js';
import { computeWealth } from '../services/wealth.js';
import { previousSnapshot } from '../services/risk.js';

export const registerAiRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  app.post('/v1/ai/query', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const body = parse(z.object({
      question: z.string().min(2).max(500),
    }), req.body);

    const customer = await loadCustomer(ctx.pool, principal.customerId);
    const facility = await findFacility(ctx.pool, principal.customerId);
    if (!facility) throw notFound('Credit facility');
    const snapshot = await previousSnapshot(ctx.pool, principal.customerId);
    if (!snapshot) throw notFound('Risk snapshot');
    const wealth = await computeWealth(
      ctx, ctx.pool, principal.customerId, customer.jurisdiction as Jurisdiction,
    );

    const answer = await ask(ctx, ctx.pool, {
      customer, facility, risk: snapshot, collateral: wealth.collateral,
    }, body.question);

    return reply.send({
      interactionId: answer.interactionId,
      intent: answer.intent,
      answer: answer.text,
      disclaimers: answer.disclaimers,
      // PRD §16.3: every important financial value carries its timestamp
      // and source, so the customer can see where a number came from.
      sources: answer.citedFacts.map((f) => ({
        key: f.key, label: f.label, value: f.value, unit: f.unit,
        asOf: f.asOf.toISOString(), source: f.source,
      })),
      modelUsed: answer.modelUsed,
      groundingRejected: answer.groundingRejected,
      policyVersion: answer.policyVersion,
    });
  });

  /** The customer's own record of what they asked and what we answered. */
  app.get('/v1/ai/history', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const rows = await query<{
      id: string; question: string; intent: string; answer: string;
      model_used: boolean; grounding_rejected: boolean; created_at: Date;
    }>(
      ctx.pool,
      `SELECT id, question, intent, answer, model_used, grounding_rejected, created_at
         FROM ai_interactions WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [principal.customerId],
    );
    return reply.send({
      interactions: rows.map((r) => ({
        id: r.id, question: r.question, intent: r.intent, answer: r.answer,
        modelUsed: r.model_used, groundingRejected: r.grounding_rejected,
        createdAt: r.created_at.toISOString(),
      })),
    });
  });

  /** Suggested questions, tailored to the account's current state. */
  app.get('/v1/ai/suggestions', async (req, reply) => {
    const principal = requireCustomer(req.principal);
    const snapshot = await previousSnapshot(ctx.pool, principal.customerId);
    const base = [
      'How much can I safely spend?',
      'Explain my credit limit',
      'What is my collateral health?',
    ];
    if (!snapshot) return reply.send({ suggestions: base });

    const contextual: string[] = [];
    if (snapshot.state !== 'healthy') contextual.push('Why did my available credit change?');
    if (snapshot.topConcentration.gt(0.6)) contextual.push('Am I too concentrated in one asset?');
    if (snapshot.totalDebt.isPositive()) contextual.push('What are my repayment options?');
    contextual.push('What if bitcoin falls 50%?');

    return reply.send({ suggestions: [...contextual, ...base].slice(0, 6) });
  });
};
