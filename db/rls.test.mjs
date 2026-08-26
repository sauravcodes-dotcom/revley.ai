#!/usr/bin/env node
/**
 * Row-level security assertions, run from outside the application as the application
 * role.
 *
 * This file exists because the RLS setup in migration 002 was silently inert for its
 * first run: the policies were correct, but the app connected as a superuser and
 * PostgreSQL let it read everything. Nothing in the schema looked wrong. The only way to
 * know a security control works is to watch it refuse something.
 *
 * Run with:  npm run db:test:rls   (requires a migrated database)
 */
import assert from 'node:assert/strict';
import pg from 'pg';

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgres://warrant:warrant@localhost:5433/warrant';
const APP_URL = process.env.DATABASE_URL ?? 'postgres://warrant_app:warrant_app@localhost:5433/warrant';

const results = [];
function check(name, fn) {
  return fn().then(
    () => results.push({ name, ok: true }),
    (err) => results.push({ name, ok: false, err: err.message.split('\n')[0] }),
  );
}

async function withTenant(client, tenantId, fn) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1, $2, true)', ['warrant.tenant_id', tenantId]);
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  const app = new pg.Client({ connectionString: APP_URL });
  await admin.connect();
  await app.connect();

  // Seed two tenants as the superuser, which bypasses RLS by design.
  await admin.query(`
    INSERT INTO tenants (id, name, default_currency)
    VALUES ('rls_a', 'Tenant A', 'USD'), ('rls_b', 'Tenant B', 'USD')
    ON CONFLICT (id) DO NOTHING
  `);
  await admin.query(`
    INSERT INTO customers (id, tenant_id, email)
    VALUES ('rls_cus_a', 'rls_a', 'a@example.test'), ('rls_cus_b', 'rls_b', 'b@example.test')
    ON CONFLICT (id) DO NOTHING
  `);

  await check('the application role is not a superuser and cannot bypass RLS', async () => {
    const { rows } = await app.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    assert.equal(rows[0].rolsuper, false, 'application role must not be a superuser');
    assert.equal(rows[0].rolbypassrls, false, 'application role must not have BYPASSRLS');
  });

  await check('an unfiltered SELECT returns only the current tenant rows', async () => {
    const rows = await withTenant(app, 'rls_a', async () => {
      const r = await app.query('SELECT id, tenant_id FROM customers');
      return r.rows;
    });
    assert.deepEqual(
      rows.map((r) => r.id),
      ['rls_cus_a'],
      'query without a tenant predicate leaked rows across tenants',
    );
  });

  await check('a query that names another tenant explicitly still returns nothing', async () => {
    const rows = await withTenant(app, 'rls_a', async () => {
      const r = await app.query('SELECT id FROM customers WHERE tenant_id = $1', ['rls_b']);
      return r.rows;
    });
    assert.equal(rows.length, 0, 'explicit cross-tenant SELECT was not blocked');
  });

  await check('a connection with no tenant set sees an empty database', async () => {
    const r = await app.query('SELECT id FROM customers');
    assert.equal(r.rows.length, 0, 'unscoped connection could read tenant data');
  });

  await check('writing a row belonging to another tenant is refused', async () => {
    await assert.rejects(
      () =>
        withTenant(app, 'rls_a', () =>
          app.query('INSERT INTO customers (id, tenant_id, email) VALUES ($1, $2, $3)', [
            'rls_cus_evil',
            'rls_b',
            'evil@example.test',
          ]),
        ),
      /row-level security/i,
    );
  });

  await check('updating another tenant row is a no-op rather than a cross-tenant write', async () => {
    const updated = await withTenant(app, 'rls_a', async () => {
      const r = await app.query('UPDATE customers SET email = $1 WHERE id = $2', [
        'hijacked@example.test',
        'rls_cus_b',
      ]);
      return r.rowCount;
    });
    assert.equal(updated, 0);
    const { rows } = await admin.query('SELECT email FROM customers WHERE id = $1', ['rls_cus_b']);
    assert.equal(rows[0].email, 'b@example.test');
  });

  await check('the tenant setting does not survive the transaction that set it', async () => {
    await withTenant(app, 'rls_a', async () => app.query('SELECT 1'));
    const { rows } = await app.query("SELECT current_setting('warrant.tenant_id', true) AS t");
    assert.ok(
      rows[0].t === null || rows[0].t === '',
      `tenant setting leaked out of its transaction: ${rows[0].t}`,
    );
  });

  await check('the application cannot delete audit records', async () => {
    await assert.rejects(
      () => withTenant(app, 'rls_a', () => app.query('DELETE FROM audit_events')),
      /permission denied/i,
    );
  });

  await check('the application cannot update ledger entries', async () => {
    await assert.rejects(
      () => withTenant(app, 'rls_a', () => app.query('UPDATE ledger_entries SET amount_minor = 0')),
      /permission denied/i,
    );
  });

  await admin.query("DELETE FROM customers WHERE tenant_id IN ('rls_a','rls_b')");
  await admin.query("DELETE FROM tenants WHERE id IN ('rls_a','rls_b')");
  await admin.end();
  await app.end();

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    process.stdout.write(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.ok ? '' : `\n         ${r.err}`}\n`);
  }
  process.stdout.write(`\n${results.length - failed.length}/${results.length} row-level security checks passed\n`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
