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


## The stack this repository is set up for

| Piece | Where | Cost |
|---|---|---|
| Web app | Vercel | Free tier |
| API | AWS App Runner | ~$5–25/month |
| Database | Supabase Postgres | Free tier |

### 1. Database — Supabase

A project named `wealthcard` already exists in the connected organisation with
the full schema applied (32 tables plus `schema_migrations`, which is recorded
as `001_init` so the app's own migrator treats it as done).

Get the connection string from **Project Settings → Database → Connection
string → URI**, and reset the password there if you do not have it — the
password is set at creation and shown only once.

Use the **session pooler** connection (port 5432, host
`aws-0-<region>.pooler.supabase.com`) rather than the direct one. App Runner
scales to several instances and each keeps a connection pool; the direct
endpoint has a low connection ceiling.

> **Row Level Security is disabled on every table, and that must be resolved
> before this holds real data.** Supabase exposes tables through PostgREST to
> anyone holding the project's anon key, which is public by design. With RLS
> off, that key can read `customers` (password hashes), `sessions` (token
> hashes) and the entire ledger.
>
> This application never uses PostgREST — it connects directly as the `postgres`
> role, which bypasses RLS. So enabling RLS with **no policies at all** closes
> the hole completely and changes nothing about how the app works:
>
> ```sql
> ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
> -- ...and every other table in the public schema.
> ```
>
> The full statement list is in the Supabase advisor output, or run:
> `SELECT format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY;', schemaname, tablename)
>  FROM pg_tables WHERE schemaname = 'public';`

### 2. API — AWS App Runner

`apprunner.yaml` configures a source-based deployment: App Runner clones the
repository, builds on its managed Node 22 runtime, and keeps the process alive.
No ECR, no Dockerfile, no cluster.

**Console → App Runner → Create service**

| Step | Value |
|---|---|
| Source | Source code repository → connect GitHub → this repo, branch `main` |
| Deployment trigger | Automatic |
| Configuration file | Use a configuration file (`apprunner.yaml`) |
| Port | 4000 (from the config) |
| Health check | HTTP, path `/health` |
| CPU / memory | 0.25 vCPU / 0.5 GB is enough to start |

Then add environment variables in the console — not in `apprunner.yaml`, which
is in version control:

| Name | Value |
|---|---|
| `DATABASE_URL` | The Supabase pooler URI |
| `CORS_ORIGINS` | Your Vercel domain, e.g. `https://wealthcard.vercel.app` |

App Runner gives you a URL like
`https://xxxx.us-east-1.awsapprunner.com`. Confirm it with `GET /health`.

Prefer containers or already on ECS? The `Dockerfile` builds the same thing and
runs anywhere. App Runner can also deploy from an ECR image instead of source.

### 3. Web app — Vercel

Set `VITE_API_BASE_URL` to the App Runner URL **before** building — Vite inlines
it at build time — then follow the Vercel section below.

### 4. Seed, only if this is a demo

```bash
DATABASE_URL="<supabase uri>" pnpm db:seed
```

Creates three customers sharing a password published in this repository. Never
run it against anything real.

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

### Render, in one step

`render.yaml` is a blueprint: **New -> Blueprint** in the Render dashboard,
point it at this repository, and it provisions the API and a Postgres and wires
`DATABASE_URL` between them. Set `CORS_ORIGINS` to your front end's origin when
it asks — it is the one value the blueprint leaves blank, because only you know
it.

### Anywhere else

`Dockerfile` builds an image that runs on Railway, Fly, ECS or any container
host. It compiles the workspace, drops devDependencies, runs as a non-root
user, and starts with:

```
node apps/api/dist/migrate.js && node apps/api/dist/main.js
```

Migrations are idempotent, so running them on every boot is safe and keeps a
redeploy and a schema change as one step. Nothing in the runtime layer needs a
TypeScript loader — the migration runner compiles to `dist` alongside the
server.

> The image itself was not built where this was written: the sandbox blocks
> Docker Hub. The compiled migration runner and the exact start command were
> each verified directly on Node 22; the layer mechanics were not.

### Environment

A persistent host, a managed Postgres, and these environment variables:

```
DATABASE_URL=postgres://user:pass@host:5432/wealthcard
CORS_ORIGINS=https://your-web-app.vercel.app
PORT=4000
NODE_ENV=production
RISK_TICK_SECONDS=20
MARKET_TICK_SECONDS=10
ENABLE_SANDBOX_ENDPOINTS=false
```

Health check: `GET /health` returns 200 with `"database": "up"`.

### The sandbox switch

Two endpoints exist only to make demos possible, and either is a way to
manufacture credit:

- `POST /v1/market/scenario` moves the market for **every** customer at once.
- `POST /v1/admin/demo/seed-assets` asserts holdings a customer does not have.

Both are off whenever `NODE_ENV=production`, unless `ENABLE_SANDBOX_ENDPOINTS`
is set to `true` deliberately. Under production settings the scenario route is
not registered at all and returns 404 — verified, not assumed.

Turn them on only for a demo deployment, and note that a demo deployment is
also the only place `pnpm db:seed` belongs: it creates three customers sharing
a password published in this repository. Never run the seed against anything
real.

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
