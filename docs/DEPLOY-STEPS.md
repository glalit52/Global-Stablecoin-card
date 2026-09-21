# Deploy, step by step

A click-by-click guide. No terminal needed except where noted.
For the reasoning behind these choices, see [DEPLOYMENT.md](DEPLOYMENT.md).

**Before you start:** the code is on branch `claude/zen-brahmagupta-a9hwwv`,
not `main`. You will need to select it twice below.

**Order matters.** Each step needs the one before it.

---

## Step 1 — Lock the database (2 min)

Supabase leaves every table readable by anyone holding the project's public
key. Until this is done, that includes password hashes and session tokens.

1. **supabase.com** → project **wealthcard** → **SQL Editor** → **New query**
2. Paste **all** of the following and click **Run**

```sql
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.step_up_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.margin_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liquidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liquidation_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repayments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lounge_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policy_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;

-- The ledger view runs with its creator's privileges, so it would still be
-- readable through the public API even with the tables locked.
ALTER VIEW public.account_balances SET (security_invoker = true);
```

3. Confirm it worked: **Database** → **Tables**. Every table should now show an
   **RLS enabled** badge. Or run this — it should return **no rows**:

```sql
SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND NOT rowsecurity;
```

Nothing breaks. This app connects directly as `postgres`, which is not subject
to these rules — the change only shuts the public door. There are deliberately
no policies: the API is the only thing that should ever read these tables.

---

## Step 2 — Get the database address (2 min)

1. Same project → **Settings** → **Database**
2. **Database password** → **Reset password** → save it somewhere
3. Scroll to **Connection string** → **Session pooler** tab → copy the URL
4. Replace `[YOUR-PASSWORD]` in it with the password from step 2

Keep that line. It is your `DATABASE_URL`.

> Use the **session pooler**, not the direct connection. Several API instances
> each hold a pool of connections, and the direct endpoint runs out.

---

## Step 3 — Put the API on AWS App Runner (15 min)

1. **AWS Console** → search **App Runner** → **Create service**
2. **Source:** "Source code repository" → connect GitHub → repository
   `Global-Stablecoin-card` → branch `claude/zen-brahmagupta-a9hwwv`
3. **Deployment trigger:** Automatic
4. **Configuration:** choose **"Use a configuration file"**
   — this reads `apprunner.yaml`, which is already in the repository
5. **Service name:** `wealthcard-api`
6. **Environment variables:**

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the line from Step 2 |
   | `CORS_ORIGINS` | `http://localhost:5173` for now |

7. **Health check:** Protocol `HTTP`, Path `/health`
8. **Create & deploy**, then wait about ten minutes

When it goes green, copy the **Default domain** — something like
`https://abc123.us-east-1.awsapprunner.com`.

**Check it worked:** open that address with `/health` on the end. You should
see `"status":"ok"`. If you do, the backend is live.

> This is the only part that costs money: roughly $5–25 a month.

---

## Step 4 — Put the website on Vercel (5 min)

1. **vercel.com** → **Add New** → **Project** → import `Global-Stablecoin-card`
2. **Root Directory:** leave as `./`
   — setting this to `apps/web` is what makes the install fail
3. **Environment Variables:**

   | Name | Value |
   |---|---|
   | `VITE_API_BASE_URL` | your App Runner address from Step 3 |

4. **Deploy**

> This variable is baked in when the site is built, so it must be set *before*
> you deploy. Adding it afterwards does nothing until you redeploy.

---

## Step 5 — Introduce them to each other (2 min)

1. Copy your Vercel address, e.g. `https://wealthcard.vercel.app`
2. **AWS App Runner** → your service → **Configuration** → **Edit**
3. Change `CORS_ORIGINS` to that Vercel address
4. **Save.** It redeploys itself.

Without this the browser refuses to talk to the API, and the site looks broken
with no visible error.

---

## Step 6 — Demo data (optional)

Only for a demo. This creates three customers who share a password published in
this repository, so never run it against anything real.

```bash
DATABASE_URL="<your line from Step 2>" pnpm db:seed
```

---

## If something fails

| Where | Symptom | Usually |
|---|---|---|
| Vercel | `pnpm install exited with 1` | Root Directory is not `./` |
| App Runner | Build fails | Wrong branch, or "Use a configuration file" not selected |
| App Runner | Deploys, health check fails | `DATABASE_URL` wrong, or using the direct connection instead of the pooler |
| Website | Loads but nothing works | `CORS_ORIGINS` does not exactly match the Vercel address |
| Website | Loads but shows no data | `VITE_API_BASE_URL` was set after the build — redeploy |
