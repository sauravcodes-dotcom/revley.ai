import {
  ZERO_USAGE,
  authorize,
  compile,
  verifyCapability,
  type AuthzDecision,
  type Capability,
  type EffectPlan,
  type Intent,
  type SignedCapability,
} from '@warrant/core';
import { appendAudit } from '../audit/audit';
import type { Db } from '../db/db';
import { loadSnapshot } from '../db/snapshot.repository';
import { focusForActionParams } from '../domain/action-params';
import {
  insertIntent,
  insertPlan,
  lockUsage,
  newId,
  recentlyExecutedEffect,
  recordDenial,
  type PlanState,
} from '../db/warrant.repository';
import {
  fenceUntrustedContent,
  validateProposeAction,
  type ProposeActionInput,
  type ToolCall,
} from './tools';

export interface SessionContext {
  tenantId: string;
  sessionId: string;
  traceId: string;
  subject: string;
  /** The signed grant issued for this session, from trusted context at open time. */
  capability: SignedCapability;
  /** Whether attacker-influenceable content is present in the conversation. */
  untrustedContentPresent: boolean;
  contentSources: string[];
}

export type ProposalResult =
  | { status: 'invalid'; issues: string[] }
  | { status: 'uncompilable'; code: string; message: string }
  | { status: 'denied'; planId: string; plan: EffectPlan; authz: AuthzDecision }
  | { status: 'awaiting_approval'; planId: string; plan: EffectPlan; authz: AuthzDecision }
  | { status: 'authorized'; planId: string; plan: EffectPlan; authz: AuthzDecision };

/**
 * The tool gateway.
 *
 * Implements the pipeline the whole design rests on, with one audit record per stage:
 *
 *   MODEL DECISION -> TOOL REQUEST -> VALIDATION -> COMPILATION
 *     -> AUTHORIZATION -> (APPROVAL) -> EXECUTION -> AUDIT -> RESULT
 *
 * The gateway never executes. Its output is a stored plan and an authorization decision;
 * committing is a separate call made by a human's approval or by policy, and it
 * re-verifies before it acts. Keeping proposal and commit apart is what makes the
 * time-of-check gap closable at all -- if the model's call performed the action, there
 * would be no gap to check across, and no place to put a human.
 */
export class ToolGateway {
  constructor(
    private readonly db: Db,
    private readonly capabilityPublicKey: string,
    private readonly duplicateWindowSeconds = 900,
  ) {}

  async propose(ctx: SessionContext, toolCall: ToolCall): Promise<ProposalResult> {
    const now = new Date().toISOString();

    await this.audit(ctx, 'TOOL_REQUEST', 'agent', null, {
      tool: toolCall.name,
      input: toolCall.input as never,
    });

    // ---- VALIDATION ------------------------------------------------------------------
    const validated = validateProposeAction(toolCall.input);
    if (!validated.ok) {
      await this.audit(ctx, 'VALIDATION', 'system:gateway', null, {
        ok: false,
        issues: validated.issues,
      });
      await this.db.withTenant(ctx.tenantId, (sql) =>
        recordDenial(sql, ctx.tenantId, ctx.sessionId),
      );
      return { status: 'invalid', issues: validated.issues };
    }
    await this.audit(ctx, 'VALIDATION', 'system:gateway', null, { ok: true });

    // The capability's signature is checked on every proposal, not once at session open.
    // A grant held in memory for the length of a conversation is a grant that can be
    // mutated by anything else running in that process.
    const verification = verifyCapability(ctx.capability, this.capabilityPublicKey);
    if (!verification.valid) {
      await this.audit(ctx, 'AUTHORIZATION', 'system:gateway', null, {
        outcome: 'deny',
        reason: `capability signature invalid: ${verification.reason}`,
      });
      return { status: 'uncompilable', code: 'BAD_CAPABILITY', message: 'capability signature invalid' };
    }
    const capability: Capability = ctx.capability.capability;

    const intent = this.toIntent(ctx, validated.value, now);

    // ---- COMPILATION -----------------------------------------------------------------
    const compiled = await this.db.withTenantSnapshot(ctx.tenantId, async (sql) => {
      const snapshot = await loadSnapshot(
        sql,
        ctx.tenantId,
        focusForActionParams(intent.action),
        now,
      );
      if (!snapshot) return null;
      return compile(intent, snapshot, { planId: newId('pln'), now });
    });

    if (!compiled) {
      return { status: 'uncompilable', code: 'NO_SNAPSHOT', message: 'tenant state unavailable' };
    }
    if (!compiled.ok) {
      await this.audit(ctx, 'COMPILATION', 'system:compiler', null, {
        ok: false,
        code: compiled.code,
        message: compiled.message,
      });
      await this.db.withTenant(ctx.tenantId, (sql) =>
        recordDenial(sql, ctx.tenantId, ctx.sessionId),
      );
      return { status: 'uncompilable', code: compiled.code, message: compiled.message };
    }

    const plan = compiled.plan;
    await this.audit(ctx, 'COMPILATION', 'system:compiler', `plan:${plan.planId}`, {
      effectHash: plan.effectHash,
      admissible: plan.admissible,
      outflowMinor: plan.totals.merchantOutflow.minor,
      failedInvariants: plan.invariants.filter((i) => !i.ok).map((i) => i.id),
    });

    // ---- AUTHORIZATION ---------------------------------------------------------------
    // Usage is read under a row lock inside the same transaction that stores the plan, so
    // two concurrent proposals cannot both see room in the budget.
    const decision = await this.db.withTenant(ctx.tenantId, async (sql) => {
      const usage = await lockUsage(
        sql,
        ctx.tenantId,
        ctx.sessionId,
        ctx.subject,
        capability.limits.currency,
      ).catch(() => ZERO_USAGE);

      const authz = authorize(plan, capability, usage, now);

      const duplicate = await recentlyExecutedEffect(
        sql,
        ctx.tenantId,
        plan.effectHash,
        this.duplicateWindowSeconds,
        plan.planId,
      );
      if (duplicate && authz.outcome === 'allow') {
        // Not blocked. An identical effect committed minutes ago is usually a confused
        // agent and occasionally a legitimate repeat, and only a human can tell which.
        authz.approvalRequirements.push({
          code: 'RISK_FLAG',
          detail:
            `an identical effect was executed at ${duplicate.executedAt} ` +
            `(plan ${duplicate.planId}); confirm this is not a duplicate`,
        });
        authz.outcome = 'require_approval';
      }

      const state: PlanState =
        authz.outcome === 'deny'
          ? 'denied'
          : authz.outcome === 'require_approval'
            ? 'awaiting_approval'
            : 'approved';

      await insertIntent(sql, intent, toolCall.input);
      await insertPlan(sql, plan, authz, state);

      if (authz.outcome === 'deny') await recordDenial(sql, ctx.tenantId, ctx.sessionId);

      await appendAudit(sql, {
        tenantId: ctx.tenantId,
        traceId: ctx.traceId,
        sessionId: ctx.sessionId,
        stage: 'AUTHORIZATION',
        actor: 'system:authz',
        subjectRef: `plan:${plan.planId}`,
        payload: {
          outcome: authz.outcome,
          denials: authz.denials.map((d) => d.code),
          approvals: authz.approvalRequirements.map((a) => a.code),
          budgetChargeMinor: authz.budgetChargeMinor,
        },
      });

      return authz;
    });

    if (decision.outcome === 'deny') {
      return { status: 'denied', planId: plan.planId, plan, authz: decision };
    }
    if (decision.outcome === 'require_approval') {
      return { status: 'awaiting_approval', planId: plan.planId, plan, authz: decision };
    }
    return { status: 'authorized', planId: plan.planId, plan, authz: decision };
  }

  private toIntent(ctx: SessionContext, input: ProposeActionInput, now: string): Intent {
    const action: Intent['action'] = ((): Intent['action'] => {
      switch (input.action) {
        case 'refund.issue':
          return {
            kind: 'refund.issue',
            params: {
              orderId: input.orderId,
              amountMinor: input.amountMinor,
              currency: input.currency,
              reason: input.reason,
            },
          };
        case 'payment.capture':
          return {
            kind: 'payment.capture',
            params: {
              paymentId: input.paymentId,
              amountMinor: input.amountMinor,
              currency: input.currency,
            },
          };
        case 'payment.void':
          return {
            kind: 'payment.void',
            params: { paymentId: input.paymentId, reason: input.reason },
          };
        case 'subscription.cancel':
          return {
            kind: 'subscription.cancel',
            params: {
              subscriptionId: input.subscriptionId,
              atPeriodEnd: input.atPeriodEnd,
              reason: input.reason,
            },
          };
      }
    })();

    return {
      id: newId('int'),
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
      action,
      rationale: input.rationale,
      provenance: {
        sources: ctx.contentSources,
        containsUntrustedContent: ctx.untrustedContentPresent,
      },
      createdAt: now,
    };
  }

  private async audit(
    ctx: SessionContext,
    stage: Parameters<typeof appendAudit>[1]['stage'],
    actor: string,
    subjectRef: string | null,
    payload: Parameters<typeof appendAudit>[1]['payload'],
  ): Promise<void> {
    await this.db.withTenant(ctx.tenantId, (sql) =>
      appendAudit(sql, {
        tenantId: ctx.tenantId,
        traceId: ctx.traceId,
        sessionId: ctx.sessionId,
        stage,
        actor,
        subjectRef,
        payload,
      }),
    );
  }
}

export { fenceUntrustedContent };
