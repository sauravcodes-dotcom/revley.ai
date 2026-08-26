import type { ActionParams, Currency } from '@warrant/core';
import { isActionKind } from '@warrant/core';

/**
 * Rebuild a typed `ActionParams` from the loosely typed JSONB that came back from the
 * database, or from a validated tool call.
 *
 * The temptation is to cast: the row was written from a valid `ActionParams`, so it must
 * still be one. That reasoning holds right up until a migration, a manual UPDATE, or a
 * future action kind makes it false, at which point the cast turns a data problem into an
 * undefined-property crash somewhere much further downstream. Parsing costs a switch
 * statement and turns the same problem into a null at the boundary.
 */
export function toActionParams(
  kind: unknown,
  params: Record<string, unknown>,
): ActionParams | null {
  if (!isActionKind(kind)) return null;

  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const int = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) ? v : null;
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const cur = (v: unknown): Currency | null =>
    typeof v === 'string' && ['USD', 'EUR', 'GBP', 'CAD', 'AUD'].includes(v)
      ? (v as Currency)
      : null;

  switch (kind) {
    case 'refund.issue': {
      const orderId = str(params.orderId);
      const amountMinor = int(params.amountMinor);
      const currency = cur(params.currency);
      const reason = str(params.reason);
      if (orderId === null || amountMinor === null || currency === null || reason === null) {
        return null;
      }
      return { kind, params: { orderId, amountMinor, currency, reason } };
    }
    case 'payment.capture': {
      const paymentId = str(params.paymentId);
      const amountMinor = int(params.amountMinor);
      const currency = cur(params.currency);
      if (paymentId === null || amountMinor === null || currency === null) return null;
      return { kind, params: { paymentId, amountMinor, currency } };
    }
    case 'payment.void': {
      const paymentId = str(params.paymentId);
      const reason = str(params.reason);
      if (paymentId === null || reason === null) return null;
      return { kind, params: { paymentId, reason } };
    }
    case 'subscription.cancel': {
      const subscriptionId = str(params.subscriptionId);
      const atPeriodEnd = bool(params.atPeriodEnd);
      const reason = str(params.reason);
      if (subscriptionId === null || atPeriodEnd === null || reason === null) return null;
      return { kind, params: { subscriptionId, atPeriodEnd, reason } };
    }
  }
}

/** Which entity a snapshot must be centred on for this action. */
export function focusForActionParams(action: ActionParams): {
  orderId?: string;
  paymentId?: string;
  subscriptionId?: string;
} {
  switch (action.kind) {
    case 'refund.issue':
      return { orderId: action.params.orderId };
    case 'payment.capture':
    case 'payment.void':
      return { paymentId: action.params.paymentId };
    case 'subscription.cancel':
      return { subscriptionId: action.params.subscriptionId };
  }
}
