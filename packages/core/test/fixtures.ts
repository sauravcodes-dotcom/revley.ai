import { generateKeyPairSync } from 'node:crypto';
import type {
  Capability,
  Currency,
  Customer,
  Dispute,
  Intent,
  Order,
  Payment,
  PaymentMethod,
  ProcessorAccount,
  ProcessorName,
  Refund,
  StateSnapshot,
  Subscription,
  Tenant,
} from '../src';
import { asId, money } from '../src';
import type {
  DisputeState,
  OrderState,
  PaymentState,
  RefundState,
  SubscriptionState,
} from '../src/domain/states';
import type { ActionParams } from '../src/compiler/actions';

export const USD: Currency = 'USD';
export const T0 = '2026-03-01T12:00:00.000Z';

export const TENANT_A = 'ten_a';
export const TENANT_B = 'ten_b';

export function tenant(id = TENANT_A, currency: Currency = USD): Tenant {
  return { id: asId(id), name: `tenant ${id}`, defaultCurrency: currency };
}

export function customer(id = 'cus_1', tenantId = TENANT_A): Customer {
  return { id: asId(id), tenantId: asId(tenantId), email: `${id}@example.test` };
}

export function processorAccount(
  id = 'pa_stripe',
  processor: ProcessorName = 'stripe',
  overrides: Partial<ProcessorAccount> = {},
): ProcessorAccount {
  return {
    id: asId(id),
    tenantId: asId(TENANT_A),
    processor,
    healthy: true,
    supportedCurrencies: [USD],
    acceptsNewVolume: true,
    ...overrides,
  };
}

export function paymentMethod(id = 'pm_1'): PaymentMethod {
  return {
    id: asId(id),
    tenantId: asId(TENANT_A),
    customerId: asId('cus_1'),
    vaultToken: 'vault_tok_abc',
    brand: 'visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2030,
    processorTokens: { stripe: 'pm_stripe_1', adyen: 'pm_adyen_1' },
  };
}

export function order(
  id = 'ord_1',
  overrides: Partial<Order> & { state?: OrderState } = {},
): Order {
  return {
    id: asId(id),
    tenantId: asId(TENANT_A),
    customerId: asId('cus_1'),
    state: 'paid',
    total: money(10_000, USD),
    createdAt: '2026-02-20T10:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

export function payment(
  id = 'pay_1',
  overrides: Partial<Payment> & { state?: PaymentState } = {},
): Payment {
  return {
    id: asId(id),
    tenantId: asId(TENANT_A),
    orderId: asId('ord_1'),
    processorAccountId: asId('pa_stripe'),
    processor: 'stripe',
    paymentMethodId: asId('pm_1'),
    state: 'captured',
    authorized: money(10_000, USD),
    captured: money(10_000, USD),
    authorizedAt: '2026-02-20T10:00:00.000Z',
    capturedAt: '2026-02-20T10:05:00.000Z',
    authExpiresAt: '2026-02-27T10:00:00.000Z',
    processorReference: 'ch_stripe_1',
    ...overrides,
  };
}

export function refund(
  id = 'ref_1',
  amountMinor = 2_000,
  overrides: Partial<Refund> & { state?: RefundState } = {},
): Refund {
  return {
    id: asId(id),
    tenantId: asId(TENANT_A),
    orderId: asId('ord_1'),
    paymentId: asId('pay_1'),
    state: 'succeeded',
    amount: money(amountMinor, USD),
    reason: 'customer request',
    createdAt: '2026-02-25T10:00:00.000Z',
    ...overrides,
  };
}

export function dispute(
  id = 'dis_1',
  overrides: Partial<Dispute> & { state?: DisputeState } = {},
): Dispute {
  return {
    id: asId(id),
    tenantId: asId(TENANT_A),
    orderId: asId('ord_1'),
    paymentId: asId('pay_1'),
    state: 'open',
    amount: money(10_000, USD),
    reason: 'product_not_received',
    openedAt: '2026-02-28T09:00:00.000Z',
    respondBy: '2026-03-10T09:00:00.000Z',
    ...overrides,
  };
}

export function subscription(
  id = 'sub_1',
  overrides: Partial<Subscription> & { state?: SubscriptionState } = {},
): Subscription {
  return {
    id: asId(id),
    tenantId: asId(TENANT_A),
    customerId: asId('cus_1'),
    state: 'active',
    amount: money(4_900, USD),
    intervalDays: 30,
    currentPeriodEnd: '2026-03-23T00:00:00.000Z',
    paymentMethodId: asId('pm_1'),
    ...overrides,
  };
}

export interface SnapshotParts {
  tenant?: Tenant;
  customers?: Customer[];
  orders?: Order[];
  payments?: Payment[];
  refunds?: Refund[];
  disputes?: Dispute[];
  subscriptions?: Subscription[];
  paymentMethods?: PaymentMethod[];
  processorAccounts?: ProcessorAccount[];
  capturedAt?: string;
  snapshotVersion?: number;
}

/** A fully paid $100 order with a single captured Stripe payment and no refunds. */
export function snapshot(parts: SnapshotParts = {}): StateSnapshot {
  return {
    tenant: parts.tenant ?? tenant(),
    capturedAt: parts.capturedAt ?? T0,
    snapshotVersion: parts.snapshotVersion ?? 1,
    customers: parts.customers ?? [customer()],
    orders: parts.orders ?? [order()],
    payments: parts.payments ?? [payment()],
    refunds: parts.refunds ?? [],
    disputes: parts.disputes ?? [],
    subscriptions: parts.subscriptions ?? [],
    paymentMethods: parts.paymentMethods ?? [paymentMethod()],
    processorAccounts: parts.processorAccounts ?? [processorAccount()],
  };
}

let intentCounter = 0;

export function intent(
  action: ActionParams,
  overrides: Partial<Intent> = {},
): Intent {
  intentCounter += 1;
  return {
    id: `int_${intentCounter}`,
    tenantId: TENANT_A,
    sessionId: 'ses_1',
    action,
    rationale: 'test intent',
    provenance: { sources: ['operator'], containsUntrustedContent: false },
    createdAt: T0,
    ...overrides,
  };
}

export const refundIntent = (
  amountMinor: number,
  orderId = 'ord_1',
  overrides: Partial<Intent> = {},
): Intent =>
  intent(
    {
      kind: 'refund.issue',
      params: { orderId, amountMinor, currency: USD, reason: 'customer request' },
    },
    overrides,
  );

export const captureIntent = (
  amountMinor: number,
  paymentId = 'pay_1',
  overrides: Partial<Intent> = {},
): Intent =>
  intent(
    { kind: 'payment.capture', params: { paymentId, amountMinor, currency: USD } },
    overrides,
  );

export const voidIntent = (paymentId = 'pay_1', overrides: Partial<Intent> = {}): Intent =>
  intent({ kind: 'payment.void', params: { paymentId, reason: 'order cancelled' } }, overrides);

export const cancelIntent = (
  subscriptionId = 'sub_1',
  atPeriodEnd = false,
  overrides: Partial<Intent> = {},
): Intent =>
  intent(
    {
      kind: 'subscription.cancel',
      params: { subscriptionId, atPeriodEnd, reason: 'customer request' },
    },
    overrides,
  );

export const COMPILE_OPTS = { planId: 'plan_test', now: T0 };

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

export function keypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function capability(overrides: Partial<Capability> = {}): Capability {
  return {
    capId: 'cap_1',
    tenantId: TENANT_A,
    sessionId: 'ses_1',
    subject: 'agent:support',
    actions: ['refund.issue', 'payment.capture', 'payment.void', 'subscription.cancel'],
    scope: {
      orders: ['ord_1'],
      payments: ['pay_1'],
      subscriptions: ['sub_1'],
      customers: ['cus_1'],
    },
    limits: {
      currency: USD,
      perActionMaxMinor: 20_000,
      sessionBudgetMinor: 50_000,
      dailyBudgetMinor: 200_000,
      maxDeniedAttempts: 3,
    },
    autoApproveBelowMinor: 2_500,
    alwaysApprove: [],
    issuedAt: '2026-03-01T11:00:00.000Z',
    notAfter: '2026-03-01T13:00:00.000Z',
    nonce: 'nonce_1',
    ...overrides,
  };
}
