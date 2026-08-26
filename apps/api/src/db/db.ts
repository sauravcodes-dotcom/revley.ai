import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export type Sql = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
};

/**
 * Every tenant-scoped read and write goes through `withTenant`.
 *
 * Three things happen here and all three matter:
 *
 *  1. `SET LOCAL warrant.tenant_id` scopes row-level security for the duration of the
 *     transaction. LOCAL rather than SESSION because connections are pooled: a SESSION
 *     setting would outlive the request and the next tenant to borrow that connection
 *     would inherit it.
 *  2. The setting is applied with `set_config(..., true)` and a bound parameter rather
 *     than string interpolation. `SET LOCAL` does not accept parameters, and building
 *     that statement by concatenation would put a tenant id -- which in some deployments
 *     is attacker-influenceable -- directly into SQL text.
 *  3. The callback gets a client, not the pool, so a caller cannot accidentally run half
 *     a unit of work on a different connection outside the transaction and its RLS
 *     scope.
 */
export class Db {
  private readonly pool: Pool;

  constructor(connectionString: string, max = 10) {
    this.pool = new Pool({ connectionString, max });
  }

  async withTenant<T>(tenantId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['warrant.tenant_id', tenantId]);
      return fn(client);
    });
  }

  /**
   * A tenant-scoped transaction at REPEATABLE READ.
   *
   * Used when compiling an effect plan. The compiler must see a single consistent view
   * of orders, payments, refunds and disputes; at READ COMMITTED the four queries that
   * build a snapshot could each observe a different moment, and the plan would describe
   * a state that never existed.
   */
  async withTenantSnapshot<T>(tenantId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await client.query('SELECT set_config($1, $2, true)', ['warrant.tenant_id', tenantId]);
      return fn(client);
    });
  }

  /** Unscoped transaction. Only for cross-tenant infrastructure: the outbox drain
   *  picking up work, and health checks. Never for reading commerce state. */
  async withoutTenant<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already broken; the pool will discard it.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Postgres error codes the application reasons about by name rather than by string. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_SERIALIZATION_FAILURE = '40001';
export const PG_RLS_VIOLATION = '42501';

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}
