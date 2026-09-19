# Compliance posture

This describes what the software does and, more importantly, what it does not.
PRD §18 sets out a partner-first operating model; this document maps that model
onto the code and states plainly what a controlled launch still requires.

## Regulated functions and where they live

The company owns the brand, the wealth graph, the engines, the AI and the
customer experience. Every regulated function sits behind a port in
`packages/adapters/src/ports.ts`, with a sandbox implementation behind it.

| Function | Port | Status |
|---|---|---|
| KYC, AML, sanctions screening | `KycProvider` | Sandbox |
| Card issuing and BIN sponsorship | `CardIssuer` | Sandbox |
| Card processing | `CardIssuer` + webhook endpoints | Sandbox |
| Crypto custody | `CustodyProvider` | Sandbox |
| Consumer lending | `LendingPartner` | Sandbox |
| Stablecoin settlement and Travel Rule screening | `StablecoinRail` | Sandbox |
| Market data | `MarketDataProvider` | Sandbox |
| Notifications | `Notifier` | Sandbox |

**No licensed partner is connected.** Nothing in this repository touches a card
network, moves real value, holds a real asset or screens a real person. The
ports exist so that connecting one is a new file rather than a refactor, which
is also the mitigation PRD §28 names for partner-dependency risk.

## Controls that are implemented

**Segregation of duties.** Five high-impact actions require two operators:
executing a liquidation, overriding a credit limit by hand, writing off a
facility, activating a risk policy, and closing a customer. The four-eyes rule
is enforced in the request handler *and* by a database CHECK constraint, so a
bug in one cannot bypass the other. Every role is checked per endpoint.

**Audit trail.** Every material action writes an append-only record with the
actor, the entity, the before and after state, and the policy version in force.
There is no UPDATE path against `audit_log` anywhere in the code. Risk decisions,
credit decisions, card actions, collateral movements, liquidations, approvals
and AI interactions all land there.

**Model governance.** Production risk rules are deterministic and versioned.
No model inference runs on the authorization path — PRD §19.2 requires that
separation, and an authorization has a latency budget it cannot spend waiting.
Every credit and risk decision carries the policy version that produced it, so
it can be replayed exactly.

**AI factuality.** The assistant may only state numbers the server computed and
disclosed. A deterministic explainer is the production path; a language model,
where configured, may only rephrase, and its output is checked number by number
against the fact pack before anyone sees it. The deterministic answer is checked
too, and any sentence that cannot be sourced is withheld. Every interaction is
stored with the exact fact pack it was allowed to draw on, and operations can
list every case where the check fired.

**Double-entry ledger.** Every movement of value is a balanced journal entry.
Balances are derived from postings, never assigned. Reconciliation compares the
ledger against the facility records and reports unbalanced entries, trial-balance
residuals, duplicate idempotency keys, facility mismatches and uncleared
suspense.

**Idempotency.** Payment and settlement operations are keyed, with unique
indexes behind them. A replayed authorization returns its original decision; a
duplicate settlement posts nothing; a repeated collateral sale cannot execute
twice.

**Customer transparency.** Collateral terms, the advance rate, every threshold
on the risk ladder, the haircut on each position, the reason any holding is not
counted, and the programme's own rewards economics are all shown in the app.
PRD §17.3 asks for clear custody disclosures, clear collateral terms, visible
available credit and a visible risk state; those are visible, not buried.

**Authentication.** Passwords are scrypt with per-user salts. Session tokens are
stored only as SHA-256 hashes, so a database leak yields hashes rather than
usable tokens. Every secret comparison is timing-safe. Sensitive actions require
a fresh Ed25519 signature over a server-issued, single-use challenge from a
registered device.

**Jurisdictional controls.** Asset eligibility, permitted stablecoins, credit
ceilings, income-verification requirements and whether automated liquidation is
permitted at all are per-jurisdiction policy, not code.

## What is not implemented

These are not gaps to be closed by more code. They are the conditions PRD §32
sets for a controlled launch.

- **Legal and regulatory structure.** No jurisdiction has been selected, no
  legal opinion obtained, and no lending, custody, issuing or stablecoin
  structure approved.
- **Licensed partners.** None contracted. Every adapter is a simulation.
- **Customer disclosures.** No credit agreement, collateral agreement, fee
  schedule, privacy notice or liquidation terms have been drafted or reviewed.
  The explanatory copy in this codebase is product text, not legal text.
- **Risk committee.** The parameters in the shipped policy are engineering
  defaults. They have not been set or ratified by anyone qualified to set them.
- **Security assurance.** No penetration test, no third-party security review,
  no threat model sign-off.
- **Production operations.** No incident-response runbook, no disaster-recovery
  test, no on-call rotation, no monitoring or alerting infrastructure beyond
  application logs.
- **Data protection.** No data-retention schedule, no DSAR process, no records
  of processing, no DPIA.
- **Consumer protection.** No complaints procedure, no vulnerable-customer
  policy, no affordability assessment beyond the collateral test, no
  forbearance or hardship path.
- **Financial crime.** Transaction monitoring is limited to the authorization
  fraud engine. There is no SAR workflow, no ongoing customer risk rating, and
  no sanctions re-screening cadence beyond the `rescreen` port.
- **Tax.** Liquidation has real tax consequences for a customer in most
  jurisdictions. Nothing here models, reports or discloses them.

## Known limitations worth stating plainly

**The sandbox custodian is not a custodian.** It holds balances in memory and
rehydrates them from our own database. A real custodian is the source of truth
for what a customer holds; here, we are. Nothing in this repository proves
anyone owns anything.

**Prices come from a simulator.** The consolidation logic — median across
sources, staleness, dispersion, depeg detection — is real and tested. The prices
it consolidates are generated.

**Liquidation execution is simulated.** The plan is real, deterministic and
auditable. The sale is a function call.

**No key management.** Device public keys sit in a table. There is no HSM, no
KMS, no key rotation, and application secrets come from environment variables.

**Single-region, single-database.** No replication, no failover, no backup
verification.
