/**
 * Branded identifier types.
 *
 * These are compile-time only, but they make the most dangerous class of bug in a
 * multi-tenant financial system -- passing an id from one entity or tenant where
 * another was expected -- a type error instead of a runtime data leak.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, 'TenantId'>;
export type CustomerId = Brand<string, 'CustomerId'>;
export type OrderId = Brand<string, 'OrderId'>;
export type PaymentId = Brand<string, 'PaymentId'>;
export type RefundId = Brand<string, 'RefundId'>;
export type DisputeId = Brand<string, 'DisputeId'>;
export type SubscriptionId = Brand<string, 'SubscriptionId'>;
export type ProcessorAccountId = Brand<string, 'ProcessorAccountId'>;
export type PaymentMethodId = Brand<string, 'PaymentMethodId'>;
export type IntentId = Brand<string, 'IntentId'>;
export type PlanId = Brand<string, 'PlanId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type CapabilityId = Brand<string, 'CapabilityId'>;

/** Unsafe cast used at trust boundaries (DB rows, HTTP bodies) after validation. */
export const asId = <T extends string>(value: string): T => value as T;
