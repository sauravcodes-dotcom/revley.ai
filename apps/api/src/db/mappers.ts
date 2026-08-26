import {
  asId,
  money,
  type Currency,
  type Customer,
  type Dispute,
  type Order,
  type Payment,
  type PaymentMethod,
  type ProcessorAccount,
  type ProcessorName,
  type Refund,
  type Subscription,
  type Tenant,
} from '@warrant/core';
import type {
  DisputeState,
  OrderState,
  PaymentState,
  RefundState,
  SubscriptionState,
} from '@warrant/core';

/**
 * Row-to-domain mappers.
 *
 * `pg` returns BIGINT as a string to avoid silently truncating values beyond 2^53. That
 * is the right default and the mappers keep it: every amount goes through
 * `toMinor`, which parses and range-checks, rather than being coerced with `Number()`
 * at the call site where an out-of-range value would pass unnoticed.
 */

export function toMinor(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${field} is not a safe integer: ${String(value)}`);
  }
  return n;
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

const isoOrUndefined = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : iso(value);

export interface TenantRow {
  id: string;
  name: string;
  default_currency: string;
}

export const toTenant = (r: TenantRow): Tenant => ({
  id: asId(r.id),
  name: r.name,
  // CHAR(3) is blank-padded by Postgres on comparison but not on read; trim defensively.
  defaultCurrency: r.default_currency.trim() as Currency,
});

export const toCustomer = (r: { id: string; tenant_id: string; email: string }): Customer => ({
  id: asId(r.id),
  tenantId: asId(r.tenant_id),
  email: r.email,
});

export const toProcessorAccount = (r: {
  id: string;
  tenant_id: string;
  processor: string;
  healthy: boolean;
  accepts_new_volume: boolean;
  supported_currencies: string[];
}): ProcessorAccount => ({
  id: asId(r.id),
  tenantId: asId(r.tenant_id),
  processor: r.processor as ProcessorName,
  healthy: r.healthy,
  acceptsNewVolume: r.accepts_new_volume,
  supportedCurrencies: r.supported_currencies.map((c) => c.trim() as Currency),
});

export const toPaymentMethod = (r: {
  id: string;
  tenant_id: string;
  customer_id: string;
  vault_token: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  processor_tokens: Record<string, string>;
}): PaymentMethod => ({
  id: asId(r.id),
  tenantId: asId(r.tenant_id),
  customerId: asId(r.customer_id),
  vaultToken: r.vault_token,
  brand: r.brand,
  last4: r.last4.trim(),
  expMonth: r.exp_month,
  expYear: r.exp_year,
  processorTokens: r.processor_tokens,
});

export const toOrder = (r: {
  id: string;
  tenant_id: string;
  customer_id: string;
  state: string;
  total_minor: string;
  currency: string;
  version: number;
  subscription_id: string | null;
  created_at: Date;
}): Order => ({
  id: asId(r.id),
  tenantId: asId(r.tenant_id),
  customerId: asId(r.customer_id),
  state: r.state as OrderState,
  total: money(toMinor(r.total_minor, 'orders.total_minor'), r.currency.trim() as Currency),
  createdAt: iso(r.created_at),
  version: r.version,
  ...(r.subscription_id ? { subscriptionId: asId<never>(r.subscription_id) } : {}),
});

export const toPayment = (r: {
  id: string;
  tenant_id: string;
  order_id: string;
  processor_account_id: string;
  processor: string;
  payment_method_id: string;
  state: string;
  authorized_minor: string;
  captured_minor: string;
  currency: string;
  authorized_at: Date;
  captured_at: Date | null;
  auth_expires_at: Date;
  processor_reference: string;
}): Payment => {
  const currency = r.currency.trim() as Currency;
  return {
    id: asId(r.id),
    tenantId: asId(r.tenant_id),
    orderId: asId(r.order_id),
    processorAccountId: asId(r.processor_account_id),
    processor: r.processor as ProcessorName,
    paymentMethodId: asId(r.payment_method_id),
    state: r.state as PaymentState,
    authorized: money(toMinor(r.authorized_minor, 'payments.authorized_minor'), currency),
    captured: money(toMinor(r.captured_minor, 'payments.captured_minor'), currency),
    authorizedAt: iso(r.authorized_at),
    ...(r.captured_at ? { capturedAt: iso(r.captured_at) } : {}),
    authExpiresAt: iso(r.auth_expires_at),
    processorReference: r.processor_reference,
  };
};

export const toRefund = (r: {
  id: string;
  tenant_id: string;
  order_id: string;
  payment_id: string;
  state: string;
  amount_minor: string;
  currency: string;
  reason: string;
  processor_reference: string | null;
  created_at: Date;
}): Refund => ({
  id: asId(r.id),
  tenantId: asId(r.tenant_id),
  orderId: asId(r.order_id),
  paymentId: asId(r.payment_id),
  state: r.state as RefundState,
  amount: money(toMinor(r.amount_minor, 'refunds.amount_minor'), r.currency.trim() as Currency),
  reason: r.reason,
  createdAt: iso(r.created_at),
  ...(r.processor_reference ? { processorReference: r.processor_reference } : {}),
});

export const toDispute = (r: {
  id: string;
  tenant_id: string;
  order_id: string;
  payment_id: string;
  state: string;
  amount_minor: string;
  currency: string;
  reason: string;
  opened_at: Date;
  respond_by: Date;
}): Dispute => ({
  id: asId(r.id),
  tenantId: asId(r.tenant_id),
  orderId: asId(r.order_id),
  paymentId: asId(r.payment_id),
  state: r.state as DisputeState,
  amount: money(toMinor(r.amount_minor, 'disputes.amount_minor'), r.currency.trim() as Currency),
  reason: r.reason,
  openedAt: iso(r.opened_at),
  respondBy: iso(r.respond_by),
});

export const toSubscription = (r: {
  id: string;
  tenant_id: string;
  customer_id: string;
  state: string;
  amount_minor: string;
  currency: string;
  interval_days: number;
  current_period_end: Date;
  payment_method_id: string;
}): Subscription => ({
  id: asId(r.id),
  tenantId: asId(r.tenant_id),
  customerId: asId(r.customer_id),
  state: r.state as SubscriptionState,
  amount: money(
    toMinor(r.amount_minor, 'subscriptions.amount_minor'),
    r.currency.trim() as Currency,
  ),
  intervalDays: r.interval_days,
  currentPeriodEnd: iso(r.current_period_end),
  paymentMethodId: asId(r.payment_method_id),
});

export { iso, isoOrUndefined };
