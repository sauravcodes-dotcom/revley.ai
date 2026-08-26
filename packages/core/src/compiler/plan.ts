import type { Money } from '../money';
import { format } from '../money';
import type { ProcessorName } from '../domain/entities';
import type { ActionKind } from './actions';

/**
 * Chart of accounts.
 *
 * Deliberately small. The point is not to be a general ledger; it is to give every
 * proposed action a *balanced, signed* representation of what it does to the merchant's
 * money, so that "what will this do" is a computed value rather than a sentence the
 * model wrote.
 */
export const LEDGER_ACCOUNTS = [
  /** Funds authorized by the issuer but not yet captured. */
  'authorized_funds',
  /** Captured funds owed to the merchant. */
  'merchant_balance',
  /** Money owed back to the customer, or a released authorization hold. */
  'customer_settlement',
  /** Funds withheld against an open dispute. */
  'dispute_reserve',
  /** Processor fees. */
  'processor_fees',
] as const;

export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

export interface LedgerDelta {
  account: LedgerAccount;
  /** Signed. Positive increases the account, negative decreases it. */
  amount: Money;
  /** The entity this line is attributable to, e.g. `order:ord_1` or `payment:pay_1`. */
  entityRef: string;
}

export interface Transition {
  entity: 'order' | 'payment' | 'refund' | 'dispute' | 'subscription';
  id: string;
  from: string;
  to: string;
  /**
   * ISO timestamp when the transition takes effect, for transitions that are scheduled
   * rather than immediate (cancel-at-period-end). Absent means immediate. It is part of
   * the effect hash: "cancel now" and "cancel in 22 days" are different effects and must
   * not share an approval.
   */
  effectiveAt?: string;
}

export interface Route {
  processorAccountId: string;
  processor: ProcessorName;
  /**
   * Why this account was chosen. Refunds and captures are *pinned* to the processor
   * that holds the original authorization -- you cannot refund a Stripe charge through
   * Adyen -- so for those actions the route is derived, not selected. The field exists
   * because the reason is what a reviewer needs to see, and because new charges (not
   * implemented here) would genuinely have a choice.
   */
  reason: 'pinned_to_original_processor' | 'selected_by_policy';
}

export type ResourceKind = 'order' | 'payment' | 'subscription' | 'customer';

/**
 * Every entity the plan touches, including the owning customer.
 *
 * Authorization scope is checked against this list rather than against the ids the model
 * put in its tool call. The difference matters: a refund names an order, but it acts on
 * that order's payments and pays out to that order's customer. A capability scoped to
 * "the customer whose support thread is open" can only be enforced if the plan states
 * which customer it actually moves money for.
 */
export interface ResourceRef {
  kind: ResourceKind;
  id: string;
}

/**
 * Which captured payment each part of a refund draws from, and how much.
 *
 * Derivable from `transitions` only by accident: a payment whose state does not change
 * (a second partial refund against an already partially-refunded charge) emits no
 * transition at all, and the executor would have no charge reference to call the
 * processor with. So the split is stated explicitly, and it is part of the effect hash --
 * refunding 60.00 from one charge is a different effect from splitting it across two,
 * even though the merchant is out the same amount either way.
 */
export interface RefundAllocation {
  paymentId: string;
  processorAccountId: string;
  processorReference: string;
  amountMinor: number;
}

export type InvariantSeverity = 'blocking' | 'warning';

export interface InvariantResult {
  id: string;
  ok: boolean;
  severity: InvariantSeverity;
  detail: string;
}

/**
 * A fact about the world that the plan depends on, captured at compile time.
 *
 * Preconditions are what make divergence *legible*. At commit time the compiler runs
 * again against fresh state; comparing effect hashes tells us that something changed,
 * but comparing preconditions tells a human *what* changed: "refundable balance was
 * 40.00 USD, is now 0.00 USD" rather than "hash mismatch".
 */
export interface Precondition {
  id: string;
  description: string;
  /** Canonical JSON-safe observed value at compile time. */
  observed: string | number | boolean;
}

export type RiskFlag =
  | 'untrusted_content_in_context'
  | 'open_dispute_on_order'
  | 'high_value'
  | 'full_order_refund'
  | 'refund_after_partial_refunds'
  | 'auth_expiring_soon'
  | 'subscription_mid_period';

export interface PlanTotals {
  /**
   * Magnitude of money leaving merchant control if this plan commits. This -- not the
   * amount the model asked for -- is what session and daily *budgets* are evaluated
   * against, because they are not always the same number: a split refund allocated
   * across two payments still moves one total out the door, and a capture moves nothing
   * out at all.
   */
  merchantOutflow: Money;
  /** What the customer receives, if anything. */
  customerReceives: Money;
  /**
   * The headline amount of the action, regardless of direction: the refund amount, the
   * capture amount, the released authorization, the recurring subscription amount.
   * Per-action caps are evaluated against this so that "this agent may not touch a
   * single transaction larger than X" holds for inflows too, where outflow is zero.
   */
  notional: Money;
}

export interface EffectPlan {
  planId: string;
  tenantId: string;
  intentId: string;
  action: ActionKind;

  ledger: readonly LedgerDelta[];
  transitions: readonly Transition[];
  route: Route | null;
  totals: PlanTotals;
  resources: readonly ResourceRef[];
  /** Populated for refund.issue; empty for every other action. */
  allocations: readonly RefundAllocation[];

  invariants: readonly InvariantResult[];
  preconditions: readonly Precondition[];
  riskFlags: readonly RiskFlag[];

  /**
   * Hash over the financial semantics only: action, tenant, ledger, transitions, totals.
   * Route is excluded so that a processor failover does not, by itself, invalidate an
   * approval. Compared strictly at commit time.
   */
  effectHash: string;
  /** Hash over the chosen route. Compared at commit time under `allowRouteChange`. */
  routeHash: string;

  compiledAt: string;
  snapshotVersion: number;
  /** False when any blocking invariant failed. An inadmissible plan is still stored and
   *  audited -- refusing to record a rejected proposal would destroy the evidence trail
   *  that makes prompt-injection attempts visible. */
  admissible: boolean;
}

export function blockingFailures(plan: EffectPlan): InvariantResult[] {
  return plan.invariants.filter((i) => !i.ok && i.severity === 'blocking');
}

export function describePlan(plan: EffectPlan): string {
  const lines: string[] = [
    `${plan.action} (${plan.admissible ? 'admissible' : 'INADMISSIBLE'})`,
    `  outflow: ${format(plan.totals.merchantOutflow)}`,
  ];
  for (const d of plan.ledger) {
    lines.push(`  ledger  ${d.account.padEnd(20)} ${format(d.amount).padStart(16)}  ${d.entityRef}`);
  }
  for (const t of plan.transitions) {
    lines.push(`  state   ${t.entity}:${t.id} ${t.from} -> ${t.to}`);
  }
  for (const i of plan.invariants.filter((x) => !x.ok)) {
    lines.push(`  ${i.severity === 'blocking' ? 'FAIL' : 'warn'}    ${i.id}: ${i.detail}`);
  }
  return lines.join('\n');
}
