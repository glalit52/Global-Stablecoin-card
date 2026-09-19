# @wealthcard/core

The domain core of the Global Wealth Card platform. Every engine here is a
**pure function**: it takes its inputs, its policy and its clock as arguments,
and returns a value. No I/O, no globals, no ambient `Date.now()`.

That constraint is not stylistic. PRD §12.3 requires production risk rules to
be deterministic, testable and governed; a function that reads a clock or a
database cannot be replayed during an audit, and a credit decision you cannot
replay is a credit decision you cannot defend.

## Modules

| Module | Responsibility | PRD |
|---|---|---|
| `money` | Exact decimal money. Floats are banned for value. | — |
| `policy` | Versioned, frozen risk parameters. Every threshold lives here. | §12.3, §22 |
| `valuation` | Multi-source price consolidation, staleness and dispersion. | §19.1 |
| `collateral` | Eligibility, dynamic haircuts, concentration caps. | §10 |
| `credit` | Underwriting and the dynamic limit framework. | §11 |
| `risk` | LTV ladder, health factor, stress testing. | §12 |
| `liquidation` | Trigger evaluation and orderly sale planning. | §12.3 |
| `ledger` | Double-entry journal, trial balance, reconciliation. | §28 |
| `fraud` | Explainable, deterministic authorization-time signals. | §17.2 |
| `rewards` | Earn, caps, redemption, tier benefits. | §15 |
| `authorization` | The real-time card decision pipeline. | §13, §21 |
| `agent` | Fact packs and the grounding guardrail for the AI agent. | §16 |

## Two design decisions worth knowing

**Each risk factor is priced exactly once.** The PRD's §10.1 collateral formula
and §11.2 credit formula both mention volatility, liquidity and concentration.
Applying both multiplicatively would double-count every one of them and drive
credit lines far below what the collateral supports. So the collateral engine
prices *per-asset* risk (haircut, depth, per-asset caps), and the credit
engine's terms price only *portfolio-level* effects the haircut cannot see:
behaviour under a specific adverse scenario, whole-book exit liquidity, and
concentration that no per-asset cap has already cut.

**The AI agent cannot invent a number.** The server builds a `FactPack` of
every value the agent may state, each with its own timestamp and source. A
deterministic explainer answers from that pack alone. A language model, when
configured, may only rephrase — and its output passes `groundingViolations`,
which extracts every number in the response and rejects any that is not in the
pack. The worst a misbehaving model can do is produce prose that gets thrown
away.

## Tests

```bash
pnpm vitest run packages/core
```
