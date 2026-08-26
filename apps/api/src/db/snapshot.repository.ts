import type { StateSnapshot } from '@warrant/core';
import type { Sql } from './db';
import {
  toCustomer,
  toDispute,
  toOrder,
  toPayment,
  toPaymentMethod,
  toProcessorAccount,
  toRefund,
  toSubscription,
  toTenant,
} from './mappers';

/**
 * What the compiler is allowed to see, and nothing else.
 *
 * `focus` names the entity the action is about. From it the loader resolves the order
 * and pulls the full graph around it -- payments, refunds, disputes, the customer, the
 * subscription -- so that derived balances are computed from complete data. Loading only
 * the named entity would be faster and wrong: a refund's admissibility depends on
 * refunds and disputes the model never mentioned.
 *
 * Every query carries an explicit tenant predicate even though row-level security would
 * enforce it anyway. The predicate is the control; RLS is the backstop. Relying on the
 * backstop alone means the day someone runs a query against a replica with policies
 * disabled, or through a migration path, the isolation is gone.
 */
export interface SnapshotFocus {
  orderId?: string;
  paymentId?: string;
  subscriptionId?: string;
}

export async function loadSnapshot(
  sql: Sql,
  tenantId: string,
  focus: SnapshotFocus,
  capturedAt: string,
): Promise<StateSnapshot | null> {
  const tenantRows = await sql.query<{ id: string; name: string; default_currency: string }>(
    'SELECT id, name, default_currency FROM tenants WHERE id = $1',
    [tenantId],
  );
  const tenantRow = tenantRows.rows[0];
  if (!tenantRow) return null;

  // Resolve the focus down to at most one order and at most one subscription.
  let orderId = focus.orderId ?? null;

  if (!orderId && focus.paymentId) {
    const r = await sql.query<{ order_id: string }>(
      'SELECT order_id FROM payments WHERE tenant_id = $1 AND id = $2',
      [tenantId, focus.paymentId],
    );
    orderId = r.rows[0]?.order_id ?? null;
  }

  // Sequential, not Promise.all. A pg client is a single connection with one wire
  // protocol stream; concurrent queries on it are queued at best and an error in pg 9.
  // These reads are also inside one REPEATABLE READ transaction, so parallelising them
  // would buy nothing -- they all observe the same snapshot either way.
  const empty = { rows: [] as never[], rowCount: 0 };

  const orders = orderId
    ? await sql.query('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId, orderId])
    : empty;
  const subscriptions = focus.subscriptionId
    ? await sql.query('SELECT * FROM subscriptions WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        focus.subscriptionId,
      ])
    : empty;
  const processorAccounts = await sql.query(
    'SELECT * FROM processor_accounts WHERE tenant_id = $1',
    [tenantId],
  );

  const orderRows = orders.rows as Parameters<typeof toOrder>[0][];
  const subscriptionRows = subscriptions.rows as Parameters<typeof toSubscription>[0][];

  const customerIds = new Set<string>();
  for (const o of orderRows) customerIds.add(o.customer_id);
  for (const s of subscriptionRows) customerIds.add(s.customer_id);

  const resolvedOrderId = orderRows[0]?.id ?? null;

  const ids = [...customerIds];
  const payments = resolvedOrderId
    ? await sql.query('SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2', [
        tenantId,
        resolvedOrderId,
      ])
    : empty;
  const refunds = resolvedOrderId
    ? await sql.query('SELECT * FROM refunds WHERE tenant_id = $1 AND order_id = $2', [
        tenantId,
        resolvedOrderId,
      ])
    : empty;
  const disputes = resolvedOrderId
    ? await sql.query('SELECT * FROM disputes WHERE tenant_id = $1 AND order_id = $2', [
        tenantId,
        resolvedOrderId,
      ])
    : empty;
  const customers =
    ids.length > 0
      ? await sql.query(
          'SELECT id, tenant_id, email FROM customers WHERE tenant_id = $1 AND id = ANY($2)',
          [tenantId, ids],
        )
      : empty;
  const paymentMethods =
    ids.length > 0
      ? await sql.query('SELECT * FROM payment_methods WHERE tenant_id = $1 AND customer_id = ANY($2)', [
          tenantId,
          ids,
        ])
      : empty;

  const orderEntities = orderRows.map(toOrder);
  const paymentEntities = (payments.rows as Parameters<typeof toPayment>[0][]).map(toPayment);
  const subscriptionEntities = subscriptionRows.map(toSubscription);

  // A single monotonic number summarising the freshness of everything in the snapshot.
  // Carried into the plan so a stale read is detectable independently of the effect hash.
  const snapshotVersion = Math.max(
    0,
    ...orderRows.map((o) => o.version),
    ...(payments.rows as { version: number }[]).map((p) => p.version),
    ...(subscriptions.rows as { version: number }[]).map((s) => s.version),
  );

  return {
    tenant: toTenant(tenantRow),
    capturedAt,
    snapshotVersion,
    customers: (customers.rows as Parameters<typeof toCustomer>[0][]).map(toCustomer),
    orders: orderEntities,
    payments: paymentEntities,
    refunds: (refunds.rows as Parameters<typeof toRefund>[0][]).map(toRefund),
    disputes: (disputes.rows as Parameters<typeof toDispute>[0][]).map(toDispute),
    subscriptions: subscriptionEntities,
    paymentMethods: (paymentMethods.rows as Parameters<typeof toPaymentMethod>[0][]).map(
      toPaymentMethod,
    ),
    processorAccounts: (
      processorAccounts.rows as Parameters<typeof toProcessorAccount>[0][]
    ).map(toProcessorAccount),
  };
}
