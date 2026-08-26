import type { Currency } from '../money';
import { format, money, sub, zero } from '../money';
import type { Payment } from '../domain/entities';
import { foreignTenantEntities, indexSnapshot, type StateSnapshot } from '../domain/snapshot';
import type { SnapshotIndex } from '../domain/snapshot';
import { digest } from '../hash/canonical';
import type { ActionKind, Intent } from './actions';
import { allocateRefund, orderBalances } from './derive';
import {
  check,
  currencyMatch,
  ledgerBalanced,
  positiveAmount,
  tenantIsolation,
  transitionsLegal,
  warn,
} from './invariants';
import type {
  EffectPlan,
  InvariantResult,
  LedgerDelta,
  PlanTotals,
  Precondition,
  ResourceRef,
  RiskFlag,
  Route,
  Transition,
} from './plan';

export interface CompilerPolicy {
  /** Above this notional amount a plan carries the `high_value` risk flag. */
  highValueMinor: number;
  /** Within this many hours of authorization expiry, captures are flagged. */
  authExpiringSoonHours: number;
}

export const DEFAULT_POLICY: CompilerPolicy = {
  highValueMinor: 50_000,
  authExpiringSoonHours: 24,
};

export interface CompileOptions {
  /**
   * Supplied by the caller rather than generated here. `compile` must be a pure
   * function of its inputs: same intent plus same snapshot must produce the same plan,
   * byte for byte, or commit-time re-verification would report divergence on every run.
   */
  planId: string;
  now: string;
  policy?: CompilerPolicy;
}

export type CompileFailureCode =
  | 'TENANT_MISMATCH'
  | 'RESOURCE_NOT_FOUND'
  | 'UNSUPPORTED_ACTION'
  | 'MALFORMED_PARAMS';

export interface CompileFailure {
  ok: false;
  code: CompileFailureCode;
  message: string;
}

export type CompileResult = { ok: true; plan: EffectPlan } | CompileFailure;

const failure = (code: CompileFailureCode, message: string): CompileFailure => ({
  ok: false,
  code,
  message,
});

interface Draft {
  ledger: LedgerDelta[];
  transitions: Transition[];
  route: Route | null;
  totals: PlanTotals;
  resources: ResourceRef[];
  invariants: InvariantResult[];
  preconditions: Precondition[];
  riskFlags: RiskFlag[];
}

/**
 * Compile a proposed action into a fully specified financial effect.
 *
 * This function is the centre of the system. It is pure, total over its declared error
 * cases, and has no access to a database, a clock or a network. Everything downstream --
 * authorization, human approval, the idempotency key, the audit record, and the
 * commit-time divergence check -- operates on its output rather than on the model's
 * request. That is the whole idea: the unit of authorization is the computed effect, not
 * the sentence the model produced.
 *
 * A note on error handling. Structural problems (unknown resource, malformed params)
 * return a failure. *Policy* problems -- refund exceeds captured, dispute is open,
 * transition is illegal -- return a plan with `admissible: false` and the failing
 * invariants attached. Rejected plans are still real objects that get stored, audited
 * and counted, because discarding them would erase exactly the evidence that makes a
 * prompt-injection attempt visible after the fact.
 */
export function compile(
  intent: Intent,
  snapshot: StateSnapshot,
  options: CompileOptions,
): CompileResult {
  if (intent.tenantId !== (snapshot.tenant.id as string)) {
    return failure(
      'TENANT_MISMATCH',
      `intent tenant ${intent.tenantId} does not match snapshot tenant ${snapshot.tenant.id}`,
    );
  }

  const policy = options.policy ?? DEFAULT_POLICY;
  const idx = indexSnapshot(snapshot);
  const currency = snapshot.tenant.defaultCurrency;

  let draft: Draft | CompileFailure;
  switch (intent.action.kind) {
    case 'refund.issue':
      draft = compileRefund(intent, snapshot, idx, currency, policy, options);
      break;
    case 'payment.capture':
      draft = compileCapture(intent, idx, currency, policy, options);
      break;
    case 'payment.void':
      draft = compileVoid(intent, idx, currency, policy);
      break;
    case 'subscription.cancel':
      draft = compileSubscriptionCancel(intent, idx, currency, policy, options);
      break;
    default:
      return failure(
        'UNSUPPORTED_ACTION',
        `unsupported action: ${String((intent.action as { kind: string }).kind)}`,
      );
  }

  if ('ok' in draft) return draft;

  // Universal invariants applied to every plan regardless of action.
  const invariants: InvariantResult[] = [
    ...draft.invariants,
    ledgerBalanced(draft.ledger),
    transitionsLegal(draft.transitions),
    tenantIsolation(foreignTenantEntities(snapshot)),
  ];

  if (intent.provenance.containsUntrustedContent) {
    draft.riskFlags.push('untrusted_content_in_context');
  }
  if (draft.totals.notional.minor >= policy.highValueMinor) {
    draft.riskFlags.push('high_value');
  }

  const action: ActionKind = intent.action.kind;

  const effectHash = digest('warrant.effect.v1', {
    action,
    tenantId: intent.tenantId,
    ledger: [...draft.ledger]
      .map((d) => ({
        account: d.account,
        entityRef: d.entityRef,
        currency: d.amount.currency,
        minor: d.amount.minor,
      }))
      .sort((a, b) =>
        `${a.account}|${a.entityRef}|${a.minor}`.localeCompare(`${b.account}|${b.entityRef}|${b.minor}`),
      ),
    transitions: [...draft.transitions]
      .map((t) => ({
        entity: t.entity,
        id: t.id,
        from: t.from,
        to: t.to,
        effectiveAt: t.effectiveAt,
      }))
      .sort((a, b) => `${a.entity}|${a.id}|${a.to}`.localeCompare(`${b.entity}|${b.id}|${b.to}`)),
    resources: [...draft.resources]
      .map((r) => `${r.kind}:${r.id}`)
      .sort(),
    totals: {
      merchantOutflowMinor: draft.totals.merchantOutflow.minor,
      customerReceivesMinor: draft.totals.customerReceives.minor,
      notionalMinor: draft.totals.notional.minor,
      currency: draft.totals.notional.currency,
    },
  });

  const routeHash = digest('warrant.route.v1', {
    processorAccountId: draft.route?.processorAccountId ?? null,
    processor: draft.route?.processor ?? null,
  });

  const plan: EffectPlan = {
    planId: options.planId,
    tenantId: intent.tenantId,
    intentId: intent.id,
    action,
    ledger: draft.ledger,
    transitions: draft.transitions,
    route: draft.route,
    totals: draft.totals,
    resources: dedupeResources(draft.resources),
    invariants,
    preconditions: draft.preconditions,
    riskFlags: dedupe(draft.riskFlags),
    effectHash,
    routeHash,
    compiledAt: options.now,
    snapshotVersion: snapshot.snapshotVersion,
    admissible: invariants.every((i) => i.ok || i.severity !== 'blocking'),
  };

  return { ok: true, plan };
}

function dedupe<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function dedupeResources(xs: readonly ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  const out: ResourceRef[] = [];
  for (const r of xs) {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

const pre = (id: string, description: string, observed: string | number | boolean): Precondition => ({
  id,
  description,
  observed,
});

// ---------------------------------------------------------------------------
// refund.issue
// ---------------------------------------------------------------------------

function compileRefund(
  intent: Intent,
  snapshot: StateSnapshot,
  idx: SnapshotIndex,
  currency: Currency,
  policy: CompilerPolicy,
  options: CompileOptions,
): Draft | CompileFailure {
  if (intent.action.kind !== 'refund.issue') return failure('MALFORMED_PARAMS', 'expected refund');
  const p = intent.action.params;

  // A cross-tenant order id resolves to "not found" rather than "forbidden", because the
  // snapshot is loaded scoped to the acting tenant. The tenant boundary is enforced by
  // what is loadable, not by a check that could be forgotten -- and an attacker learns
  // nothing about whether the id exists elsewhere.
  const order = idx.order(p.orderId);
  if (!order) return failure('RESOURCE_NOT_FOUND', `order ${p.orderId} not found for tenant`);

  const invariants: InvariantResult[] = [];
  const riskFlags: RiskFlag[] = [];

  invariants.push(positiveAmount(p.amountMinor, currency));
  invariants.push(currencyMatch(p.currency, currency));

  if (!Number.isInteger(p.amountMinor) || p.amountMinor <= 0 || p.currency !== currency) {
    // Cannot build a meaningful ledger from a nonsensical amount; return an inadmissible
    // plan with an empty effect so the attempt is still recorded and counted.
    return emptyDraft(
      currency,
      invariants,
      [pre('order.state', 'order state', order.state)],
      [
        { kind: 'order', id: order.id },
        { kind: 'customer', id: order.customerId as string },
      ],
    );
  }

  const amount = money(p.amountMinor, currency);
  const bal = orderBalances(order.id, currency, idx);

  invariants.push(
    check(
      'LEDGER_CONSISTENT',
      !bal.inconsistent,
      bal.inconsistent
        ? 'recorded refunds already exceed captured amount; order requires reconciliation'
        : 'order ledger is consistent',
    ),
  );

  invariants.push(
    check(
      'REFUND_WITHIN_CAPTURED',
      amount.minor <= bal.refundable.minor,
      `requested ${format(amount)}, refundable ${format(bal.refundable)} ` +
        `(captured ${format(bal.captured)} less ${format(bal.refunded)} already refunded or pending)`,
    ),
  );

  // Refunding an order with an open dispute pays the customer twice: once through the
  // refund and again when the chargeback settles, and most networks will not net the two.
  // This is the single most expensive mistake a support agent can make, human or not.
  invariants.push(
    check(
      'NO_REFUND_WITH_OPEN_DISPUTE',
      bal.openDisputes.length === 0,
      bal.openDisputes.length === 0
        ? 'no open dispute on this order'
        : `order has ${bal.openDisputes.length} open dispute(s) totalling ${format(bal.disputedAmount)}; ` +
          'refunding now risks paying the customer twice',
    ),
  );
  if (bal.openDisputes.length > 0) riskFlags.push('open_dispute_on_order');

  const { allocations, unallocated } = allocateRefund(amount, order.id, idx);

  invariants.push(
    check(
      'REFUND_FULLY_ALLOCATED',
      unallocated.minor === 0,
      unallocated.minor === 0
        ? `allocated across ${allocations.length} payment(s)`
        : `${format(unallocated)} could not be allocated to any captured payment`,
    ),
  );

  const accounts = new Set(allocations.map((a) => a.payment.processorAccountId as string));
  invariants.push(
    check(
      'REFUND_SINGLE_PROCESSOR',
      accounts.size <= 1,
      accounts.size <= 1
        ? 'refund targets a single processor account'
        : `refund would span ${accounts.size} processor accounts (${[...accounts].join(', ')}); ` +
          'issue one refund per payment instead',
    ),
  );

  const ledger: LedgerDelta[] = [];
  const transitions: Transition[] = [];

  if (allocations.length > 0 && unallocated.minor === 0 && accounts.size <= 1) {
    ledger.push({
      account: 'merchant_balance',
      amount: money(-amount.minor, currency),
      entityRef: `order:${order.id}`,
    });
    ledger.push({
      account: 'customer_settlement',
      amount: amount,
      entityRef: `order:${order.id}`,
    });

    for (const a of allocations) {
      const nextPaymentState = a.remainingAfter.minor === 0 ? 'refunded' : 'partially_refunded';
      if (a.payment.state !== nextPaymentState) {
        transitions.push({
          entity: 'payment',
          id: a.payment.id,
          from: a.payment.state,
          to: nextPaymentState,
        });
      }
    }

    const refundedAfter = bal.refunded.minor + amount.minor;
    const nextOrderState = refundedAfter >= bal.captured.minor ? 'refunded' : 'partially_refunded';
    if (order.state !== nextOrderState) {
      transitions.push({ entity: 'order', id: order.id, from: order.state, to: nextOrderState });
    }

    if (refundedAfter >= bal.captured.minor) riskFlags.push('full_order_refund');
    if (bal.refunded.minor > 0) riskFlags.push('refund_after_partial_refunds');
  }

  const primary = allocations[0]?.payment;
  const route: Route | null = primary
    ? {
        processorAccountId: primary.processorAccountId as string,
        processor: primary.processor,
        // Not a routing decision. A refund can only be executed by the processor that
        // holds the original charge, so the "route" is a consequence of the capture.
        reason: 'pinned_to_original_processor',
      }
    : null;

  const preconditions: Precondition[] = [
    pre('order.state', 'order state', order.state),
    pre('order.version', 'order optimistic-concurrency version', order.version),
    pre('order.captured_minor', 'total captured on order', bal.captured.minor),
    pre('order.refunded_minor', 'total refunded or pending on order', bal.refunded.minor),
    pre('order.refundable_minor', 'refundable balance', bal.refundable.minor),
    pre('order.open_disputes', 'number of open disputes', bal.openDisputes.length),
    pre('refund.allocation', 'payments the refund draws from', allocations.map((a) => `${a.payment.id}:${a.amount.minor}`).join(',')),
  ];

  return {
    ledger,
    transitions,
    route,
    resources: [
      { kind: 'order', id: order.id },
      { kind: 'customer', id: order.customerId as string },
      ...allocations.map((a) => ({ kind: 'payment' as const, id: a.payment.id as string })),
    ],
    totals: {
      merchantOutflow: amount,
      customerReceives: amount,
      notional: amount,
    },
    invariants,
    preconditions,
    riskFlags,
  };
}

// ---------------------------------------------------------------------------
// payment.capture
// ---------------------------------------------------------------------------

function compileCapture(
  intent: Intent,
  idx: SnapshotIndex,
  currency: Currency,
  policy: CompilerPolicy,
  options: CompileOptions,
): Draft | CompileFailure {
  if (intent.action.kind !== 'payment.capture') return failure('MALFORMED_PARAMS', 'expected capture');
  const p = intent.action.params;

  const payment = idx.payment(p.paymentId);
  if (!payment) return failure('RESOURCE_NOT_FOUND', `payment ${p.paymentId} not found for tenant`);

  const invariants: InvariantResult[] = [];
  const riskFlags: RiskFlag[] = [];

  invariants.push(positiveAmount(p.amountMinor, currency));
  invariants.push(currencyMatch(p.currency, currency));

  if (!Number.isInteger(p.amountMinor) || p.amountMinor <= 0 || p.currency !== currency) {
    return emptyDraft(
      currency,
      invariants,
      [pre('payment.state', 'payment state', payment.state)],
      paymentResources(payment, idx),
    );
  }

  const amount = money(p.amountMinor, currency);
  const capturable = sub(payment.authorized, payment.captured);

  invariants.push(
    check(
      'PAYMENT_CAPTURABLE',
      payment.state === 'requires_capture',
      `payment state is ${payment.state}` +
        (payment.state === 'requires_capture' ? '' : ', expected requires_capture'),
    ),
  );

  invariants.push(
    check(
      'CAPTURE_WITHIN_AUTHORIZATION',
      amount.minor <= capturable.minor,
      `requested ${format(amount)}, capturable ${format(capturable)} ` +
        `(authorized ${format(payment.authorized)} less ${format(payment.captured)} captured)`,
    ),
  );

  const expired = options.now >= payment.authExpiresAt;
  invariants.push(
    check(
      'AUTHORIZATION_NOT_EXPIRED',
      !expired,
      expired
        ? `authorization expired at ${payment.authExpiresAt}; capture would be declined by the issuer`
        : `authorization valid until ${payment.authExpiresAt}`,
    ),
  );

  const account = idx.processorAccount(payment.processorAccountId as string);
  invariants.push(
    warn(
      'PROCESSOR_ACCOUNT_HEALTHY',
      account?.healthy ?? false,
      account
        ? account.healthy
          ? `processor account ${account.id} is healthy`
          : `processor account ${account.id} is currently unhealthy; capture may fail`
        : `processor account ${payment.processorAccountId} not present in snapshot`,
    ),
  );

  if (hoursUntil(options.now, payment.authExpiresAt) <= policy.authExpiringSoonHours && !expired) {
    riskFlags.push('auth_expiring_soon');
  }

  const ledger: LedgerDelta[] = [];
  const transitions: Transition[] = [];

  if (payment.state === 'requires_capture' && amount.minor <= capturable.minor && !expired) {
    ledger.push({
      account: 'authorized_funds',
      amount: money(-amount.minor, currency),
      entityRef: `payment:${payment.id}`,
    });
    ledger.push({
      account: 'merchant_balance',
      amount,
      entityRef: `payment:${payment.id}`,
    });
    transitions.push({
      entity: 'payment',
      id: payment.id,
      from: payment.state,
      to: 'captured',
    });
    const order = idx.order(payment.orderId as string);
    if (order && (order.state === 'pending' || order.state === 'authorized')) {
      transitions.push({ entity: 'order', id: order.id, from: order.state, to: 'paid' });
    }
  }

  return {
    ledger,
    transitions,
    route: {
      processorAccountId: payment.processorAccountId as string,
      processor: payment.processor,
      reason: 'pinned_to_original_processor',
    },
    resources: paymentResources(payment, idx),
    totals: {
      // A capture moves money toward the merchant. Budgets that bound outflow see zero
      // here; per-action caps still see the notional so an agent cannot capture an
      // arbitrarily large authorization.
      merchantOutflow: zero(currency),
      customerReceives: zero(currency),
      notional: amount,
    },
    invariants,
    preconditions: [
      pre('payment.state', 'payment state', payment.state),
      pre('payment.captured_minor', 'amount already captured', payment.captured.minor),
      pre('payment.capturable_minor', 'remaining capturable', capturable.minor),
      pre('payment.auth_expires_at', 'authorization expiry', payment.authExpiresAt),
    ],
    riskFlags,
  };
}

// ---------------------------------------------------------------------------
// payment.void
// ---------------------------------------------------------------------------

function compileVoid(
  intent: Intent,
  idx: SnapshotIndex,
  currency: Currency,
  policy: CompilerPolicy,
): Draft | CompileFailure {
  if (intent.action.kind !== 'payment.void') return failure('MALFORMED_PARAMS', 'expected void');
  const p = intent.action.params;

  const payment = idx.payment(p.paymentId);
  if (!payment) return failure('RESOURCE_NOT_FOUND', `payment ${p.paymentId} not found for tenant`);

  const invariants: InvariantResult[] = [];
  const held = sub(payment.authorized, payment.captured);

  invariants.push(
    check(
      'PAYMENT_VOIDABLE',
      payment.state === 'requires_capture',
      `payment state is ${payment.state}` +
        (payment.state === 'requires_capture'
          ? ''
          : '; only an uncaptured authorization can be voided, use a refund instead'),
    ),
  );

  const ledger: LedgerDelta[] = [];
  const transitions: Transition[] = [];

  if (payment.state === 'requires_capture') {
    ledger.push({
      account: 'authorized_funds',
      amount: money(-held.minor, currency),
      entityRef: `payment:${payment.id}`,
    });
    ledger.push({
      account: 'customer_settlement',
      amount: held,
      entityRef: `payment:${payment.id}`,
    });
    transitions.push({ entity: 'payment', id: payment.id, from: payment.state, to: 'voided' });

    const order = idx.order(payment.orderId as string);
    const siblings = idx
      .paymentsForOrder(payment.orderId as string)
      .filter((x: Payment) => x.id !== payment.id && x.captured.minor > 0);
    if (order && siblings.length === 0 && order.state !== 'cancelled') {
      transitions.push({ entity: 'order', id: order.id, from: order.state, to: 'cancelled' });
    }
  }

  return {
    ledger,
    transitions,
    route: {
      processorAccountId: payment.processorAccountId as string,
      processor: payment.processor,
      reason: 'pinned_to_original_processor',
    },
    resources: paymentResources(payment, idx),
    totals: {
      merchantOutflow: zero(currency),
      customerReceives: zero(currency),
      notional: held,
    },
    invariants,
    preconditions: [
      pre('payment.state', 'payment state', payment.state),
      pre('payment.held_minor', 'authorization amount held', held.minor),
    ],
    riskFlags: held.minor >= policy.highValueMinor ? ['high_value'] : [],
  };
}

// ---------------------------------------------------------------------------
// subscription.cancel
// ---------------------------------------------------------------------------

function compileSubscriptionCancel(
  intent: Intent,
  idx: SnapshotIndex,
  currency: Currency,
  policy: CompilerPolicy,
  options: CompileOptions,
): Draft | CompileFailure {
  if (intent.action.kind !== 'subscription.cancel') {
    return failure('MALFORMED_PARAMS', 'expected subscription cancel');
  }
  const p = intent.action.params;

  const sub_ = idx.subscription(p.subscriptionId);
  if (!sub_) {
    return failure('RESOURCE_NOT_FOUND', `subscription ${p.subscriptionId} not found for tenant`);
  }

  const invariants: InvariantResult[] = [];
  const riskFlags: RiskFlag[] = [];

  const cancellable = sub_.state === 'active' || sub_.state === 'past_due' || sub_.state === 'paused';
  invariants.push(
    check(
      'SUBSCRIPTION_CANCELLABLE',
      cancellable,
      cancellable
        ? `subscription is ${sub_.state}`
        : `subscription is already ${sub_.state}; nothing to cancel`,
    ),
  );

  const transitions: Transition[] = [];
  if (cancellable) {
    transitions.push({
      entity: 'subscription',
      id: sub_.id,
      from: sub_.state,
      to: 'cancelled',
      ...(p.atPeriodEnd ? { effectiveAt: sub_.currentPeriodEnd } : {}),
    });
  }

  // Cancelling immediately mid-period takes away service the customer has already paid
  // for. It is not forbidden -- sometimes it is exactly what the customer asked for --
  // but it is the kind of thing a human should see before it happens.
  if (!p.atPeriodEnd && options.now < sub_.currentPeriodEnd) {
    riskFlags.push('subscription_mid_period');
  }

  return {
    // Cancellation moves no money. The ledger is empty, and an empty ledger balances,
    // which is exactly right: the risk here is service and revenue, not settlement.
    ledger: [],
    transitions,
    route: null,
    resources: [
      { kind: 'subscription', id: sub_.id as string },
      { kind: 'customer', id: sub_.customerId as string },
    ],
    totals: {
      merchantOutflow: zero(currency),
      customerReceives: zero(currency),
      notional: sub_.amount,
    },
    invariants,
    preconditions: [
      pre('subscription.state', 'subscription state', sub_.state),
      pre('subscription.current_period_end', 'current period end', sub_.currentPeriodEnd),
      pre('subscription.at_period_end', 'cancellation timing requested', p.atPeriodEnd),
    ],
    riskFlags:
      sub_.amount.minor >= policy.highValueMinor ? [...riskFlags, 'high_value'] : riskFlags,
  };
}

// ---------------------------------------------------------------------------

function emptyDraft(
  currency: Currency,
  invariants: InvariantResult[],
  preconditions: Precondition[],
  resources: ResourceRef[],
): Draft {
  return {
    ledger: [],
    transitions: [],
    route: null,
    resources,
    totals: {
      merchantOutflow: zero(currency),
      customerReceives: zero(currency),
      notional: zero(currency),
    },
    invariants,
    preconditions,
    riskFlags: [],
  };
}

/** Resources touched by an action on a single payment: the payment, its order, and the
 *  customer the order belongs to. */
function paymentResources(payment: Payment, idx: SnapshotIndex): ResourceRef[] {
  const order = idx.order(payment.orderId as string);
  const refs: ResourceRef[] = [
    { kind: 'payment', id: payment.id as string },
    { kind: 'order', id: payment.orderId as string },
  ];
  if (order) refs.push({ kind: 'customer', id: order.customerId as string });
  return refs;
}

function hoursUntil(now: string, then: string): number {
  return (Date.parse(then) - Date.parse(now)) / 3_600_000;
}
