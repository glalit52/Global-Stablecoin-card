# API reference

Base URL `http://localhost:4000`. Authenticate with `Authorization: Bearer <token>`.

**Amounts are decimal strings, everywhere, in both directions.** `"1250.00"`,
never `1250.0`. Parsing money into a float is how a rounding error reaches a
customer's statement.

Errors are `{ "error": { "code", "message", "details?" } }`.

| Status | Meaning |
|---|---|
| 400 | Validation failed, or a business rule refused the request |
| 401 | No session, or it expired |
| 403 | Authenticated but not permitted |
| 404 | Not found |
| 409 | Conflict — duplicate, or already in a terminal state |
| 422 | Understood but unprocessable |
| 428 | Step-up authentication required before this action |

## Authentication

| Endpoint | Purpose |
|---|---|
| `POST /v1/auth/register` | Register, run KYC, return a session |
| `POST /v1/auth/login` | Customer session |
| `POST /v1/operator/login` | Operator session |
| `POST /v1/auth/logout` | Revoke the current session |
| `GET /v1/auth/me` | Current customer |
| `POST /v1/auth/devices` | Register a device public key (Ed25519, SPKI DER, base64) |
| `GET /v1/auth/devices` | List bound devices |
| `DELETE /v1/auth/devices/:id` | Revoke a device |
| `POST /v1/auth/step-up/challenge` | Get a challenge to sign |
| `POST /v1/auth/step-up/verify` | Submit the signature, raise the session |

Step-up gates the actions where being logged in is not enough: revealing a card
number, releasing collateral, redeeming points.

```bash
curl -X POST localhost:4000/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ana@example.com","password":"wealth-demo-2026!"}'
```

## Wealth and collateral (PRD §21)

| Endpoint | Returns |
|---|---|
| `GET /v1/wealth` | Verified assets, total wealth, allocation, per-position eligibility with reasons |
| `GET /v1/collateral` | Eligible collateral and the haircut on each position |
| `POST /v1/collateral/add` | Pledge an asset |
| `POST /v1/collateral/release` | Unpledge — refused if it would breach the LTV limit. Requires step-up. |
| `POST /v1/account/refresh` | Force a revaluation |

A release that would leave the account over the origination LTV is refused with
the arithmetic attached:

```json
{
  "error": {
    "code": "release_would_breach_ltv",
    "message": "Releasing BTC would leave 142,617.86 of eligible collateral against a 96,000.00 balance, above the 50% limit. Repay first or release a smaller position.",
    "details": {
      "eligibleCollateralAfter": "142617.86",
      "currentDebt": "96000.00",
      "maximumDebtAfterRelease": "71308.93"
    }
  }
}
```

## Credit and risk

| Endpoint | Returns |
|---|---|
| `GET /v1/credit` | Limit, balances, available credit, APR, and the decision's own explanations |
| `POST /v1/credit/preview` | What a purchase of a given size would do, without committing it |
| `GET /v1/risk` | LTV, health, state, thresholds, any open margin call |
| `GET /v1/risk/stress` | Every policy scenario against the live position |

## Cards and payments (PRD §13)

| Endpoint | Purpose |
|---|---|
| `GET /v1/cards` | List cards |
| `POST /v1/cards` | Issue virtual or physical |
| `POST /v1/cards/:id/status` | Activate, freeze, unfreeze, report lost |
| `PATCH /v1/cards/:id/controls` | MCC blocks, country rules, channel toggles, spend limits |
| `POST /v1/cards/:id/reveal` | PAN and CVV. Requires step-up; always audited. |
| `POST /v1/cards/:id/wallet` | Apple Pay / Google Pay provisioning |
| `POST /v1/card/authorize` | **Authorization.** Called by the processor. |
| `POST /v1/card/settle` | Settlement callback |
| `GET /v1/transactions` | History, optionally including declines |
| `POST /v1/repayment` | Repay. Requires an idempotency key. |
| `GET /v1/statements` | Statement history |

### Authorization

The hot path. Returns 200 on approval, 402 on decline, with the full ordered
check trace either way — that trace is the audit record and the evidence in a
dispute.

```bash
curl -X POST localhost:4000/v1/card/authorize \
  -H 'content-type: application/json' \
  -d '{
    "requestId": "unique-per-attempt",
    "cardId": "<uuid>",
    "amount": "184.32",
    "currency": "USD",
    "merchantId": "m_wholefoods",
    "merchantName": "Whole Foods Market",
    "mcc": "5411",
    "merchantCountry": "US",
    "entryMode": "contactless"
  }'
```

```json
{
  "approved": true,
  "authorizationId": "auth_unique-per-attempt",
  "billingAmount": "184.32",
  "availableCreditAfter": "339408.08",
  "fraudScore": "0.000",
  "latencyMs": 1,
  "checks": [
    { "name": "card_status", "passed": true, "detail": "Card status is active" },
    { "name": "available_credit", "passed": true, "detail": "339,592.40 USD available, 184.32 requested" }
  ]
}
```

Decline codes follow the network convention: `51_insufficient_funds`,
`62_restricted_card`, `59_suspected_fraud`, `54_expired_card`,
`57_txn_not_permitted`, `61_exceeds_limit`, `65_exceeds_frequency`,
`78_card_not_active`, `05_do_not_honor`, `96_system_error`.

Replaying a `requestId` returns the original decision rather than re-running the
pipeline, which could decide differently as prices move.

## Rewards

| Endpoint | Purpose |
|---|---|
| `GET /v1/rewards` | Balance, tier benefits, earn rates, programme economics |
| `POST /v1/rewards/redeem` | Redeem. Requires step-up. |
| `POST /v1/lounge/visit` | Record a lounge visit against the tier allowance |

## Alerts

| Endpoint | Purpose |
|---|---|
| `GET /v1/alerts` | Risk, fraud and credit notices |
| `POST /v1/alerts/:id/acknowledge` | Dismiss |

## AI assistant (PRD §16)

| Endpoint | Purpose |
|---|---|
| `POST /v1/ai/query` | Ask a question |
| `GET /v1/ai/history` | What you asked and what we answered |
| `GET /v1/ai/suggestions` | Questions tailored to the account's current state |

Every answer carries its sources. Each source is a value with its timestamp and
origin, and every number in the answer traces to one of them.

```json
{
  "intent": "explain_limit",
  "answer": "Your credit limit is 341,000.00 USD, set on 19 Sep 2026, 20:40 UTC. …",
  "sources": [
    {
      "key": "eligible_collateral",
      "label": "Eligible collateral value",
      "value": "715885.11",
      "unit": "money",
      "asOf": "2026-09-19T20:40:12.000Z",
      "source": "collateral_engine@risk-policy-1.0.0"
    }
  ],
  "disclaimers": [
    "Values as of 19 Sep 2026, 20:40 UTC.",
    "This is information about your account, not financial advice."
  ],
  "modelUsed": false,
  "groundingRejected": false
}
```

`groundingRejected: true` means a draft stated a number absent from the fact
pack and was discarded or trimmed. Operations can list every such case.

## Operations console (PRD §22)

All require an operator session with a matching role.

| Endpoint | Roles |
|---|---|
| `GET /v1/admin/customers` | support, risk, compliance, admin |
| `GET /v1/admin/customers/:id` | support, risk, compliance, admin |
| `POST /v1/admin/customers/:id/refresh` | risk, admin |
| `POST /v1/admin/customers/:id/cards/:cardId/status` | support, risk, admin |
| `GET /v1/admin/liquidations` | risk, admin |
| `POST /v1/admin/liquidations/:id/cancel` | risk, admin |
| `GET /v1/admin/reconciliation` | risk, compliance, admin |
| `GET /v1/admin/policies` | risk, compliance, admin |
| `GET /v1/admin/audit` | compliance, risk, admin |
| `GET /v1/admin/ai-interactions` | compliance, risk, admin |
| `GET /v1/admin/metrics` | risk, compliance, admin |

### Dual approval

These actions cannot be performed by one operator:
`liquidation.execute`, `credit.manual_limit_override`, `facility.write_off`,
`policy.activate`, `customer.close`.

| Endpoint | Purpose |
|---|---|
| `POST /v1/admin/approvals` | File a request with a justification |
| `GET /v1/admin/approvals` | Pending queue |
| `POST /v1/admin/approvals/:id/approve` | Approve **and execute** |
| `POST /v1/admin/approvals/:id/reject` | Reject with a reason |

The four-eyes rule is enforced in the handler *and* by a database CHECK
constraint, so a bug in one cannot let a single operator approve their own
request.

## System

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness, database, partner wiring, active policy |
| `GET /v1/policy` | The live risk policy, so the UI shows real thresholds |
| `GET /v1/market` | Current sandbox prices and FX rates |
| `POST /v1/market/scenario` | **Sandbox.** Move a price and revalue every customer. |
| `POST /v1/admin/demo/seed-assets` | **Sandbox.** Place holdings directly. Refuses outside a sandbox build. |
