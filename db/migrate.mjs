#!/usr/bin/env node
/**
 * Minimal forward-only migration runner.
 *
 * Plain SQL files applied in filename order, each inside its own transaction, recorded
 * in `schema_migrations` with a checksum. Two properties matter and neither needs a
 * framework: a migration cannot be applied twice, and a migration that has been edited
 * after being applied is refused rather than silently skipped.
 *
 * Usage:
 *   node db/migrate.mjs           apply pending migrations
 *   node db/migrate.mjs --reset   drop and recreate the public schema first
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

// Migrations run as the owner. The application's own DATABASE_URL points at a
// non-superuser role that cannot create schemas or bypass row-level security.
const DATABASE_URL =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://warrant:warrant@localhost:5433/warrant';

const checksum = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

async function main() {
  const reset = process.argv.includes('--reset');
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    if (reset) {
      process.stdout.write('resetting public schema\n');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = new Map(
      (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [
        r.name,
        r.checksum,
      ]),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    let pending = 0;
    for (const name of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
      const sum = checksum(sql);

      if (applied.has(name)) {
        if (applied.get(name) !== sum) {
          throw new Error(
            `migration ${name} was modified after being applied ` +
              `(recorded ${applied.get(name)}, now ${sum}). ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        continue;
      }

      process.stdout.write(`applying ${name}\n`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          name,
          sum,
        ]);
        await client.query('COMMIT');
        pending += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${name} failed: ${err.message}`);
      }
    }

    process.stdout.write(
      pending === 0 ? 'schema up to date\n' : `applied ${pending} migration(s)\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
