# Architecture

## The shape of it

```
                      Customer app            Operations console
                            │                          │
                            └────────── HTTP ──────────┘
                                        │
                              ┌─────────▼─────────┐
                              │   Fastify API     │
                              │  auth · routes    │
                              └─────────┬─────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
              ┌─────▼─────┐      ┌──────▼──────┐     ┌──────▼──────┐
              │  Services │      │   Workers   │     │ Partner     │
              │ (I/O)     │      │ market·risk │     │ ports       │
              └─────┬─────┘      │   ·daily    │     └──────┬──────┘
                    │            └──────┬──────┘            │
                    └───────────────────┤            ┌──────▼──────┐
                                        │            │ KYC issuer  │
                              ┌─────────▼─────────┐  │ custody     │
                              │  @wealthcard/core │  │ market data │
                              │                   │  │ stablecoin  │
                              │  valuation        │  │ lender      │
                              │  collateral       │  └─────────────┘
                              │  credit           │
                              │  risk             │  ┌─────────────┐
                              │  liquidation      │  │  Postgres   │
                              │  ledger           │  │             │
                              │  fraud · rewards  │  │  ledger is  │
                              │  authorization    │  │  the record │
                              │  agent            │  └─────────────┘
                              │                   │
                              │  pure functions   │
                              └───────────────────┘
```

## Why the core has no I/O

Every engine in `packages/core` takes its inputs, its policy and its clock as
arguments and returns a value. It opens no connections, reads no environment
and calls no `Date.now()`.

PRD §12.3 requires production risk rules to be deterministic, testable and
governed. A function that reaches out to a database mid-computation cannot be
replayed during an audit, because the database has moved on. Keeping the core
pure means any past decision can be reproduced exactly: take the inputs from the
audit record, take the policy version stamped on the decision, run the function,
get the same answer. That property is the whole reason for the constraint.

It also means the engines are cheap to test. The 169 core tests run in
milliseconds against no infrastructure.

## One ordering, in one place

`services/orchestrator.ts` holds the only revaluation path:

```
custody balances → prices → collateral → credit decision
                                       → risk snapshot → alerts
                                                       → liquidation plan
```

Every entry point that could change a customer's position calls it — pledging
collateral, settling a transaction, a repayment, the risk tick, an operator's
manual revaluation. Two callers with slightly different orderings is how a
platform ends up with a credit limit computed from one set of prices and a risk
state computed from another.

Pricing and collateral are computed *outside* the transaction, because they are
the slow part (three feeds over the network) and take no locks. The write —
repricing, the snapshot, alerts, any liquidation plan — happens inside one
transaction under a facility row lock.

## Concurrency

The authorization path is the only one with a latency budget, and the only one
where two requests routinely race.

Every balance-changing path takes `SELECT ... FOR UPDATE` on the customer's
facility row, in that order, before reading anything it will act on. Without it
two taps arriving together would both read the same available credit and both
approve, putting the customer over their limit through no act of their own.
There is an integration test that fires eight simultaneous charges, each a fifth
of the line, and asserts that no more than five are approved.

Authorization itself does no I/O beyond that transaction: it reads the *last*
risk snapshot rather than recomputing collateral, because a card tap cannot wait
on three price feeds. The risk loop exists to keep that snapshot current.

## Idempotency

Three layers, because three different things retry:

- **Card networks** retry authorizations. A repeated `requestId` returns the
  original decision verbatim rather than re-running the pipeline, which could
  decide differently as prices move.
- **Processors** resend settlement webhooks. Every journal entry carries an
  idempotency key with a unique index behind it, so a duplicate settlement
  posts nothing and reports `duplicate: true`.
- **Customers** double-tap pay buttons. Repayments are keyed on a
  caller-supplied idempotency key.

The same discipline applies to partner calls. A replayed collateral sale is
unrecoverable, so `custody.liquidate` is keyed on the liquidation and symbol.

## Failure behaviour

The system degrades toward *less* credit, never more.

| What fails | What happens |
|---|---|
| One price feed | Dropped; the consolidator takes the median of the rest. |
| Too few feeds agree | Price marked `disputed`; that collateral is suspended. |
| All feeds stale | Price marked `stale`; collateral suspended, customer alerted. |
| No price at all | Asset excluded from collateral entirely. |
| Ownership verification expires | Collateral suspended until the account reconnects. |
| Stablecoin depegs | Extra haircut, or full exclusion past a severe threshold. |
| No risk snapshot | Authorizations decline. We do not assume an account is healthy. |
| Language model down or wrong | Deterministic answer ships instead. |
| Custodian unreachable | Liquidation fails loudly; the plan stays `executing` for operations. |

## Money

Money and asset quantities never touch a JS number. They are `Decimal`
internally and strings at every boundary — database, HTTP, logs. `NUMERIC(38,18)`
columns hold them, and `pg` is explicitly configured to return numerics as
strings so a future dependency cannot quietly turn them into floats.

Rounding has a direction. Credit we grant rounds down; debt we collect rounds
up; everything else uses banker's rounding, because half-up across millions of
postings introduces a systematic upward bias.

## Background workers

Three loops, each re-armed with `setTimeout` after the work finishes rather than
running on `setInterval` — an interval stacks overlapping runs the moment one
tick runs long, which under load is exactly when it hurts most.

- **market** advances the sandbox simulator
- **risk** revalues every live customer, driving the alert and margin-call path
- **daily** accrues interest, bills membership fees on their anniversary, and
  releases authorization holds past their TTL

The daily loop runs hourly but every posting is keyed by calendar day, so it
lands exactly once regardless of how often it runs.

## Data model notes

Two things are worth knowing about the schema.

**Balances are a view, not a column that code assigns to.** The
`account_balances` view sums postings. `syncFacilityFromLedger` recomputes a
facility's denormalised balances from those postings rather than incrementing
them, so the facility can never drift from the ledger. The reconciler compares
the two every run and reports any disagreement as a break.

**"Latest row" queries carry a deterministic tiebreaker.** Ordering by timestamp
alone resolves ties arbitrarily, and two rows sharing a timestamp is not
hypothetical: a collateral change triggers a repricing, and the risk tick can
reprice the same customer in the same millisecond. `risk_snapshots` orders by
`id` as well, and `credit_decisions` carries a sequence column for the purpose.
