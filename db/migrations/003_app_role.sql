-- The application role.
--
-- This migration exists because of a mistake worth recording. Migrations 001 and 002 set
-- up row-level security correctly -- policies on every tenant-scoped table, FORCE ROW
-- LEVEL SECURITY so the table owner is not exempt -- and it was completely inert, because
-- the application was connecting as the database superuser that Docker's POSTGRES_USER
-- creates. Superusers bypass RLS unconditionally; FORCE does not apply to them. A probe
-- that deliberately tried a cross-tenant read got every row back.
--
-- The lesson generalises: a security control that is never observed failing is not known
-- to work. db/rls.test.mjs now asserts the isolation from the outside, as the application
-- role, and would have caught this on the first run.
--
-- Layout after this migration:
--   warrant      superuser, owns the schema, runs migrations only
--   warrant_app  no superuser, no BYPASSRLS, holds DML rights and nothing more

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'warrant_app') THEN
    CREATE ROLE warrant_app LOGIN PASSWORD 'warrant_app';
  END IF;
END $$;

-- Explicitly assert the two attributes the isolation depends on, in case the role was
-- created by hand somewhere with different flags.
ALTER ROLE warrant_app NOSUPERUSER NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO warrant_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO warrant_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO warrant_app;

-- No DELETE on the append-only tables. The audit chain and the ledger are evidence; the
-- application has no legitimate reason to remove rows from either, so it is not granted
-- the ability to.
REVOKE DELETE ON audit_events, ledger_entries, domain_events, processor_events FROM warrant_app;
REVOKE UPDATE ON audit_events, ledger_entries FROM warrant_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO warrant_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO warrant_app;
