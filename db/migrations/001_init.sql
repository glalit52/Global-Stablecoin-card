-- Global Wealth Card — core schema (PRD §20 Data Model).
--
-- Conventions that hold everywhere in this schema:
--   * Money and asset quantities are NUMERIC(38,18). Never float, never
--     bigint-cents: crypto needs 18 decimals and fiat needs exactness, and
--     NUMERIC gives both without the application having to remember a scale.
--   * Every table that records a decision also records the policy version that
--     produced it, so a decision can be replayed against the rules of its day.
--   * Timestamps are TIMESTAMPTZ. A risk engine that straddles a DST boundary
--     on local time is a risk engine that liquidates the wrong account.
--   * Deletes are avoided. Financial history is append-only; state changes are
--     new rows or explicit status columns.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TYPE kyc_status AS ENUM ('not_started','pending','in_review','approved','rejected','expired');
CREATE TYPE customer_status AS ENUM ('prospect','active','restricted','suspended','closed');
CREATE TYPE tier AS ENUM ('WEALTH','WEALTH_PLUS','PRIVATE','ULTRA');

CREATE TABLE customers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL,
  legal_name           TEXT NOT NULL,
  date_of_birth        DATE,
  jurisdiction         TEXT NOT NULL,
  status               customer_status NOT NULL DEFAULT 'prospect',
  tier                 tier NOT NULL DEFAULT 'WEALTH',
  kyc_status           kyc_status NOT NULL DEFAULT 'not_started',
  kyc_reference        TEXT,
  sanctions_clear      BOOLEAN NOT NULL DEFAULT FALSE,
  pep_review_cleared   BOOLEAN NOT NULL DEFAULT TRUE,
  fraud_score          NUMERIC(6,4) NOT NULL DEFAULT 0,
  delinquencies_30d    INTEGER NOT NULL DEFAULT 0,
  on_time_rate         NUMERIC(6,4),
  monthly_income       NUMERIC(38,18),
  custody_account_id   TEXT,
  password_hash        TEXT NOT NULL,
  password_salt        TEXT NOT NULL,
  travel_notice        TEXT[] NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_email_key ON customers (lower(email));

-- Device binding (PRD §17.1). A session is bound to a device public key, and
-- sensitive actions require a fresh signature over a server-issued challenge.
CREATE TABLE devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  device_name    TEXT NOT NULL,
  public_key     TEXT NOT NULL,
  algorithm      TEXT NOT NULL DEFAULT 'ed25519',
  trusted        BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX devices_customer_idx ON devices (customer_id) WHERE revoked_at IS NULL;

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
  operator_id     UUID,
  device_id       UUID REFERENCES devices(id),
  token_hash      TEXT NOT NULL UNIQUE,
  ip              TEXT,
  user_agent      TEXT,
  -- Raised by a successful step-up, consumed by the action that needed it.
  step_up_until   TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sessions_one_principal CHECK (num_nonnulls(customer_id, operator_id) = 1)
);
CREATE INDEX sessions_customer_idx ON sessions (customer_id) WHERE revoked_at IS NULL;

CREATE TABLE step_up_challenges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  device_id     UUID REFERENCES devices(id),
  challenge     TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  consumed_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Wealth graph (PRD §9)
-- ---------------------------------------------------------------------------

CREATE TYPE asset_class AS ENUM ('BTC','ETH','STABLECOIN','EQUITY','ETF','BOND','CASH','OTHER_TOKEN');
CREATE TYPE custody_model AS ENUM ('institutional_custodian','self_custody_verified','exchange','broker','bank');
CREATE TYPE verification_method AS ENUM ('onchain_signature','onchain_balance','custodian_api','broker_api','bank_aggregation','manual_review');

CREATE TABLE connected_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  custodian           TEXT NOT NULL,
  custody_model       custody_model NOT NULL,
  external_account_id TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'connected',
  last_synced_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, custodian, external_account_id)
);

CREATE TABLE assets (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connected_account_id UUID REFERENCES connected_accounts(id) ON DELETE SET NULL,
  asset_class          asset_class NOT NULL,
  symbol               TEXT NOT NULL,
  custodian            TEXT NOT NULL,
  custody_model        custody_model NOT NULL,
  quantity             NUMERIC(38,18) NOT NULL CHECK (quantity >= 0),
  quote_currency       TEXT NOT NULL DEFAULT 'USD',
  verification         verification_method NOT NULL,
  last_verified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  pledged              BOOLEAN NOT NULL DEFAULT FALSE,
  excluded             BOOLEAN NOT NULL DEFAULT FALSE,
  excluded_reason      TEXT,
  pledge_reference     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, custodian, symbol)
);
CREATE INDEX assets_customer_idx ON assets (customer_id);

-- Prices are kept as observations, not as a mutable "current price" row, so a
-- valuation can be reproduced exactly as of any past moment.
CREATE TABLE price_observations (
  id           BIGSERIAL PRIMARY KEY,
  symbol       TEXT NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  price        NUMERIC(38,18) NOT NULL CHECK (price > 0),
  source       TEXT NOT NULL,
  as_of        TIMESTAMPTZ NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_observations_lookup ON price_observations (symbol, as_of DESC);

-- ---------------------------------------------------------------------------
-- Credit & risk
-- ---------------------------------------------------------------------------

CREATE TYPE facility_status AS ENUM ('pending','active','restricted','frozen','closed','defaulted');
CREATE TYPE risk_state AS ENUM ('healthy','watch','restricted','remediation','liquidation');

CREATE TABLE credit_facilities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  currency            TEXT NOT NULL DEFAULT 'USD',
  credit_limit        NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  principal_balance   NUMERIC(38,18) NOT NULL DEFAULT 0,
  interest_balance    NUMERIC(38,18) NOT NULL DEFAULT 0,
  fee_balance         NUMERIC(38,18) NOT NULL DEFAULT 0,
  -- Derived from open authorizations; kept denormalised because the
  -- authorization path cannot afford an aggregate on every tap.
  holds_total         NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (holds_total >= 0),
  apr_bps             INTEGER NOT NULL DEFAULT 1150,
  status              facility_status NOT NULL DEFAULT 'pending',
  partner_facility_id TEXT,
  statement_day       SMALLINT NOT NULL DEFAULT 1,
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX credit_facilities_customer_key ON credit_facilities (customer_id);

CREATE TABLE credit_decisions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  approved          BOOLEAN NOT NULL,
  credit_limit      NUMERIC(38,18) NOT NULL,
  previous_limit    NUMERIC(38,18),
  breakdown         JSONB NOT NULL,
  decline_reasons   TEXT[] NOT NULL DEFAULT '{}',
  explanations      TEXT[] NOT NULL DEFAULT '{}',
  policy_version    TEXT NOT NULL,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX credit_decisions_customer_idx ON credit_decisions (customer_id, decided_at DESC);

CREATE TABLE risk_snapshots (
  id                        BIGSERIAL PRIMARY KEY,
  customer_id               UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  gross_ltv                 NUMERIC(38,18),
  effective_ltv             NUMERIC(38,18),
  health_factor             NUMERIC(38,18),
  health_percent            NUMERIC(6,2) NOT NULL,
  state                     risk_state NOT NULL,
  total_debt                NUMERIC(38,18) NOT NULL,
  eligible_collateral_value NUMERIC(38,18) NOT NULL,
  total_market_value        NUMERIC(38,18) NOT NULL,
  top_concentration         NUMERIC(10,8) NOT NULL,
  withdrawable_collateral   NUMERIC(38,18) NOT NULL,
  safe_spend_capacity       NUMERIC(38,18) NOT NULL,
  triggered_rules           TEXT[] NOT NULL DEFAULT '{}',
  positions                 JSONB NOT NULL DEFAULT '[]',
  degraded                  BOOLEAN NOT NULL DEFAULT FALSE,
  policy_version            TEXT NOT NULL,
  computed_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX risk_snapshots_customer_idx ON risk_snapshots (customer_id, computed_at DESC);

CREATE TABLE margin_calls (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  raised_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at      TIMESTAMPTZ NOT NULL,
  ltv_at_raise     NUMERIC(38,18) NOT NULL,
  required_amount  NUMERIC(38,18) NOT NULL,
  cured_at         TIMESTAMPTZ,
  cure_method      TEXT,
  escalated_at     TIMESTAMPTZ,
  policy_version   TEXT NOT NULL
);
CREATE INDEX margin_calls_open_idx ON margin_calls (customer_id) WHERE cured_at IS NULL;

CREATE TABLE liquidations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id            UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  margin_call_id         UUID REFERENCES margin_calls(id),
  triggered_by           TEXT NOT NULL,
  strategy               TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'planned',
  target_ltv             NUMERIC(38,18) NOT NULL,
  debt_before            NUMERIC(38,18) NOT NULL,
  collateral_before      NUMERIC(38,18) NOT NULL,
  plan                   JSONB NOT NULL,
  total_net_proceeds     NUMERIC(38,18) NOT NULL DEFAULT 0,
  projected_ltv_after    NUMERIC(38,18),
  approved_by            UUID,
  approved_at            TIMESTAMPTZ,
  executed_at            TIMESTAMPTZ,
  policy_version         TEXT NOT NULL,
  planned_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE liquidation_lots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  liquidation_id   UUID NOT NULL REFERENCES liquidations(id) ON DELETE CASCADE,
  symbol           TEXT NOT NULL,
  quantity         NUMERIC(38,18) NOT NULL,
  estimated_price  NUMERIC(38,18) NOT NULL,
  executed_price   NUMERIC(38,18),
  gross_proceeds   NUMERIC(38,18) NOT NULL,
  fees             NUMERIC(38,18) NOT NULL DEFAULT 0,
  net_proceeds     NUMERIC(38,18) NOT NULL,
  fill_reference   TEXT,
  executed_at      TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Cards & payments (PRD §13)
-- ---------------------------------------------------------------------------

CREATE TYPE card_status AS ENUM ('requested','inactive','active','frozen','expired','cancelled','lost_stolen');
CREATE TYPE card_form AS ENUM ('virtual','physical');
CREATE TYPE transaction_status AS ENUM ('pending','settled','reversed','declined','disputed','refunded','expired');

CREATE TABLE cards (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  partner_card_id    TEXT NOT NULL UNIQUE,
  token_reference    TEXT NOT NULL,
  network            TEXT NOT NULL DEFAULT 'visa',
  form               card_form NOT NULL,
  last4              TEXT NOT NULL,
  exp_month          SMALLINT NOT NULL,
  exp_year           SMALLINT NOT NULL,
  status             card_status NOT NULL DEFAULT 'requested',
  controls           JSONB NOT NULL DEFAULT '{}',
  wallets            TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cards_customer_idx ON cards (customer_id);

CREATE TABLE authorizations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id         TEXT NOT NULL UNIQUE,
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  card_id            UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  approved           BOOLEAN NOT NULL,
  original_amount    NUMERIC(38,18) NOT NULL,
  original_currency  TEXT NOT NULL,
  billing_amount     NUMERIC(38,18) NOT NULL,
  fx_rate            NUMERIC(38,18),
  fx_fee             NUMERIC(38,18) NOT NULL DEFAULT 0,
  merchant_name      TEXT NOT NULL,
  merchant_id        TEXT NOT NULL,
  mcc                TEXT NOT NULL,
  merchant_country   TEXT NOT NULL,
  entry_mode         TEXT NOT NULL,
  is_recurring       BOOLEAN NOT NULL DEFAULT FALSE,
  decline_code       TEXT,
  decline_reason     TEXT,
  fraud_score        NUMERIC(6,4) NOT NULL DEFAULT 0,
  checks             JSONB NOT NULL DEFAULT '[]',
  -- Open holds reduce available credit until they settle or expire.
  hold_released      BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms         INTEGER NOT NULL DEFAULT 0,
  policy_version     TEXT NOT NULL,
  decided_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ
);
CREATE INDEX authorizations_customer_idx ON authorizations (customer_id, decided_at DESC);
CREATE INDEX authorizations_open_holds_idx ON authorizations (customer_id)
  WHERE approved AND NOT hold_released;

CREATE TABLE transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  card_id           UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  authorization_id  UUID REFERENCES authorizations(id),
  status            transaction_status NOT NULL DEFAULT 'pending',
  merchant_name     TEXT NOT NULL,
  mcc               TEXT NOT NULL,
  category          TEXT NOT NULL,
  merchant_country  TEXT NOT NULL,
  original_amount   NUMERIC(38,18) NOT NULL,
  original_currency TEXT NOT NULL,
  billing_amount    NUMERIC(38,18) NOT NULL,
  fx_rate           NUMERIC(38,18),
  fx_fee            NUMERIC(38,18) NOT NULL DEFAULT 0,
  interchange       NUMERIC(38,18) NOT NULL DEFAULT 0,
  points_earned     NUMERIC(38,18) NOT NULL DEFAULT 0,
  dispute_id        UUID,
  authorized_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at        TIMESTAMPTZ
);
CREATE INDEX transactions_customer_idx ON transactions (customer_id, authorized_at DESC);

CREATE TABLE disputes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id   UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reason           TEXT NOT NULL,
  amount           NUMERIC(38,18) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  provisional_credit BOOLEAN NOT NULL DEFAULT FALSE,
  resolution       TEXT,
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);

CREATE TABLE repayments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount          NUMERIC(38,18) NOT NULL CHECK (amount > 0),
  currency        TEXT NOT NULL DEFAULT 'USD',
  source          TEXT NOT NULL,
  external_ref    TEXT,
  status          TEXT NOT NULL DEFAULT 'posted',
  applied_to_fees NUMERIC(38,18) NOT NULL DEFAULT 0,
  applied_to_interest NUMERIC(38,18) NOT NULL DEFAULT 0,
  applied_to_principal NUMERIC(38,18) NOT NULL DEFAULT 0,
  overpayment     NUMERIC(38,18) NOT NULL DEFAULT 0,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX repayments_customer_idx ON repayments (customer_id, received_at DESC);

CREATE TABLE statements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  opening_balance   NUMERIC(38,18) NOT NULL,
  purchases         NUMERIC(38,18) NOT NULL DEFAULT 0,
  interest_charged  NUMERIC(38,18) NOT NULL DEFAULT 0,
  fees_charged      NUMERIC(38,18) NOT NULL DEFAULT 0,
  payments          NUMERIC(38,18) NOT NULL DEFAULT 0,
  closing_balance   NUMERIC(38,18) NOT NULL,
  minimum_payment   NUMERIC(38,18) NOT NULL,
  due_date          DATE NOT NULL,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, period_end)
);

-- ---------------------------------------------------------------------------
-- Ledger (PRD §28) — the authoritative record of value
-- ---------------------------------------------------------------------------

CREATE TABLE journal_entries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL,
  currency         TEXT NOT NULL,
  description      TEXT NOT NULL,
  reference_type   TEXT NOT NULL,
  reference_id     TEXT NOT NULL,
  -- The business-event key. A unique index here is what makes a replayed
  -- webhook or a retried network message a no-op instead of a double posting.
  idempotency_key  TEXT NOT NULL UNIQUE,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_reference_idx ON journal_entries (reference_type, reference_id);

CREATE TABLE postings (
  id            BIGSERIAL PRIMARY KEY,
  entry_id      UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_code  TEXT NOT NULL,
  customer_id   UUID REFERENCES customers(id) ON DELETE CASCADE,
  -- Positive is a debit, negative is a credit. Postings of an entry must
  -- sum to exactly zero; enforced in the application and by the reconciler.
  amount        NUMERIC(38,18) NOT NULL,
  memo          TEXT NOT NULL DEFAULT '',
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX postings_account_idx ON postings (account_code, customer_id);
CREATE INDEX postings_entry_idx ON postings (entry_id);

-- Balances are derived, never assigned. This view is the only sanctioned way
-- to read one, so no code path can drift from the postings.
CREATE VIEW account_balances AS
  SELECT account_code, customer_id, SUM(amount) AS balance
  FROM postings GROUP BY account_code, customer_id;

-- ---------------------------------------------------------------------------
-- Rewards (PRD §15)
-- ---------------------------------------------------------------------------

CREATE TABLE reward_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  points          NUMERIC(38,18) NOT NULL,
  transaction_id  UUID REFERENCES transactions(id) ON DELETE SET NULL,
  category        TEXT,
  rate_applied    NUMERIC(10,4),
  accrual_cost    NUMERIC(38,18) NOT NULL DEFAULT 0,
  description     TEXT NOT NULL DEFAULT '',
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reward_entries_customer_idx ON reward_entries (customer_id, occurred_at DESC);

CREATE TABLE redemptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  points        NUMERIC(38,18) NOT NULL,
  value_amount  NUMERIC(38,18) NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  status        TEXT NOT NULL DEFAULT 'completed',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lounge_visits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  lounge_name   TEXT NOT NULL,
  airport_code  TEXT NOT NULL,
  covered       BOOLEAN NOT NULL,
  charged_amount NUMERIC(38,18) NOT NULL DEFAULT 0,
  visited_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Alerts, AI, audit (PRD §16, §17.3, §21, §22)
-- ---------------------------------------------------------------------------

CREATE TABLE alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  severity      TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  action_label  TEXT,
  action_href   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  -- Stops a flapping price from raising the same alert every risk tick.
  dedupe_key    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ
);
CREATE INDEX alerts_customer_idx ON alerts (customer_id, created_at DESC);
CREATE UNIQUE INDEX alerts_dedupe_idx ON alerts (customer_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status = 'open';

CREATE TABLE ai_interactions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  question           TEXT NOT NULL,
  intent             TEXT NOT NULL,
  answer             TEXT NOT NULL,
  -- The exact facts the answer was allowed to draw on, kept verbatim so a
  -- disputed answer can be audited against what the system actually knew.
  fact_pack          JSONB NOT NULL,
  cited_fact_keys    TEXT[] NOT NULL DEFAULT '{}',
  model_used         BOOLEAN NOT NULL DEFAULT FALSE,
  model_name         TEXT,
  grounding_rejected BOOLEAN NOT NULL DEFAULT FALSE,
  grounding_violations TEXT[] NOT NULL DEFAULT '{}',
  latency_ms         INTEGER NOT NULL DEFAULT 0,
  policy_version     TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_interactions_customer_idx ON ai_interactions (customer_id, created_at DESC);

CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  actor_type      TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  action          TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  before_state    JSONB,
  after_state     JSONB,
  policy_version  TEXT,
  correlation_id  TEXT,
  ip              TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Operations console (PRD §22)
-- ---------------------------------------------------------------------------

CREATE TABLE operators (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  -- support | risk | compliance | admin. Checked per endpoint.
  roles         TEXT[] NOT NULL DEFAULT '{}',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Maker-checker. PRD §22: "No single operations user should be able to bypass
-- critical risk controls."
CREATE TABLE approval_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  payload        JSONB NOT NULL,
  justification  TEXT NOT NULL,
  requested_by   UUID NOT NULL REFERENCES operators(id),
  approved_by    UUID REFERENCES operators(id),
  status         TEXT NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,
  executed_at    TIMESTAMPTZ,
  -- The approver may never be the requester.
  CONSTRAINT approval_requests_four_eyes CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX approval_requests_pending_idx ON approval_requests (status, requested_at);

-- Generic idempotency for inbound API calls that move money.
CREATE TABLE idempotency_records (
  key            TEXT PRIMARY KEY,
  endpoint       TEXT NOT NULL,
  customer_id    UUID,
  request_hash   TEXT NOT NULL,
  response_body  JSONB,
  status_code    INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE policy_activations (
  id              BIGSERIAL PRIMARY KEY,
  policy_version  TEXT NOT NULL,
  activated_by    UUID REFERENCES operators(id),
  approval_id     UUID REFERENCES approval_requests(id),
  notes           TEXT,
  activated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- schema_migrations itself is owned and created by scripts/migrate.ts.
