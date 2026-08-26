import type { Currency, Money } from '../money';
import type {
  CustomerId,
  DisputeId,
  OrderId,
  PaymentId,
  PaymentMethodId,
  ProcessorAccountId,
  RefundId,
  SubscriptionId,
  TenantId,
} from './ids';
import type {
  DisputeState,
  OrderState,
  PaymentState,
  RefundState,
  SubscriptionState,
} from './states';

export type ProcessorName = 'stripe' | 'adyen' | 'airwallex' | 'braintree';

export interface Tenant {
  id: TenantId;
  name: string;
  defaultCurrency: Currency;
}

export interface Customer {
  id: CustomerId;
  tenantId: TenantId;
  email: string;
}

export interface ProcessorAccount {
  id: ProcessorAccountId;
  tenantId: TenantId;
  processor: ProcessorName;
  /** Operational health, maintained by the circuit breaker in apps/api. */
  healthy: boolean;
  supportedCurrencies: readonly Currency[];
  /** Whether this account can accept new authorizations. A processor that is winding
   *  down still accepts refunds against existing payments but takes no new volume. */
  acceptsNewVolume: boolean;
}

/**
 * A stored payment credential. The token is merchant-owned: `vaultToken` is the
 * identifier in the merchant's own vault, and `processorTokens` maps each processor to
 * the credential it issued for the same underlying instrument. This is the shape that
 * makes processor portability possible, and it is why a refund can be pinned to the
 * processor that captured the original payment while a *new* charge is free to route.
 */
export interface PaymentMethod {
  id: PaymentMethodId;
  tenantId: TenantId;
  customerId: CustomerId;
  vaultToken: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  processorTokens: Readonly<Partial<Record<ProcessorName, string>>>;
}

export interface Order {
  id: OrderId;
  tenantId: TenantId;
  customerId: CustomerId;
  state: OrderState;
  total: Money;
  createdAt: string;
  /** Monotonic counter bumped on every state-affecting write. Used for optimistic
   *  concurrency control and to detect that a snapshot has gone stale. */
  version: number;
  subscriptionId?: SubscriptionId;
}

export interface Payment {
  id: PaymentId;
  tenantId: TenantId;
  orderId: OrderId;
  processorAccountId: ProcessorAccountId;
  processor: ProcessorName;
  paymentMethodId: PaymentMethodId;
  state: PaymentState;
  /** Amount authorized by the issuer. */
  authorized: Money;
  /** Amount actually captured so far. Never exceeds `authorized`. */
  captured: Money;
  authorizedAt: string;
  capturedAt?: string;
  /** Issuer authorization expiry. Capturing after this fails at the network. */
  authExpiresAt: string;
  processorReference: string;
}

export interface Refund {
  id: RefundId;
  tenantId: TenantId;
  orderId: OrderId;
  paymentId: PaymentId;
  state: RefundState;
  amount: Money;
  reason: string;
  createdAt: string;
  processorReference?: string;
}

export interface Dispute {
  id: DisputeId;
  tenantId: TenantId;
  orderId: OrderId;
  paymentId: PaymentId;
  state: DisputeState;
  amount: Money;
  reason: string;
  openedAt: string;
  /** Deadline for submitting evidence. */
  respondBy: string;
}

export interface Subscription {
  id: SubscriptionId;
  tenantId: TenantId;
  customerId: CustomerId;
  state: SubscriptionState;
  amount: Money;
  intervalDays: number;
  currentPeriodEnd: string;
  paymentMethodId: PaymentMethodId;
}
