-- Row-level security: the tenant-isolation backstop.
--
-- Application code sets `warrant.tenant_id` for the duration of a transaction and every
-- tenant-scoped table then filters itself. This is defence in depth, not the primary
-- control -- the repository layer still writes explicit tenant predicates -- but it means
-- a forgotten WHERE clause returns zero rows rather than another merchant's payments.
--
-- Notes on the mechanics:
--
--   * FORCE ROW LEVEL SECURITY is applied so that the table owner is subject to the
--     policies too. Without it the owner bypasses RLS and the protection is theatre in
--     exactly the deployment most likely to exist in practice (app connects as owner).
--   * current_setting(..., true) returns NULL rather than raising when the setting is
--     absent. The policy compares to a NULL tenant and matches nothing, so an unscoped
--     connection sees an empty database. Failing closed is the point.
--   * `warrant.tenant_id` is set with SET LOCAL inside the transaction, so it cannot
--     leak across pooled connections.

CREATE OR REPLACE FUNCTION warrant_current_tenant() RETURNS TEXT
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('warrant.tenant_id', true) $$;

DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'customers', 'processor_accounts', 'payment_methods', 'orders', 'payments',
    'refunds', 'disputes', 'subscriptions', 'agent_sessions', 'capabilities',
    'capability_usage', 'intents', 'effect_plans', 'approvals', 'executions',
    'ledger_entries', 'processor_events', 'domain_events', 'deferred_events',
    'outbox', 'audit_events', 'reconciliation_findings'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = warrant_current_tenant()) '
      'WITH CHECK (tenant_id = warrant_current_tenant())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- Enabling the policies is only half the job. See 003_app_role.sql: PostgreSQL
-- superusers bypass row-level security unconditionally, and FORCE ROW LEVEL SECURITY
-- does not change that. Everything above is inert unless the application connects as a
-- non-superuser role.
