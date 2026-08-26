/**
 * Entity state machines.
 *
 * Two properties matter here beyond "which transitions are legal":
 *
 *  1. `rank` gives every state a monotonic position. Processor webhooks arrive out of
 *     order and duplicated; the event applier uses rank to reject a *regression*
 *     (a `payment.captured` arriving after `payment.refunded`) without needing to know
 *     the delivery order. See docs/ARCHITECTURE.md#out-of-order-events.
 *  2. Terminal states absorb. Once an entity is terminal, no event moves it, which is
 *     what makes replayed webhooks safe.
 */

export type OrderState =
  | 'pending'
  | 'authorized'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'disputed'
  | 'cancelled';

export type PaymentState =
  | 'requires_capture'
  | 'captured'
  | 'partially_refunded'
  | 'refunded'
  | 'voided'
  | 'failed'
  | 'disputed';

export type RefundState = 'pending' | 'succeeded' | 'failed' | 'cancelled';

export type DisputeState = 'open' | 'under_review' | 'won' | 'lost' | 'accepted';

export type SubscriptionState = 'active' | 'past_due' | 'paused' | 'cancelled' | 'expired';

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly initial: S;
  readonly transitions: Readonly<Record<S, readonly S[]>>;
  readonly terminal: readonly S[];
  readonly rank: Readonly<Record<S, number>>;
}

export const ORDER_SM: StateMachine<OrderState> = {
  name: 'order',
  initial: 'pending',
  transitions: {
    pending: ['authorized', 'paid', 'cancelled'],
    authorized: ['paid', 'cancelled'],
    paid: ['partially_refunded', 'refunded', 'disputed'],
    partially_refunded: ['partially_refunded', 'refunded', 'disputed'],
    refunded: ['disputed'],
    disputed: ['disputed'],
    cancelled: [],
  },
  terminal: ['cancelled'],
  rank: {
    pending: 0,
    authorized: 1,
    paid: 2,
    partially_refunded: 3,
    refunded: 4,
    disputed: 5,
    cancelled: 6,
  },
};

export const PAYMENT_SM: StateMachine<PaymentState> = {
  name: 'payment',
  initial: 'requires_capture',
  transitions: {
    requires_capture: ['captured', 'voided', 'failed'],
    captured: ['partially_refunded', 'refunded', 'disputed'],
    partially_refunded: ['partially_refunded', 'refunded', 'disputed'],
    refunded: ['disputed'],
    voided: [],
    failed: [],
    disputed: ['disputed'],
  },
  terminal: ['voided', 'failed'],
  rank: {
    requires_capture: 0,
    captured: 1,
    partially_refunded: 2,
    refunded: 3,
    disputed: 4,
    voided: 5,
    failed: 6,
  },
};

export const REFUND_SM: StateMachine<RefundState> = {
  name: 'refund',
  initial: 'pending',
  transitions: {
    pending: ['succeeded', 'failed', 'cancelled'],
    succeeded: [],
    failed: [],
    cancelled: [],
  },
  terminal: ['succeeded', 'failed', 'cancelled'],
  rank: { pending: 0, succeeded: 1, failed: 2, cancelled: 3 },
};

export const DISPUTE_SM: StateMachine<DisputeState> = {
  name: 'dispute',
  initial: 'open',
  transitions: {
    open: ['under_review', 'won', 'lost', 'accepted'],
    under_review: ['won', 'lost', 'accepted'],
    won: [],
    lost: [],
    accepted: [],
  },
  terminal: ['won', 'lost', 'accepted'],
  rank: { open: 0, under_review: 1, won: 2, lost: 3, accepted: 4 },
};

export const SUBSCRIPTION_SM: StateMachine<SubscriptionState> = {
  name: 'subscription',
  initial: 'active',
  transitions: {
    active: ['past_due', 'paused', 'cancelled', 'expired'],
    past_due: ['active', 'cancelled', 'expired'],
    paused: ['active', 'cancelled', 'expired'],
    cancelled: [],
    expired: [],
  },
  terminal: ['cancelled', 'expired'],
  rank: { active: 0, past_due: 1, paused: 2, cancelled: 3, expired: 4 },
};

export function canTransition<S extends string>(sm: StateMachine<S>, from: S, to: S): boolean {
  return (sm.transitions[from] ?? []).includes(to);
}

export function isTerminal<S extends string>(sm: StateMachine<S>, state: S): boolean {
  return sm.terminal.includes(state);
}

/**
 * True when moving `from -> to` would move an entity *backwards* through its lifecycle.
 * Used by the webhook applier to discard stale events that arrive after newer ones.
 */
export function isRegression<S extends string>(sm: StateMachine<S>, from: S, to: S): boolean {
  return sm.rank[to] < sm.rank[from];
}
