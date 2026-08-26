import type { CompileResult } from './compile';
import type { EffectPlan, Precondition } from './plan';

/**
 * What may change between approval and commit without invalidating the approval.
 *
 * There is deliberately no amount tolerance. A "close enough" band on money is a bug
 * generator: it invites the question of how close is close, and every answer is wrong
 * for some merchant. If the amount moved at all, a human approved a different thing and
 * should be asked again.
 *
 * Route changes are different in kind. A failover to a healthy processor account does
 * not change what happens to the merchant's money, only which pipe it goes through, so
 * a merchant may reasonably pre-authorize it.
 */
export interface CommitTolerance {
  allowRouteChange: boolean;
}

export const STRICT_TOLERANCE: CommitTolerance = { allowRouteChange: false };
export const DEFAULT_TOLERANCE: CommitTolerance = { allowRouteChange: true };

export type DivergenceKind =
  | 'compile_failure'
  | 'effect_hash'
  | 'route'
  | 'admissibility'
  | 'precondition';

export interface DivergenceReason {
  kind: DivergenceKind;
  /** Human-readable, written to be shown to the operator who approved the plan. */
  detail: string;
  before?: string | number | boolean;
  after?: string | number | boolean;
}

export interface DivergenceReport {
  diverged: boolean;
  reasons: DivergenceReason[];
}

/**
 * Re-verify an approved plan against a freshly compiled one immediately before commit.
 *
 * This is the time-of-check to time-of-use gap that intent-level approval leaves open.
 * An operator approves at T0; the execution runs at T0 + queue latency + human latency.
 * In between, a chargeback can land, another refund can be issued, the authorization can
 * expire, the customer can cancel. The approved tool call is still syntactically valid,
 * so an intent-based system executes it. An effect-based system notices that the effect
 * is no longer the one that was approved and stops.
 *
 * `fresh` is the result of running the same intent through `compile` against state read
 * inside the commit transaction. Comparing hashes tells us *that* something changed;
 * comparing preconditions tells the operator *what* changed, which is what they need in
 * order to decide again.
 */
export function verifyForCommit(
  approved: EffectPlan,
  fresh: CompileResult,
  tolerance: CommitTolerance = DEFAULT_TOLERANCE,
): DivergenceReport {
  const reasons: DivergenceReason[] = [];

  if (!fresh.ok) {
    reasons.push({
      kind: 'compile_failure',
      detail: `plan no longer compiles: ${fresh.code} ${fresh.message}`,
    });
    return { diverged: true, reasons };
  }

  const now = fresh.plan;

  if (now.effectHash !== approved.effectHash) {
    reasons.push({
      kind: 'effect_hash',
      detail: 'the financial effect of this action is no longer the one that was approved',
      before: approved.effectHash,
      after: now.effectHash,
    });
  }

  if (!tolerance.allowRouteChange && now.routeHash !== approved.routeHash) {
    reasons.push({
      kind: 'route',
      detail: `processor route changed from ${describeRoute(approved)} to ${describeRoute(now)}`,
      before: describeRoute(approved),
      after: describeRoute(now),
    });
  }

  // An approved plan that has since become inadmissible is the highest-signal case:
  // a dispute opened, the balance was consumed, the authorization expired.
  if (approved.admissible && !now.admissible) {
    const broken = now.invariants.filter((i) => !i.ok && i.severity === 'blocking');
    for (const b of broken) {
      reasons.push({
        kind: 'admissibility',
        detail: `invariant ${b.id} now fails: ${b.detail}`,
      });
    }
  }

  for (const r of comparePreconditions(approved.preconditions, now.preconditions)) {
    reasons.push(r);
  }

  return { diverged: reasons.length > 0, reasons };
}

function comparePreconditions(
  before: readonly Precondition[],
  after: readonly Precondition[],
): DivergenceReason[] {
  const afterById = new Map(after.map((p) => [p.id, p]));
  const out: DivergenceReason[] = [];

  for (const b of before) {
    const a = afterById.get(b.id);
    if (!a) {
      out.push({
        kind: 'precondition',
        detail: `precondition ${b.id} (${b.description}) is no longer observable`,
        before: b.observed,
      });
      continue;
    }
    if (a.observed !== b.observed) {
      out.push({
        kind: 'precondition',
        detail: `${b.description} changed`,
        before: b.observed,
        after: a.observed,
      });
    }
  }
  return out;
}

function describeRoute(plan: EffectPlan): string {
  return plan.route ? `${plan.route.processor}/${plan.route.processorAccountId}` : 'none';
}

/** Compact rendering for logs, audit records and the divergence view in the console. */
export function formatDivergence(report: DivergenceReport): string {
  if (!report.diverged) return 'no divergence';
  return report.reasons
    .map((r) => {
      const delta =
        r.before !== undefined && r.after !== undefined
          ? ` (${String(r.before)} -> ${String(r.after)})`
          : r.before !== undefined
            ? ` (was ${String(r.before)})`
            : '';
      return `[${r.kind}] ${r.detail}${delta}`;
    })
    .join('\n');
}
