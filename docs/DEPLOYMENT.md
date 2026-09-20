# Deployment

## Read this first: what can and cannot go on Vercel

The web app deploys to Vercel cleanly. **The API does not, as built** — and the
reason is structural rather than a configuration problem.

`apps/api` is a long-running process. Three things depend on that:

1. **Background workers.** `startWorkers` runs three `setTimeout` loops — the
   market tick, the risk tick, and daily accrual. On serverless the process
   ends when the request does, so none of them ever run.
2. **The risk tick is not optional.** Card authorization reads the *last* risk
   snapshot rather than recomputing collateral, because a card tap cannot wait
   on three price feeds. With no worker producing snapshots, authorization
   fails closed with `no_risk_snapshot` — which is the correct behaviour, and
   means a serverless deployment authorizes nothing.
3. **The sandbox adapters hold state in memory.** The market simulator, the
   custody balances and the idempotency stores are module-level singletons.
   Every cold start resets the market to its seed and forgets which
   authorizations it has already seen.

So: put the web app on Vercel and the API on something that runs a process.

| Piece | Where | Why |
|---|---|---|
| `apps/web` | Vercel, Netlify, Cloudflare Pages | Static SPA, no server needed |
| `apps/api` | Render, Railway, Fly.io, any container host | Needs a persistent process |
| Postgres | Neon, Supabase, RDS, the host's managed offering | — |

## Deploying the web app to Vercel

**Project settings**

| Setting | Value |
|---|---|
| Root Directory | `.` — the repository root, *not* `apps/web` |
| Node.js Version | 22.x |
| Install / Build / Output | Leave blank; `vercel.json` sets them |

Root Directory is the one that catches people. `apps/web` has no lockfile of
its own, so installing from there fails. The repository root is where the pnpm
workspace lives, and `vercel.json` already points the build at the web package.

**Environment variable**

| Name | Value |
|---|---|
| `VITE_API_BASE_URL` | The API's public origin, e.g. `https://wealthcard-api.onrender.com` |

Vite inlines this **at build time**, so it must be set before the build runs —
adding it afterwards does nothing until you redeploy. Left unset, the bundle
falls back to `/api`, which only resolves through the dev proxy.

You will also need the API's `CORS_ORIGINS` to include your Vercel domain.

## When `pnpm install` exits with 1

A clean `pnpm install --frozen-lockfile` from the repository root succeeds, so
a failure on Vercel is nearly always one of these:

| Cause | Symptom in the log | Fix |
|---|---|---|
| Root Directory set to `apps/web` | `ERR_PNPM_NO_LOCKFILE` | Set it to `.` |
| Node version mismatch | `Found invalid Node.js Version` | Set 22.x; `engines` and `.nvmrc` both say 22 |
| Lockfile behind `package.json` | `ERR_PNPM_OUTDATED_LOCKFILE` | Run `pnpm install` locally and commit `pnpm-lock.yaml` |
| Corepack signature error | `Cannot find matching keyid` | Upgrade the project's Node version, or remove `packageManager` from `package.json` |

The failing line is usually the one immediately above `ELIFECYCLE`, not the
last line of output.

## Deploying the API

A persistent host, a managed Postgres, and these environment variables:

```
DATABASE_URL=postgres://user:pass@host:5432/wealthcard
CORS_ORIGINS=https://your-web-app.vercel.app
PORT=4000
NODE_ENV=production
RISK_TICK_SECONDS=20
MARKET_TICK_SECONDS=10
```

```bash
pnpm install --frozen-lockfile
pnpm db:migrate            # never db:reset against a real database
pnpm start:api
```

Health check: `GET /health` returns 200 with `"database": "up"`.

Two things to change before this faces anyone real:

- **Seed data is demo data.** `pnpm db:seed` creates three customers with a
  shared, published password. Never run it against anything public.
- **The sandbox endpoints must go.** `POST /v1/market/scenario` moves the
  market for every customer, and `POST /v1/admin/demo/seed-assets` asserts
  holdings a customer does not have. The latter already refuses to run outside
  a sandbox custody provider; the former does not, and should be gated the same
  way before any real deployment.

## Putting the API on Vercel anyway

Possible, but it is a porting job, not a config change:

1. **Workers → Vercel Cron.** Expose the risk tick and daily accrual as
   authenticated routes and schedule them. Cron's minimum granularity is one
   minute, so risk snapshots would be up to a minute stale — acceptable for a
   demo, not for a product that liquidates collateral.
2. **In-memory adapters → the database.** The market simulator, custody
   balances and idempotency stores all need persisting, or replacing with real
   partner integrations.
3. **Connection pooling.** Serverless invocations exhaust Postgres connections
   quickly. Use a pooler such as Neon's or PgBouncer in transaction mode.

Given the product liquidates collateral on a clock, a persistent process is the
right answer; the porting job above buys nothing except staying on one host.
