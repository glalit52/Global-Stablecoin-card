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

1. **supabase.com** → project **wealthcard** → **SQL Editor**
2. Paste and **Run**:

```sql
SELECT format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY;', schemaname, tablename)
FROM pg_tables WHERE schemaname = 'public';
```

3. It prints a list of commands. Copy them all into a new query and **Run**.

Nothing breaks: this app connects directly as `postgres`, which is not subject
to these rules. It only shuts the public door.

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
