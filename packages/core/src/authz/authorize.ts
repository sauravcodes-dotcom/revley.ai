import { format, money } from '../money';
import type { EffectPlan, RiskFlag } from '../compiler/plan';
import { blockingFailures } from '../compiler/plan';
import type { Capability } from './capability';
import { scopeFor } from './capability';

export type AuthzOutcome = 'allow' | 'require_approval' | 'deny';

export type DenyCode =
  | 'CAPABILITY_EXPIRED'
  | 'CAPABILITY_NOT_YET_VALID'
  | 'TENANT_MISMATCH'
  | 'ACTION_NOT_GRANTED'
  | 'RESOURCE_OUT_OF_SCOPE'
  | 'PLAN_INADMISSIBLE'
  | 'CURRENCY_NOT_GRANTED'
  | 'PER_ACTION_LIMIT_EXCEEDED'
  | 'SESSION_BUDGET_EXCEEDED'
  | 'DAILY_BUDGET_EXCEEDED'
  | 'DENIAL_CIRCUIT_OPEN';

export type ApprovalCode =
  | 'ABOVE_AUTO_APPROVE_THRESHOLD'
  | 'ACTION_ALWAYS_REQUIRES_APPROVAL'
  | 'RISK_FLAG';

export interface AuthzReason {
  code: DenyCode | ApprovalCode;
  detail: string;
}

export interface AuthzDecision {
  outcome: AuthzOutcome;
  denials: AuthzReason[];
  approvalRequirements: AuthzReason[];
  /** Outflow this plan would charge against the session and daily budgets. */
  budgetChargeMinor: number;
}

export interface UsageCounters {
  /** Outflow already committed or reserved by this session. */
  sessionSpentMinor: number;
  /** Outflow already committed or reserved by this subject today. */
  dailySpentMinor: number;
  /** Consecutive denied proposals in this session. */
  consecutiveDenials: number;
}

export const ZERO_USAGE: UsageCounters = {
  sessionSpentMinor: 0,
  dailySpentMinor: 0,
  consecutiveDenials: 0,
};

/**
 * Risk flags that force a human into the loop no matter how small the amount.
 *
 * `untrusted_content_in_context` is the interesting one. It does not mean the plan is
 * malicious -- most support conversations contain customer text, and that is the entire
 * point of a support agent. It means the model's input was attacker-influenceable, so
 * the *decision* should not rest solely on the model. Combined with scope and budget
 * limits, this is what bounds the blast radius of a successful injection to "an operator
 * saw a suspicious proposal and declined it".
 */
const RISK_FLAGS_REQUIRING_APPROVAL: readonly RiskFlag[] = [
  'open_dispute_on_order',
  'high_value',
  'full_order_refund',
  'refund_after_partial_refunds',
  'subscription_mid_period',
];

/**
 * Authorize a *compiled plan* against a capability.
 *
 * Note what this function does not receive: the model's tool call, its rationale, the
 * conversation, or anything else the model wrote. It sees a computed financial effect and
 * a grant issued from trusted context. There is no string here for an attacker to steer.
 *
 * All checks are evaluated even after the first denial. A partial evaluation would make
 * the audit record depend on check ordering, and the eval suite could not distinguish
 * "denied for one reason" from "denied for five", which is a meaningful difference when
 * you are trying to tell a confused agent apart from a hijacked one.
 */
export function authorize(
  plan: EffectPlan,
  capability: Capability,
  usage: UsageCounters,
  now: string,
): AuthzDecision {
  const denials: AuthzReason[] = [];
  const approvals: AuthzReason[] = [];

  const deny = (code: DenyCode, detail: string) => denials.push({ code, detail });
  const needApproval = (code: ApprovalCode, detail: string) => approvals.push({ code, detail });

  if (now >= capability.notAfter) {
    deny('CAPABILITY_EXPIRED', `capability expired at ${capability.notAfter} (now ${now})`);
  }
  if (now < capability.issuedAt) {
    deny(
      'CAPABILITY_NOT_YET_VALID',
      `capability is not valid until ${capability.issuedAt} (now ${now})`,
    );
  }

  if (plan.tenantId !== capability.tenantId) {
    deny(
      'TENANT_MISMATCH',
      `plan belongs to tenant ${plan.tenantId}, capability to ${capability.tenantId}`,
    );
  }

  if (!capability.actions.includes(plan.action)) {
    deny(
      'ACTION_NOT_GRANTED',
      `action ${plan.action} is not granted; capability allows [${capability.actions.join(', ')}]`,
    );
  }

  const outOfScope = plan.resources.filter(
    (r) => !scopeFor(capability.scope, r.kind).includes(r.id),
  );
  if (outOfScope.length > 0) {
    deny(
      'RESOURCE_OUT_OF_SCOPE',
      `plan affects out-of-scope resources: ${outOfScope.map((r) => `${r.kind}:${r.id}`).join(', ')}`,
    );
  }

  if (!plan.admissible) {
    deny(
      'PLAN_INADMISSIBLE',
      `plan violates ${blockingFailures(plan).length} blocking invariant(s): ` +
        blockingFailures(plan)
          .map((i) => i.id)
          .join(', '),
    );
  }

  const planCurrency = plan.totals.notional.currency;
  if (planCurrency !== capability.limits.currency) {
    deny(
      'CURRENCY_NOT_GRANTED',
      `plan is denominated in ${planCurrency}, capability limits are in ${capability.limits.currency}`,
    );
  }

  const notional = plan.totals.notional.minor;
  const outflow = plan.totals.merchantOutflow.minor;

  if (notional > capability.limits.perActionMaxMinor) {
    deny(
      'PER_ACTION_LIMIT_EXCEEDED',
      `action notional ${format(plan.totals.notional)} exceeds per-action limit ` +
        `${format(money(capability.limits.perActionMaxMinor, capability.limits.currency))}`,
    );
  }

  if (usage.sessionSpentMinor + outflow > capability.limits.sessionBudgetMinor) {
    deny(
      'SESSION_BUDGET_EXCEEDED',
      `session outflow would reach ` +
        `${format(money(usage.sessionSpentMinor + outflow, capability.limits.currency))}, ` +
        `budget is ${format(money(capability.limits.sessionBudgetMinor, capability.limits.currency))}`,
    );
  }

  if (usage.dailySpentMinor + outflow > capability.limits.dailyBudgetMinor) {
    deny(
      'DAILY_BUDGET_EXCEEDED',
      `daily outflow would reach ` +
        `${format(money(usage.dailySpentMinor + outflow, capability.limits.currency))}, ` +
        `budget is ${format(money(capability.limits.dailyBudgetMinor, capability.limits.currency))}`,
    );
  }

  if (usage.consecutiveDenials >= capability.limits.maxDeniedAttempts) {
    deny(
      'DENIAL_CIRCUIT_OPEN',
      `${usage.consecutiveDenials} consecutive denied proposals in this session ` +
        `(limit ${capability.limits.maxDeniedAttempts}); session is cut off pending review`,
    );
  }

  if (capability.alwaysApprove.includes(plan.action)) {
    needApproval(
      'ACTION_ALWAYS_REQUIRES_APPROVAL',
      `action ${plan.action} always requires human approval for this capability`,
    );
  }

  if (outflow > capability.autoApproveBelowMinor) {
    needApproval(
      'ABOVE_AUTO_APPROVE_THRESHOLD',
      `outflow ${format(plan.totals.merchantOutflow)} is above the auto-approve threshold ` +
        `${format(money(capability.autoApproveBelowMinor, capability.limits.currency))}`,
    );
  }

  for (const flag of plan.riskFlags) {
    if (flag === 'untrusted_content_in_context') {
      needApproval(
        'RISK_FLAG',
        'the model saw attacker-influenceable content before proposing this action',
      );
    } else if (RISK_FLAGS_REQUIRING_APPROVAL.includes(flag)) {
      needApproval('RISK_FLAG', `plan carries risk flag ${flag}`);
    }
  }

  const outcome: AuthzOutcome =
    denials.length > 0 ? 'deny' : approvals.length > 0 ? 'require_approval' : 'allow';

  return {
    outcome,
    denials,
    approvalRequirements: approvals,
    budgetChargeMinor: outflow,
  };
}
