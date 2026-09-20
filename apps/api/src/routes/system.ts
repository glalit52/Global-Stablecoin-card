/** Health, market snapshot and scenario control for demos and tests. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getActivePolicyVersion, getPolicy } from '@wealthcard/core';
import { query, queryOne } from '../db.js';
import { parse } from './helpers.js';
import type { AppContext } from '../context.js';
import { refreshCustomer } from '../services/orchestrator.js';

export const registerSystemRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  app.get('/health', async (_req, reply) => {
    const started = Date.now();
    let database = 'down';
    try {
      await queryOne(ctx.pool, 'SELECT 1 AS ok');
      database = 'up';
    } catch { /* reported as down */ }

    const healthy = database === 'up';
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      database,
      policyVersion: getActivePolicyVersion(),
      partners: {
        kyc: ctx.partners.kyc.name,
        issuer: ctx.partners.issuer.name,
        custody: ctx.partners.custody.name,
        marketData: ctx.partners.marketData.map((m) => m.name),
        stablecoin: ctx.partners.stablecoin.name,
        lender: ctx.partners.lender.name,
      },
      aiModelConfigured: ctx.config.anthropicApiKey !== null,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    });
  });

  /** The live risk policy, so the UI can render real thresholds. */
  app.get('/v1/policy', async (_req, reply) => {
    const policy = getPolicy();
    return reply.send({
      version: policy.version,
      description: policy.description,
      facilityCurrency: policy.facilityCurrency,
      thresholds: policy.thresholds,
      tiers: policy.tiers,
      stablecoins: { whitelist: policy.stablecoins.whitelist, depegThreshold: policy.stablecoins.depegThreshold },
      stressScenarios: policy.stressScenarios,
    });
  });

  app.get('/v1/market', async (_req, reply) => {
    return reply.send({
      prices: ctx.market.snapshot(),
      fx: Object.fromEntries([...ctx.market.fxRates()].map(([k, v]) => [k, v.toFixed()])),
      asOf: new Date().toISOString(),
    });
  });

  /**
   * Scenario control. Drives a price move and revalues every customer, so the
   * full chain — price, collateral, limit, risk state, alert, liquidation plan
   * — can be exercised in one call.
   *
   * Registered only where sandbox endpoints are enabled. Moving the market is
   * a way to manufacture credit for every customer at once, so it is off in
   * production unless ENABLE_SANDBOX_ENDPOINTS is set deliberately.
   */
  if (!ctx.config.sandboxEndpoints) return;

  app.post('/v1/market/scenario', async (req, reply) => {
    const body = parse(z.object({
      symbol: z.string().min(2).max(10),
      changePercent: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
      price: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    }), req.body);

    if (!body.changePercent && !body.price) {
      return reply.code(400).send({
        error: { code: 'missing_move', message: 'Supply either changePercent or price' },
      });
    }

    const newPrice = body.price
      ? (ctx.market.setPrice(body.symbol, body.price), ctx.market.priceOf(body.symbol)!)
      : ctx.market.shock(body.symbol, String(Number(body.changePercent) / 100));

    const customers = await query<{ id: string }>(
      ctx.pool, `SELECT id FROM customers WHERE status IN ('active','restricted')`,
    );

    const results: { customerId: string; state: string; health: string; liquidation: string | null }[] = [];
    for (const c of customers) {
      const refreshed = await refreshCustomer(ctx, ctx.pool, c.id);
      results.push({
        customerId: c.id,
        state: refreshed.evaluation.snapshot.state,
        health: refreshed.evaluation.snapshot.healthPercent.toFixed(1),
        liquidation: refreshed.liquidation?.liquidationId ?? null,
      });
    }

    return reply.send({
      symbol: body.symbol.toUpperCase(),
      newPrice: newPrice.toDecimalPlaces(2).toFixed(),
      customersRevalued: results.length,
      results,
    });
  });
};
