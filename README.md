# Global Wealth Card

An asset-backed credit card platform. Customers pledge verified wealth — bitcoin
and regulated stablecoins in this version — receive a dynamically calculated
credit line against it, and spend through an ordinary Visa card. The merchant is
paid in local currency. The customer keeps their assets.

> **Spend without selling your wealth.**

This repository implements the product described in
[`docs/PRD.md`](docs/PRD.md): the wealth graph, the collateral and credit
engines, the risk ladder and liquidation path, a double-entry ledger, rewards,
an AI assistant that cannot invent a number, a customer app and an operations
console. Every regulated function sits behind a port with a sandbox
implementation, so the whole platform runs end to end on one machine.

## Run it

```bash
# Postgres 16 on localhost. Any 14+ server works.
createdb wealthcard && createdb wealthcard_test

pnpm install
pnpm bootstrap          # migrate, then seed three demo customers
pnpm start:api          # http://localhost:4000
pnpm dev:web            # http://localhost:5173
```

Sign in as `ana@example.com`, `devi@example.com` or `marcus@example.com`, or as
an operator at `risk@wealthcard.example`. The password for every seeded account
is `wealth-demo-2026!`.

```bash
pnpm demo               # a narrated walkthrough of the entire product
pnpm simulate           # continuous merchant traffic against the running API
pnpm test               # 209 tests
```

To watch the risk engine work, crash the market and see what happens:

```bash
curl -X POST localhost:4000/v1/market/scenario \
  -H 'content-type: application/json' \
  -d '{"symbol":"BTC","changePercent":"-55"}'
```

## Shape of the code

| Path | What lives there |
|---|---|
| `packages/core` | The domain. Pure functions, no I/O, no ambient clock. |
| `packages/adapters` | Ports for every regulated partner, plus sandbox implementations. |
| `apps/api` | Fastify service: auth, the PRD's endpoint surface, background workers. |
| `apps/web` | Customer app and operations console. |
| `apps/simulator` | Merchant and market traffic generator. |
| `db/migrations` | Schema. Money is `NUMERIC`, decisions carry their policy version. |
| `docs` | Architecture, risk policy, API reference, compliance posture. |

## Five decisions that shaped this

**The domain core does no I/O.** Every engine takes its inputs, its policy and
its clock as arguments. That is not a style preference: PRD §12.3 requires
production risk rules to be deterministic, testable and governed, and a function
that reads a clock or a database cannot be replayed during an audit. A credit
decision you cannot replay is a credit decision you cannot defend.

**Each risk factor is priced exactly once.** The PRD names volatility, liquidity
and concentration in both the §10 collateral formula and the §11 credit formula.
Applying both multiplicatively double-counts every one of them and drives credit
lines far below what the collateral supports. The collateral engine prices
per-asset risk; the credit engine prices only portfolio-level effects the
haircut cannot see — behaviour under a specific adverse scenario, whole-book
exit liquidity, and concentration no per-asset cap has already cut.

**Balances are derived, never assigned.** There is no `UPDATE ... SET balance =
balance + x` anywhere. Every movement of value is a journal entry whose debits
equal its credits, and a facility's balances are recomputed from the postings.
An incrementing balance drifts the moment one path forgets to call it;
recomputing from the ledger cannot drift, because the ledger *is* the record.

**The AI cannot invent a number.** The server computes a fact pack — every value
the agent may state, each with its own timestamp and source. A deterministic
explainer answers from that pack alone, and that is the production path. A
language model, where configured, may only rephrase, and its draft is checked
number by number against the pack before anyone sees it. The deterministic
answer is checked too. So a model outage, a hallucination and a prompt injection
in a merchant name all have the same blast radius: slightly less fluent prose.

**Rewards have to pay for themselves.** An uncapped 5× multiplier at a cent a
point is a 5% rebate funded by 1.85% interchange — it loses money on every
transaction. Every bonus category carries a monthly cap, policy validation
rejects one that does not, and a test asserts each tier stays margin-positive on
a realistic month of spend.

## What this is not

The regulated functions are real interfaces with sandbox implementations behind
them. There is no card network, no licensed lender, no custodian and no KYC
vendor connected. PRD §32 lists what a controlled launch additionally requires —
legal structure, contracted partners, penetration testing, approved customer
disclosures — and none of that is software.

The risk parameters in `packages/core/src/policy.ts` are conservative
engineering defaults chosen to make the system behave sensibly. They are not
lending terms. PRD §10.2 is explicit that final LTVs, haircuts and eligibility
must be set by the regulated lender, legal counsel and a risk committee.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — services, data flow, concurrency, failure behaviour
- [Risk policy](docs/RISK_POLICY.md) — how collateral, credit, risk and liquidation are computed
- [API](docs/API.md) — every endpoint, with examples
- [Compliance](docs/COMPLIANCE.md) — regulated functions, controls, and what is still missing
- [Deployment](docs/DEPLOYMENT.md) — what goes where, and why the API needs a persistent process
