/** Fastify application assembly. Exported separately from main so tests can
 *  build a server without binding a port. */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  createSandboxRegistry, sharedMarket,
  type CustodyHydrator, type MarketSimulator,
} from '@wealthcard/adapters';
import type pg from 'pg';
import { loadConfig, type Config } from './config.js';
import { createPool, query } from './db.js';
import { resolveSession } from './auth.js';
import { AppError } from './errors.js';
import { sendError } from './routes/helpers.js';
import type { AppContext } from './context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerCardRoutes } from './routes/cards.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerSystemRoutes } from './routes/system.js';
import { startWorkers, type Workers } from './workers.js';

export interface BuiltServer {
  app: FastifyInstance;
  ctx: AppContext;
  pool: pg.Pool;
  workers: Workers | null;
  close: () => Promise<void>;
}

export interface BuildOptions {
  readonly config?: Partial<Config>;
  readonly market?: MarketSimulator;
  readonly startWorkers?: boolean;
  readonly now?: () => Date;
}

/** Paths that must work without a session. */
const PUBLIC_PATHS = new Set([
  '/health', '/v1/policy', '/v1/market', '/v1/market/scenario',
  '/v1/auth/register', '/v1/auth/login', '/v1/operator/login',
  // The processor calls these with its own mTLS/webhook credentials in
  // production; in the sandbox they are open so the flow can be driven.
  '/v1/card/authorize', '/v1/card/settle',
]);

export const buildServer = async (options: BuildOptions = {}): Promise<BuiltServer> => {
  const config: Config = { ...loadConfig(), ...options.config };
  const pool = createPool(config.databaseUrl);
  const market = options.market ?? sharedMarket();

  // The sandbox custodian keeps balances in memory, so a freshly started
  // process knows nothing about accounts another process created. Rehydrating
  // from `assets` restores the property a real custodian has for free: its
  // books outlive any single service instance.
  const custodyHydrator: CustodyHydrator = async (custodyAccountId) =>
    query<{ symbol: string; asset_class: string; quantity: string; pledged: boolean }>(
      pool,
      `SELECT a.symbol, a.asset_class::text, a.quantity::text, a.pledged
         FROM assets a
         JOIN customers c ON c.id = a.customer_id
        WHERE c.custody_account_id = $1`,
      [custodyAccountId],
    ).then((rows) => rows.map((r) => ({
      symbol: r.symbol,
      assetClass: r.asset_class as never,
      quantity: r.quantity,
      pledged: r.pledged,
    })));

  const ctx: AppContext = {
    config,
    pool,
    partners: createSandboxRegistry(market, custodyHydrator),
    market,
    now: options.now ?? (() => new Date()),
  };

  const app = Fastify({
    logger: config.nodeEnv === 'test'
      ? false
      : { level: config.logLevel, transport: undefined },
    // Money arrives as decimal strings; nothing here should ever be so large
    // that a bigger body is legitimate.
    bodyLimit: 256 * 1024,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 600),
    timeWindow: '1 minute',
    // Rate limit per authenticated principal where we have one, so a shared
    // office IP does not throttle every customer behind it.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth ? `tok:${auth.slice(-24)}` : `ip:${req.ip}`;
    },
  });

  // --- Authentication --------------------------------------------------------
  app.addHook('onRequest', async (req, reply) => {
    req.principal = null;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        req.principal = await resolveSession(pool, header.slice(7));
      } catch (err) {
        req.log.error({ err }, 'session resolution failed');
      }
    }

    const path = req.routeOptions?.url ?? req.url.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(path) || req.method === 'OPTIONS') return;
    if (!req.principal) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'Authentication required' },
      });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return sendError(reply, err);
    // Fastify's own validation and rate-limit errors carry a statusCode.
    const status = (err as { statusCode?: number } | undefined)?.statusCode;
    if (status && status < 500) {
      return reply.code(status).send({
        error: {
          code: (err as { code?: string } | undefined)?.code ?? 'request_error',
          message: err instanceof Error ? err.message : 'Request could not be processed',
        },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'An unexpected error occurred' },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: { code: 'route_not_found', message: `No route for ${req.method} ${req.url}` },
    }));

  registerSystemRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  registerCardRoutes(app, ctx);
  registerAiRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  const workers = options.startWorkers === false
    ? null
    : startWorkers(ctx, { info: (o, m) => app.log.info(o as object, m), error: (o, m) => app.log.error(o as object, m) });

  return {
    app, ctx, pool, workers,
    close: async () => {
      workers?.stop();
      await app.close();
      await pool.end();
    },
  };
};
