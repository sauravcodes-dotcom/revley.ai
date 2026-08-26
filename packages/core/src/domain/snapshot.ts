import type { Currency } from '../money';
import type {
  Customer,
  Dispute,
  Order,
  Payment,
  PaymentMethod,
  ProcessorAccount,
  Refund,
  Subscription,
  Tenant,
} from './entities';
import type { TenantId } from './ids';

/**
 * A consistent read of everything the compiler is allowed to see.
 *
 * The compiler is a pure function of `(intent, snapshot)`. It never issues a query, so
 * the *only* way state can enter a plan is through this object. Two consequences:
 *
 *  - The compiler is trivially testable: build a snapshot literal, compile, assert.
 *  - Compiling the same intent against the same snapshot always produces the same
 *    effect hash, which is what makes commit-time re-verification meaningful.
 *
 * `capturedAt` is the logical read point. The API layer produces snapshots inside a
 * single REPEATABLE READ transaction so the contents are mutually consistent.
 */
export interface StateSnapshot {
  tenant: Tenant;
  capturedAt: string;
  /** Max `version` across the entities in this snapshot; carried into the plan. */
  snapshotVersion: number;

  customers: readonly Customer[];
  orders: readonly Order[];
  payments: readonly Payment[];
  refunds: readonly Refund[];
  disputes: readonly Dispute[];
  subscriptions: readonly Subscription[];
  paymentMethods: readonly PaymentMethod[];
  processorAccounts: readonly ProcessorAccount[];
}

export interface SnapshotIndex {
  order(id: string): Order | undefined;
  payment(id: string): Payment | undefined;
  subscription(id: string): Subscription | undefined;
  customer(id: string): Customer | undefined;
  paymentMethod(id: string): PaymentMethod | undefined;
  processorAccount(id: string): ProcessorAccount | undefined;
  paymentsForOrder(orderId: string): Payment[];
  refundsForOrder(orderId: string): Refund[];
  disputesForOrder(orderId: string): Dispute[];
}

export function indexSnapshot(s: StateSnapshot): SnapshotIndex {
  const byId = <T extends { id: string }>(xs: readonly T[]): Map<string, T> =>
    new Map(xs.map((x) => [x.id as string, x]));

  const orders = byId(s.orders);
  const payments = byId(s.payments);
  const subscriptions = byId(s.subscriptions);
  const customers = byId(s.customers);
  const paymentMethods = byId(s.paymentMethods);
  const processorAccounts = byId(s.processorAccounts);

  return {
    order: (id) => orders.get(id),
    payment: (id) => payments.get(id),
    subscription: (id) => subscriptions.get(id),
    customer: (id) => customers.get(id),
    paymentMethod: (id) => paymentMethods.get(id),
    processorAccount: (id) => processorAccounts.get(id),
    paymentsForOrder: (orderId) => s.payments.filter((p) => p.orderId === orderId),
    refundsForOrder: (orderId) => s.refunds.filter((r) => r.orderId === orderId),
    disputesForOrder: (orderId) => s.disputes.filter((d) => d.orderId === orderId),
  };
}

/** Tenant scoping is enforced at compile time, not only at query time. Any entity in a
 *  snapshot whose tenant does not match is a bug in the loader or an attack; either way
 *  the compiler must refuse rather than silently include it. */
export function foreignTenantEntities(s: StateSnapshot): string[] {
  const t: TenantId = s.tenant.id;
  const bad: string[] = [];
  const check = (kind: string, xs: readonly { id: string; tenantId: TenantId }[]) => {
    for (const x of xs) if (x.tenantId !== t) bad.push(`${kind}:${x.id}`);
  };
  check('customer', s.customers);
  check('order', s.orders);
  check('payment', s.payments);
  check('refund', s.refunds);
  check('dispute', s.disputes);
  check('subscription', s.subscriptions);
  check('payment_method', s.paymentMethods);
  check('processor_account', s.processorAccounts);
  return bad;
}

export function snapshotCurrency(s: StateSnapshot): Currency {
  return s.tenant.defaultCurrency;
}
