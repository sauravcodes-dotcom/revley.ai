import type { Currency, Money } from '../money';
import { add, money, sub, sum, zero } from '../money';
import type { Dispute, Payment, Refund } from '../domain/entities';
import type { SnapshotIndex } from '../domain/snapshot';

/**
 * Derived balances for an order.
 *
 * Two decisions here are worth stating explicitly because they are where naive
 * implementations get this wrong:
 *
 *  1. `refunded` counts refunds in state `pending` as well as `succeeded`. A refund that
 *     has been submitted to the processor but not yet confirmed has already committed
 *     the money. Excluding it lets two concurrent refund proposals each see the full
 *     balance and both pass, which is the classic double-refund bug.
 *
 *  2. `refundable` is capped at zero rather than allowed to go negative. A negative
 *     refundable balance means the ledger is already inconsistent; that is a
 *     reconciliation problem to surface, not a number to do arithmetic with.
 */
export interface OrderBalances {
  currency: Currency;
  captured: Money;
  refunded: Money;
  refundable: Money;
  authorizedUncaptured: Money;
  openDisputes: Dispute[];
  disputedAmount: Money;
  /** True when the ledger is in a state that should never occur; blocks all actions. */
  inconsistent: boolean;
}

const ACTIVE_REFUND_STATES = new Set(['pending', 'succeeded']);
const OPEN_DISPUTE_STATES = new Set(['open', 'under_review']);

export function orderBalances(
  orderId: string,
  currency: Currency,
  idx: SnapshotIndex,
): OrderBalances {
  const payments = idx.paymentsForOrder(orderId);
  const refunds = idx.refundsForOrder(orderId);
  const disputes = idx.disputesForOrder(orderId);

  const captured = sum(
    payments.map((p) => p.captured),
    currency,
  );
  const authorizedUncaptured = sum(
    payments
      .filter((p) => p.state === 'requires_capture')
      .map((p) => sub(p.authorized, p.captured)),
    currency,
  );
  const refunded = sum(
    refunds.filter((r) => ACTIVE_REFUND_STATES.has(r.state)).map((r) => r.amount),
    currency,
  );
  const openDisputes = disputes.filter((d) => OPEN_DISPUTE_STATES.has(d.state));
  const disputedAmount = sum(
    openDisputes.map((d) => d.amount),
    currency,
  );

  const rawRefundable = sub(captured, refunded);
  const inconsistent = rawRefundable.minor < 0;

  return {
    currency,
    captured,
    refunded,
    refundable: inconsistent ? zero(currency) : rawRefundable,
    authorizedUncaptured,
    openDisputes,
    disputedAmount,
    inconsistent,
  };
}

export interface PaymentAllocation {
  payment: Payment;
  amount: Money;
  remainingAfter: Money;
}

/**
 * Allocate a refund across the order's captured payments.
 *
 * Orders in the real world are not always paid by a single charge: a split tender, a
 * retried capture, or a subscription order with an applied credit can produce several
 * payments. A refund is executed against specific captures, so the plan has to say which
 * ones -- both because the processor call needs a charge reference and because the
 * per-payment refundable ceiling is what actually constrains the total.
 *
 * Allocation is oldest-capture-first, which is deterministic and matches how processors
 * age out refund eligibility.
 */
export function allocateRefund(
  amount: Money,
  orderId: string,
  idx: SnapshotIndex,
): { allocations: PaymentAllocation[]; unallocated: Money } {
  const refunds = idx.refundsForOrder(orderId).filter((r) => ACTIVE_REFUND_STATES.has(r.state));
  const refundedByPayment = new Map<string, number>();
  for (const r of refunds) {
    refundedByPayment.set(r.paymentId, (refundedByPayment.get(r.paymentId) ?? 0) + r.amount.minor);
  }

  const candidates = idx
    .paymentsForOrder(orderId)
    .filter((p) => p.captured.minor > 0)
    .filter((p) => p.state !== 'voided' && p.state !== 'failed')
    .sort((a, b) => (a.capturedAt ?? a.authorizedAt).localeCompare(b.capturedAt ?? b.authorizedAt));

  const allocations: PaymentAllocation[] = [];
  let remaining = amount.minor;

  for (const p of candidates) {
    if (remaining <= 0) break;
    const alreadyRefunded = refundedByPayment.get(p.id) ?? 0;
    const capacity = p.captured.minor - alreadyRefunded;
    if (capacity <= 0) continue;
    const take = Math.min(capacity, remaining);
    allocations.push({
      payment: p,
      amount: money(take, amount.currency),
      remainingAfter: money(capacity - take, amount.currency),
    });
    remaining -= take;
  }

  return { allocations, unallocated: money(remaining, amount.currency) };
}

/** Refund total for a single payment, counting pending refunds. See `orderBalances`. */
export function refundedForPayment(
  paymentId: string,
  currency: Currency,
  refunds: readonly Refund[],
): Money {
  return refunds
    .filter((r) => r.paymentId === paymentId && ACTIVE_REFUND_STATES.has(r.state))
    .reduce((acc, r) => add(acc, r.amount), zero(currency));
}

export function isOpenDispute(d: Dispute): boolean {
  return OPEN_DISPUTE_STATES.has(d.state);
}
