-- Warrant: initial schema.
--
-- Conventions used throughout:
--
--   * Money is BIGINT minor units plus a CHAR(3) currency. No numeric, no float.
--   * Every tenant-scoped table carries tenant_id NOT NULL, and every index that
--     supports a hot query leads with tenant_id.
--   * Timestamps are timestamptz. There is no local time anywhere in the system.
--   * State columns are TEXT with CHECK constraints rather than enums, because a
--     CHECK can be changed in a migration without an exclusive lock on every table
--     that references the type.
--
-- Tenant isolation is enforced twice: once in the repository layer, which never issues
-- a query without a tenant predicate, and once here with row-level security. The RLS
-- policies are the backstop -- if a repository method is written incorrectly, or a
-- future query forgets its WHERE clause, the database returns zero rows instead of
-- another merchant's payments. FORCE ROW LEVEL SECURITY is set so that the table owner
-- is subject to the policies too.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- tenancy and commerce state
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  default_currency CHAR(3) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  email       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customers_tenant_idx ON customers (tenant_id, id);

CREATE TABLE processor_accounts (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  processor            TEXT NOT NULL CHECK (processor IN ('stripe','adyen','airwallex','braintree')),
  healthy              BOOLEAN NOT NULL DEFAULT true,
  accepts_new_volume   BOOLEAN NOT NULL DEFAULT true,
  supported_currencies TEXT[] NOT NULL DEFAULT ARRAY['USD'],
  -- Secret used to verify inbound webhook signatures for this account. Stored here so
  -- that a compromised secret is scoped to one merchant-processor pair.
  webhook_secret       TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX processor_accounts_tenant_idx ON processor_accounts (tenant_id);

CREATE TABLE payment_methods (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  -- The merchant-owned vault reference. Processor-specific tokens hang off it, which is
  -- what allows the same instrument to be charged through a different processor without
  -- re-collecting the card.
  vault_token      TEXT NOT NULL,
  brand            TEXT NOT NULL,
  last4            CHAR(4) NOT NULL,
  exp_month        SMALLINT NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year         SMALLINT NOT NULL,
  processor_tokens JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_methods_tenant_customer_idx ON payment_methods (tenant_id, customer_id);

CREATE TABLE orders (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  state        TEXT NOT NULL CHECK (state IN
                 ('pending','authorized','paid','partially_refunded','refunded','disputed','cancelled')),
  total_minor  BIGINT NOT NULL CHECK (total_minor >= 0),
  currency     CHAR(3) NOT NULL,
  -- Optimistic concurrency. Bumped on every state-affecting write; carried into effect
  -- plans so a stale snapshot is detectable.
  version      INTEGER NOT NULL DEFAULT 1,
  subscription_id TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_tenant_customer_idx ON orders (tenant_id, customer_id);
CREATE INDEX orders_tenant_state_idx ON orders (tenant_id, state);

CREATE TABLE payments (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  order_id             TEXT NOT NULL REFERENCES orders(id),
  processor_account_id TEXT NOT NULL REFERENCES processor_accounts(id),
  processor            TEXT NOT NULL,
  payment_method_id    TEXT NOT NULL REFERENCES payment_methods(id),
  state                TEXT NOT NULL CHECK (state IN
                         ('requires_capture','captured','partially_refunded','refunded','voided','failed','disputed')),
  authorized_minor     BIGINT NOT NULL CHECK (authorized_minor >= 0),
  captured_minor       BIGINT NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
  currency             CHAR(3) NOT NULL,
  authorized_at        TIMESTAMPTZ NOT NULL,
  captured_at          TIMESTAMPTZ,
  auth_expires_at      TIMESTAMPTZ NOT NULL,
  processor_reference  TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1,
  -- Enforced by the database, not only by the compiler: you cannot capture more than
  -- the issuer authorized.
  CONSTRAINT captured_within_authorized CHECK (captured_minor <= authorized_minor)
);
CREATE INDEX payments_tenant_order_idx ON payments (tenant_id, order_id);
CREATE UNIQUE INDEX payments_processor_ref_idx ON payments (processor_account_id, processor_reference);

CREATE TABLE refunds (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  order_id            TEXT NOT NULL REFERENCES orders(id),
  payment_id          TEXT NOT NULL REFERENCES payments(id),
  state               TEXT NOT NULL CHECK (state IN ('pending','succeeded','failed','cancelled')),
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  currency            CHAR(3) NOT NULL,
  reason              TEXT NOT NULL,
  processor_reference TEXT,
  -- The execution that created this refund. Unique, so a retried execution can never
  -- produce a second refund row for the same approved effect.
  execution_id        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refunds_tenant_order_idx ON refunds (tenant_id, order_id);
CREATE UNIQUE INDEX refunds_execution_idx ON refunds (execution_id) WHERE execution_id IS NOT NULL;

CREATE TABLE disputes (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  order_id    TEXT NOT NULL REFERENCES orders(id),
  payment_id  TEXT NOT NULL REFERENCES payments(id),
  state       TEXT NOT NULL CHECK (state IN ('open','under_review','won','lost','accepted')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency    CHAR(3) NOT NULL,
  reason      TEXT NOT NULL,
  opened_at   TIMESTAMPTZ NOT NULL,
  respond_by  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX disputes_tenant_order_idx ON disputes (tenant_id, order_id);

CREATE TABLE subscriptions (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  customer_id        TEXT NOT NULL REFERENCES customers(id),
  state              TEXT NOT NULL CHECK (state IN ('active','past_due','paused','cancelled','expired')),
  amount_minor       BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency           CHAR(3) NOT NULL,
  interval_days      INTEGER NOT NULL CHECK (interval_days > 0),
  current_period_end TIMESTAMPTZ NOT NULL,
  payment_method_id  TEXT NOT NULL REFERENCES payment_methods(id),
  cancel_at          TIMESTAMPTZ,
  version            INTEGER NOT NULL DEFAULT 1,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_tenant_customer_idx ON subscriptions (tenant_id, customer_id);

-- ---------------------------------------------------------------------------
-- the agent execution path
-- ---------------------------------------------------------------------------

CREATE TABLE agent_sessions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  subject       TEXT NOT NULL,
  -- The customer this session was opened for. Capability scope is derived from this,
  -- never from anything the model produces.
  customer_id   TEXT REFERENCES customers(id),
  operator      TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','cut_off')),
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ
);
CREATE INDEX agent_sessions_tenant_idx ON agent_sessions (tenant_id, opened_at DESC);

CREATE TABLE capabilities (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id),
  subject       TEXT NOT NULL,
  document      JSONB NOT NULL,
  signature     TEXT NOT NULL,
  issued_at     TIMESTAMPTZ NOT NULL,
  not_after     TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX capabilities_session_idx ON capabilities (session_id);

-- Budget counters. Kept as rows rather than derived from executions so that the
-- reservation can be taken inside the same transaction that records the execution,
-- under a row lock. Deriving them with a SUM would be correct but would race.
CREATE TABLE capability_usage (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  session_id      TEXT NOT NULL REFERENCES agent_sessions(id),
  subject         TEXT NOT NULL,
  usage_date      DATE NOT NULL,
  session_spent_minor BIGINT NOT NULL DEFAULT 0,
  daily_spent_minor   BIGINT NOT NULL DEFAULT 0,
  consecutive_denials INTEGER NOT NULL DEFAULT 0,
  currency        CHAR(3) NOT NULL,
  PRIMARY KEY (session_id, usage_date)
);

CREATE TABLE intents (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  session_id     TEXT NOT NULL REFERENCES agent_sessions(id),
  action_kind    TEXT NOT NULL,
  params         JSONB NOT NULL,
  rationale      TEXT NOT NULL,
  provenance     JSONB NOT NULL,
  -- Raw model output as received, before validation. Kept so that a malformed or
  -- adversarial tool call can be inspected after the fact.
  raw_tool_call  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX intents_tenant_session_idx ON intents (tenant_id, session_id, created_at DESC);

CREATE TABLE effect_plans (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  intent_id         TEXT NOT NULL REFERENCES intents(id),
  action_kind       TEXT NOT NULL,
  effect_hash       TEXT NOT NULL,
  route_hash        TEXT NOT NULL,
  admissible        BOOLEAN NOT NULL,
  merchant_outflow_minor BIGINT NOT NULL,
  notional_minor    BIGINT NOT NULL,
  currency          CHAR(3) NOT NULL,
  document          JSONB NOT NULL,
  snapshot_version  INTEGER NOT NULL,
  authz_outcome     TEXT CHECK (authz_outcome IN ('allow','require_approval','deny')),
  authz_document    JSONB,
  state             TEXT NOT NULL DEFAULT 'compiled' CHECK (state IN
                      ('compiled','denied','awaiting_approval','approved','rejected','executing',
                       'executed','aborted_divergence','failed','expired')),
  compiled_at       TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX effect_plans_tenant_state_idx ON effect_plans (tenant_id, state, compiled_at DESC);
CREATE INDEX effect_plans_effect_hash_idx ON effect_plans (tenant_id, effect_hash);

CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  plan_id       TEXT NOT NULL REFERENCES effect_plans(id),
  -- The effect the human actually saw and agreed to. Compared at commit time. Storing
  -- it on the approval rather than reading it back off the plan means a later edit to
  -- the plan row cannot silently re-point an existing approval.
  approved_effect_hash TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_by    TEXT NOT NULL,
  note          TEXT,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX approvals_plan_idx ON approvals (plan_id);

CREATE TABLE executions (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  plan_id           TEXT NOT NULL REFERENCES effect_plans(id),
  -- Derived deterministically from the approved effect hash. The unique constraint is
  -- what makes duplicate submission impossible rather than merely unlikely.
  idempotency_key   TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN
                      ('pending','succeeded','failed','indeterminate','aborted')),
  attempt           INTEGER NOT NULL DEFAULT 1,
  processor_account_id TEXT REFERENCES processor_accounts(id),
  processor_reference  TEXT,
  error_code        TEXT,
  error_detail      TEXT,
  divergence        JSONB,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX executions_idempotency_idx ON executions (idempotency_key);
CREATE INDEX executions_tenant_state_idx ON executions (tenant_id, state, started_at DESC);

-- Immutable financial ledger. Written only by a committed execution or a confirmed
-- processor event, never by the agent and never updated in place.
CREATE TABLE ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  execution_id TEXT REFERENCES executions(id),
  account      TEXT NOT NULL CHECK (account IN
                 ('authorized_funds','merchant_balance','customer_settlement','dispute_reserve','processor_fees')),
  amount_minor BIGINT NOT NULL,
  currency     CHAR(3) NOT NULL,
  entity_ref   TEXT NOT NULL,
  effect_hash  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_tenant_entity_idx ON ledger_entries (tenant_id, entity_ref);
CREATE INDEX ledger_execution_idx ON ledger_entries (execution_id);

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------

-- Raw inbound webhooks, stored before interpretation. The unique index on
-- (processor_account_id, processor_event_id) is the whole duplicate-webhook defence:
-- a redelivered event fails to insert and is acknowledged without being applied twice.
CREATE TABLE processor_events (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  processor_account_id TEXT NOT NULL REFERENCES processor_accounts(id),
  processor            TEXT NOT NULL,
  processor_event_id   TEXT NOT NULL,
  event_type           TEXT NOT NULL,
  payload              JSONB NOT NULL,
  signature_valid      BOOLEAN NOT NULL,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurred_at          TIMESTAMPTZ NOT NULL,
  processed_at         TIMESTAMPTZ,
  outcome              TEXT CHECK (outcome IN ('applied','duplicate','stale','deferred','unhandled','rejected'))
);
CREATE UNIQUE INDEX processor_events_dedupe_idx
  ON processor_events (processor_account_id, processor_event_id);
CREATE INDEX processor_events_tenant_received_idx ON processor_events (tenant_id, received_at DESC);

-- Normalized internal event model. One shape regardless of which processor produced it.
CREATE TABLE domain_events (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  type               TEXT NOT NULL,
  entity_ref         TEXT NOT NULL,
  payload            JSONB NOT NULL,
  processor_event_id TEXT REFERENCES processor_events(id),
  occurred_at        TIMESTAMPTZ NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX domain_events_tenant_entity_idx ON domain_events (tenant_id, entity_ref, occurred_at);

-- Events that arrived before the state they depend on. Re-evaluated on a timer rather
-- than dropped, because "the capture webhook overtook the authorization webhook" is a
-- normal Tuesday and not an error.
CREATE TABLE deferred_events (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  processor_event_id TEXT NOT NULL REFERENCES processor_events(id),
  reason             TEXT NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ
);
CREATE INDEX deferred_events_due_idx ON deferred_events (next_attempt_at) WHERE resolved_at IS NULL;

-- Transactional outbox. Enqueue happens in the same transaction as the state change it
-- describes, so a job can never reference a state that was rolled back. Drained with
-- SELECT ... FOR UPDATE SKIP LOCKED, which gives competing-consumer semantics without
-- adding a broker to the deployment.
CREATE TABLE outbox (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  topic           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  available_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 8,
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  processed_at    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_ready_idx ON outbox (available_at, id) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- audit
-- ---------------------------------------------------------------------------

-- Append-only, hash-chained. Each row commits to the previous row's hash, so removing
-- or altering an audit record after the fact breaks the chain for everything that
-- follows it. This is tamper-evidence, not tamper-proofing: it does not stop a database
-- administrator from rewriting history, it makes the rewrite detectable.
CREATE TABLE audit_events (
  seq          BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  trace_id     TEXT NOT NULL,
  session_id   TEXT,
  stage        TEXT NOT NULL,
  actor        TEXT NOT NULL,
  subject_ref  TEXT,
  payload      JSONB NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_trace_idx ON audit_events (tenant_id, trace_id, seq);
CREATE INDEX audit_tenant_seq_idx ON audit_events (tenant_id, seq);

-- Reconciliation drift between our ledger and what the processor reports.
CREATE TABLE reconciliation_findings (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  entity_ref    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  internal_minor BIGINT,
  processor_minor BIGINT,
  currency      CHAR(3),
  detail        TEXT NOT NULL,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_open_idx ON reconciliation_findings (tenant_id, created_at DESC)
  WHERE resolved_at IS NULL;
