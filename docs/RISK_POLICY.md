# Risk policy

Every threshold, haircut, cap and rate the platform applies is read from a
versioned policy object in `packages/core/src/policy.ts`. No engine hard-codes a
number. Every decision is stamped with the version that produced it, so a past
decision can be replayed against the rules of its day.

Policies are deep-frozen at registration, so a request handler cannot mutate one
at runtime. New versions are added, never edited in place, and activating one is
a dual-approved operator action.

> **These are not lending terms.** They are conservative engineering defaults
> chosen so the system behaves sensibly. PRD §10.2 is explicit that final LTVs,
> haircuts and eligibility must be established by the regulated lender, legal
> counsel and a risk committee.

## Collateral (PRD §10)

```
Eligible value = Market value
               × Eligibility factor
               × (1 − Haircut)
               × Liquidity adjustment
               × Concentration adjustment
```

### The haircut responds to the market

```
haircut = clamp(base + max(0, observed − expected) × multiplier, base, max)
```

Only volatility *above* the policy's expectation adds to the haircut. The base
haircut already prices the asset's normal volatility; without the `max(0, …)`
the two would double-count and BTC would sit permanently at its ceiling.

At BTC's default 55% volatility the haircut is its 30% base. At 95% realized
volatility it rises to 49%. Capped at 65%.

### Concentration is measured against the unadjusted total

An over-weight position contributes exactly `cap × total`, where the total is
the *pre-concentration* sum. A self-referential cap — measuring each position
against the post-adjustment total — drives a single-asset portfolio to zero
through repeated application: 0.8 → 0.64 → 0.51 → … → 0. Measuring against the
unadjusted base is stable and expresses the intent, which is "we will count at
most 80% of your collateral as bitcoin".

Stablecoin issuer caps bind across every symbol from the same issuer, so holding
USDC and a hypothetical second Circle token does not evade the limit.

### Ineligibility

A position is excluded, not merely discounted, when any of these hold:

| Reason | Why |
|---|---|
| Not pledged, or customer-excluded | We have no claim on it. |
| Asset class not enabled | ETH, equities and ETFs are V2 in this policy. |
| Not on the stablecoin whitelist | Issuer and reserve risk is unassessed. |
| Jurisdiction restricted | The programme does not permit it there. |
| Stale price | We cannot mark it, so we will not lend on it. |
| Disputed price | Feeds disagree beyond tolerance. |
| Verification expired | Ownership is no longer proven. |
| Custody model ineligible | Self-custody without a control signature; manual review. |
| Severe depeg | More than 10× the depeg threshold off par. |
| Below dust threshold | Not worth the servicing cost. |

Each one carries a customer-facing sentence, not just a code. A customer whose
collateral is suspended is owed an explanation they can act on.

## Credit (PRD §11)

```
Capacity = Base collateral capacity
         × Portfolio risk adjustment
         × Liquidity adjustment
         × Concentration adjustment
         × Customer adjustment
         − Existing exposure
```

The important design point: **each of those four terms prices something the
collateral haircut cannot see.** The PRD names volatility, liquidity and
concentration in both formulas, and applying both multiplicatively
double-counts them — it drove test credit lines to roughly half what the
collateral genuinely supported. So:

| Term | What it actually measures |
|---|---|
| Portfolio risk | How the *book as a whole* fares under a named adverse scenario, including correlation. 1.0 unless it retains less than the policy's expected share. |
| Liquidity | Whole-book exit, not per-asset depth. 1.0 unless weighted liquidity falls below the level we can reliably unwind in a stressed window. |
| Concentration | Only the diversification no per-asset cap has already cut. 1.0 when the collateral engine's cap has bound. |
| Customer | Behaviour: tenure, repayment record, delinquencies, fraud score. The only term that can exceed 1.0. |

The result is capped at the unadjusted base collateral capacity, so a perfect
payment history can never lend against collateral that is not there.

Limits round **down** to the tier's step. A credit line is never rounded up.

### The tier minimum is an origination floor, not a hard stop

If a live customer's collateral falls below what their tier requires at
origination, their limit is held at their drawn balance rather than zeroed.
Zeroing it would put a customer carrying a balance instantly over limit through
no act of their own; the LTV ladder governs that exposure instead.

## The risk ladder (PRD §11.3)

Measured as effective LTV — total exposure, including authorization holds,
against eligible collateral.

| State | LTV | What the customer experiences |
|---|---|---|
| Healthy | < 60% | Full spending. |
| Watch | ≥ 60% | Told early. Nothing restricted. |
| Restricted | ≥ 70% | New discretionary spend pauses. Essentials and recurring payments continue. |
| Remediation | ≥ 78% | Margin call. 24 hours to add collateral or repay. |
| Liquidation | ≥ 85% | Collateral may be sold to restore the account. |

Origination is at 50% LTV, so a fully drawn account sits comfortably inside the
first threshold and market movement, not the initial draw, is what advances it.

Holds count as exposure. Ignoring them would let a customer authorize their way
past the liquidation threshold before anything settled.

Non-LTV signals — degraded pricing, concentration above 90%, an operations
freeze, an open margin call — can only make the state *worse*, never better.

## Liquidation (PRD §12.3)

Planning and execution are separate. The plan is a deterministic artefact
operations can review before anything irreversible happens; execution requires
either an automated trigger that has cleared every gate, or a dual-approved
operator action.

**Two gates must both open.** The account must be at or past the contractual
liquidation LTV, *and* either the cure window from its margin call has expired
or the account has blown so far through the threshold that waiting is itself the
risk. That hard floor sits at 100% LTV: once collateral no longer covers the
debt at all, waiting converts a customer loss into an unsecured credit loss.

**The sale is sized, not total.** Selling market value `m` yields `m × r` net
(r = 1 − slippage − fee) and removes `m × k` of eligible collateral. To land on
the target:

```
m = (D − target × C) / (r − target × k)
```

Over-liquidation is itself a harm — the customer loses upside they did not need
to lose — so the engine solves for the amount that restores the target LTV and
stops there.

**Order is configurable.** `lowest_cost` sells the cheapest and deepest books
first, minimising realised cost but leaving the surviving book more volatile.
`de_risk` sells the riskiest first, costing more but meaning fewer repeat
liquidations. `pro_rata` preserves the customer's allocation.

## Fraud (PRD §17.2)

Additive, transparent rules. No model inference on the authorization path:
PRD §19.2 requires production rules and experimental models to stay separate,
and an authorization has a few hundred milliseconds it cannot spend waiting.

Every signal that fires records its weight and a sentence explaining itself,
because a declined customer is owed a reason and a disputed chargeback needs
evidence of what the system saw at the time.

Impossible travel is only evaluated for card-present transactions — an
e-commerce purchase can legitimately be billed from anywhere. A recurring charge
is never declined on signals alone; the customer already pays that merchant.

## Rewards (PRD §15)

Points are a real liability the moment they are earned, booked to the ledger as
an expense and a liability at accrual cost.

**Every bonus category carries a monthly cap, and policy validation rejects one
that does not.** An uncapped 5× multiplier at a cent a point is a 5% rebate
funded by roughly 1.85% interchange — it loses money on every transaction, and
the worst case is unbounded. Base rates sit at 1× for the same reason: a 1.5×
base alone consumed 91% of interchange.

The cap also means the effective rate *falls* as spend grows, which is the right
shape: the more a customer spends, the closer their blended rate moves to base.

A test asserts every tier stays margin-positive on a realistic month of spend,
counting interchange plus the amortised annual fee against accrued rewards.

## Stress testing (PRD §12.2)

Seven scenarios ship in the MVP policy: BTC drawdowns at 30/50/70%, a stablecoin
depeg to $0.90, a correlated crash with liquidity stress, an order-book
deterioration, and an equity drawdown. A depeg is modelled as a price *level*
rather than a percentage move, because that is what a depeg is.

"Survives" means the scenario does not force a margin call — not merely that it
avoids liquidation.

## Changing the policy

1. Add a new version to the registry. Never edit a released one.
2. `validatePolicy` must return no errors. It checks the threshold ladder is
   monotonic, that the liquidation target can actually cure a margin call, that
   haircuts and factors are within [0,1], that every whitelisted stablecoin has
   a mapped issuer, that no jurisdiction permits an unlisted stablecoin, that
   the fraud step-up threshold sits below the decline threshold, and that no
   bonus category is uncapped.
3. File a `policy.activate` approval request.
4. A second operator approves. The activation is recorded in
   `policy_activations` with who, when and why.
