import {
  DEFAULT_TOLERANCE,
  compile,
  formatDivergence,
  verifyForCommit,
  type CommitTolerance,
  type DivergenceReport,
  type EffectPlan,
  type Intent,
} from '@warrant/core';
import { appendAudit } from '../audit/audit';
import type { Db } from '../db/db';
import { loadSnapshot } from '../db/snapshot.repository';
import { focusForActionParams, toActionParams } from '../domain/action-params';
import {
  ConcurrentExecutionError,
  claimExecution,
  enqueue,
  finishExecution,
  idempotencyKeyFor,
  loadApproval,
  loadPlan,
  lockUsage,
  newId,
  releaseBudget,
  reserveBudget,
  sessionCeiling,
  setPlanState,
} from '../db/warrant.repository';
import type { CircuitBreaker, ProcessorRegistry } from '../processors/registry';
import type { ProcessorOperation, ProcessorOutcome } from '../processors/types';

export type ExecutionOutcome =
  | { status: 'executed'; executionId: string; processorReference: string }
  | { status: 'aborted_divergence'; report: DivergenceReport }
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; code: string; detail: string; retryable: boolean }
  | { status: 'needs_attention'; executionId: string; detail: string }
  | { status: 'already_executed'; executionId: string };

export interface ExecuteOptions {
  tenantId: string;
  planId: string;
  sessionId: string;
  traceId: string;
  tolerance?: CommitTolerance;
  now?: () => Date;
}

/**
 * Commit an approved plan.
 *
 * The order of operations here is the whole safety argument, so it is worth stating
 * plainly:
 *
 *   1. re-compile the intent against fresh state and compare to what was approved
 *   2. claim an execution row keyed on the plan's idempotency key
 *   3. call the processor
 *   4. apply effects and finish the execution in one transaction
 *
 * Step 1 before step 2 means a plan that has gone stale never reaches the processor.
 * Step 2 before step 3 means a concurrent duplicate loses the insert race and returns the
 * winner's result instead of placing a second call. Step 4 in a single transaction means
 * the ledger and the execution record cannot disagree about what happened.
 *
 * What is deliberately *not* here: an automatic retry of an indeterminate result. See
 * `resolveIndeterminate`.
 */
export class ExecutionService {
  constructor(
    private readonly db: Db,
    private readonly registry: ProcessorRegistry,
    private readonly breaker: CircuitBreaker,
  ) {}

  async execute(opts: ExecuteOptions): Promise<ExecutionOutcome> {
    const now = opts.now ?? (() => new Date());
    const { tenantId, planId, traceId } = opts;

    const loaded = await this.db.withTenant(tenantId, (sql) => loadPlan(sql, tenantId, planId));
    if (!loaded) return { status: 'rejected', reason: `plan ${planId} not found` };

    if (loaded.state === 'executed') {
      return { status: 'rejected', reason: 'plan has already been executed' };
    }
    if (loaded.state !== 'approved' && loaded.state !== 'compiled') {
      return { status: 'rejected', reason: `plan is in state ${loaded.state}` };
    }

    // An approval that has aged out is not an approval. Without this a plan could sit in
    // the queue over a weekend and commit against a world nobody looked at.
    const approval = await this.db.withTenant(tenantId, (sql) =>
      loadApproval(sql, tenantId, planId),
    );
    if (loaded.authz.outcome === 'require_approval') {
      if (!approval || approval.decision !== 'approved') {
        return { status: 'rejected', reason: 'plan requires human approval and has none' };
      }
      if (new Date(approval.expiresAt) <= now()) {
        await this.db.withTenant(tenantId, (sql) => setPlanState(sql, tenantId, planId, 'expired'));
        return { status: 'rejected', reason: 'approval expired before execution' };
      }
      if (approval.approvedEffectHash !== loaded.plan.effectHash) {
        // Belt and braces: the approval records the hash the human saw, so even a
        // rewritten plan row cannot inherit someone else's approval.
        return { status: 'rejected', reason: 'approval does not match this plan' };
      }
    }
    if (loaded.authz.outcome === 'deny') {
      return { status: 'rejected', reason: 'plan was denied by authorization' };
    }

    // ---- 1. re-verify against fresh state -------------------------------------------
    const report = await this.reverify(tenantId, loaded.plan, opts.tolerance ?? DEFAULT_TOLERANCE, now);

    await this.db.withTenant(tenantId, (sql) =>
      appendAudit(sql, {
        tenantId,
        traceId,
        sessionId: opts.sessionId,
        stage: 'REVERIFICATION',
        actor: 'system:executor',
        subjectRef: `plan:${planId}`,
        payload: {
          diverged: report.diverged,
          reasons: report.reasons.map((r) => ({ kind: r.kind, detail: r.detail })),
        },
      }),
    );

    if (report.diverged) {
      await this.db.withTenant(tenantId, async (sql) => {
        await setPlanState(sql, tenantId, planId, 'aborted_divergence');
        await enqueue(sql, tenantId, 'plan.diverged', { planId, reasons: report.reasons });
      });
      return { status: 'aborted_divergence', report };
    }

    // ---- 2. claim the execution ------------------------------------------------------
    const plan = loaded.plan;
    const idempotencyKey = idempotencyKeyFor(plan);
    const accountId = plan.route?.processorAccountId ?? null;

    if (accountId && !this.breaker.allows(accountId)) {
      return {
        status: 'failed',
        code: 'circuit_open',
        detail: `processor account ${accountId} circuit is open`,
        retryable: true,
      };
    }

    let claim;
    let overBudget = false;
    try {
      claim = await this.db.withTenant(tenantId, async (sql) => {
        const c = await claimExecution(sql, tenantId, planId, idempotencyKey, accountId);
        if (!c.claimed) return c;

        // Reserve the spend before the processor is called, under the usage row lock, in
        // the same transaction as the claim. Checking the budget at proposal time and
        // charging it after success -- which is what this did originally -- leaves a
        // window where several approved plans each pass against the same unchanged
        // counter and then all commit.
        const outflow = plan.totals.merchantOutflow.minor;
        if (outflow > 0) {
          const ceiling = await sessionCeiling(sql, tenantId, opts.sessionId);
          if (ceiling !== null) {
            const subjectRows = await sql.query<{ subject: string }>(
              'SELECT subject FROM agent_sessions WHERE tenant_id = $1 AND id = $2',
              [tenantId, opts.sessionId],
            );
            await lockUsage(
              sql,
              tenantId,
              opts.sessionId,
              subjectRows.rows[0]?.subject ?? 'agent:unknown',
              plan.totals.notional.currency,
            );
            const reserved = await reserveBudget(
              sql,
              tenantId,
              opts.sessionId,
              outflow,
              ceiling,
            );
            if (!reserved) {
              overBudget = true;
              await finishExecution(sql, tenantId, c.execution.id, {
                state: 'aborted',
                errorCode: 'session_budget_exceeded',
                errorDetail: 'reservation refused at commit time',
              });
              await setPlanState(sql, tenantId, planId, 'denied');
              return c;
            }
          }
        }

        await setPlanState(sql, tenantId, planId, 'executing');
        return c;
      });
    } catch (err) {
      if (err instanceof ConcurrentExecutionError) {
        // A sibling transaction is mid-claim. Backing off is the whole point: whichever
        // caller committed the claim will make the single processor call.
        return {
          status: 'needs_attention',
          executionId: '',
          detail: 'a concurrent commit of this plan is in flight',
        };
      }
      throw err;
    }

    if (!claim.claimed) {
      // Someone else got there first. Report their result rather than making a second
      // call to the processor.
      if (claim.execution.state === 'succeeded') {
        return { status: 'already_executed', executionId: claim.execution.id };
      }
      return {
        status: 'needs_attention',
        executionId: claim.execution.id,
        detail: `a concurrent execution of this plan is ${claim.execution.state}`,
      };
    }

    if (overBudget) {
      return {
        status: 'rejected',
        reason: 'session budget would be exceeded at commit time',
      };
    }

    const executionId = claim.execution.id;

    // ---- 3. call the processor -------------------------------------------------------
    // An adapter that throws rather than returning an outcome must not strand the
    // execution in `pending`. An unhandled throw here is indistinguishable, from the
    // outside, from a request that may or may not have been applied -- so it is treated
    // as exactly that.
    let outcome: ProcessorOutcome;
    try {
      outcome = await this.callProcessor(plan, idempotencyKey);
    } catch (err) {
      outcome = {
        status: 'indeterminate',
        message: `processor adapter threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // ---- 4. record what happened -----------------------------------------------------
    return this.settle(opts, plan, executionId, accountId, outcome, now);
  }

  private async reverify(
    tenantId: string,
    approved: EffectPlan,
    tolerance: CommitTolerance,
    now: () => Date,
  ): Promise<DivergenceReport> {
    return this.db.withTenantSnapshot(tenantId, async (sql) => {
      const intentRows = await sql.query<{
        id: string;
        session_id: string;
        action_kind: string;
        params: Record<string, unknown>;
        rationale: string;
        provenance: Intent['provenance'];
        created_at: Date;
      }>(
        `SELECT id, session_id, action_kind, params, rationale, provenance, created_at
           FROM intents WHERE tenant_id = $1 AND id = $2`,
        [tenantId, approved.intentId],
      );
      const row = intentRows.rows[0];
      if (!row) {
        return {
          diverged: true,
          reasons: [{ kind: 'compile_failure' as const, detail: 'originating intent is missing' }],
        };
      }

      const action = toActionParams(row.action_kind, row.params);
      if (!action) {
        return {
          diverged: true,
          reasons: [
            {
              kind: 'compile_failure' as const,
              detail: `stored intent parameters are no longer valid for ${row.action_kind}`,
            },
          ],
        };
      }

      const at = now().toISOString();
      const snapshot = await loadSnapshot(sql, tenantId, focusForActionParams(action), at);
      if (!snapshot) {
        return {
          diverged: true,
          reasons: [{ kind: 'compile_failure' as const, detail: 'state snapshot unavailable' }],
        };
      }

      const intent: Intent = {
        id: row.id,
        tenantId,
        sessionId: row.session_id,
        action,
        rationale: row.rationale,
        provenance: row.provenance,
        createdAt: row.created_at.toISOString(),
      };

      const fresh = compile(intent, snapshot, { planId: newId('pln'), now: at });
      return verifyForCommit(approved, fresh, tolerance);
    });
  }

  private async callProcessor(plan: EffectPlan, idempotencyKey: string): Promise<ProcessorOutcome> {
    const accountId = plan.route?.processorAccountId;
    if (!accountId) {
      // Actions with no money movement (a subscription cancellation) have no processor
      // call to make; the effect is entirely internal.
      return { status: 'succeeded', reference: `internal_${idempotencyKey.slice(0, 12)}` };
    }

    const processor = this.registry.get(accountId);
    const op: ProcessorOperation = {
      idempotencyKey,
      chargeReference: plan.allocations[0]?.processorReference ?? referenceFor(plan),
      amountMinor: plan.totals.notional.minor,
      currency: plan.totals.notional.currency,
      metadata: { plan_id: plan.planId, effect_hash: plan.effectHash.slice(0, 32) },
    };

    switch (plan.action) {
      case 'refund.issue':
        return processor.refund(op);
      case 'payment.capture':
        return processor.capture(op);
      case 'payment.void':
        return processor.voidAuthorization(op);
      default:
        return { status: 'succeeded', reference: `internal_${idempotencyKey.slice(0, 12)}` };
    }
  }

  private async settle(
    opts: ExecuteOptions,
    plan: EffectPlan,
    executionId: string,
    accountId: string | null,
    outcome: ProcessorOutcome,
    now: () => Date,
  ): Promise<ExecutionOutcome> {
    const { tenantId, planId, traceId, sessionId } = opts;

    if (outcome.status === 'succeeded') {
      if (accountId) this.breaker.recordSuccess(accountId);

      const { applyPlanEffects } = await import('./apply');
      await this.db.withTenant(tenantId, async (sql) => {
        await applyPlanEffects(sql, tenantId, plan, executionId, outcome.reference);
        await finishExecution(sql, tenantId, executionId, {
          state: 'succeeded',
          processorReference: outcome.reference,
        });
        await setPlanState(sql, tenantId, planId, 'executed');
        // Budget was already reserved at claim time; nothing to charge here.
        await enqueue(sql, tenantId, 'execution.succeeded', { executionId, planId });
        await appendAudit(sql, {
          tenantId,
          traceId,
          sessionId,
          stage: 'RESULT',
          actor: 'system:executor',
          subjectRef: `execution:${executionId}`,
          payload: {
            status: 'succeeded',
            processorReference: outcome.reference,
            effectHash: plan.effectHash,
            outflowMinor: plan.totals.merchantOutflow.minor,
          },
        });
      });

      return { status: 'executed', executionId, processorReference: outcome.reference };
    }

    if (outcome.status === 'failed') {
      // Only infrastructure failures move the breaker. A declined card is a healthy
      // processor saying no, and counting it would open the circuit on a merchant whose
      // customers happen to have expired cards.
      if (accountId && outcome.retryable) this.breaker.recordFailure(accountId);

      await this.db.withTenant(tenantId, async (sql) => {
        await finishExecution(sql, tenantId, executionId, {
          state: 'failed',
          errorCode: outcome.code,
          errorDetail: outcome.message,
        });
        // The money did not move, so the reservation is given back. Not releasing it
        // would let a run of processor failures silently consume an agent's whole budget.
        await releaseBudget(sql, tenantId, sessionId, plan.totals.merchantOutflow.minor);
        await setPlanState(sql, tenantId, planId, 'failed');
        await appendAudit(sql, {
          tenantId,
          traceId,
          sessionId,
          stage: 'RESULT',
          actor: 'system:executor',
          subjectRef: `execution:${executionId}`,
          payload: { status: 'failed', code: outcome.code, retryable: outcome.retryable },
        });
      });

      return {
        status: 'failed',
        code: outcome.code,
        detail: outcome.message,
        retryable: outcome.retryable,
      };
    }

    // Indeterminate. The request may or may not have been performed.
    return this.handleIndeterminate(opts, plan, executionId, accountId, outcome.message, now);
  }

  /**
   * Resolve an unknown result by asking the processor, never by retrying.
   *
   * This is the failure mode that actually costs money. A timeout tells us nothing about
   * whether the refund happened. Retrying is how a customer gets paid twice; marking it
   * failed is how a customer never gets paid and the merchant's books say they were. The
   * only correct move is to find out, and the idempotency key is what makes finding out
   * possible.
   *
   * If the processor cannot tell us either, the execution is parked as `indeterminate`
   * for a human and a reconciliation finding is raised. Parking is not a cop-out: an
   * unresolvable unknown is a real state, and pretending otherwise is what turns one
   * ambiguous refund into a silent ledger drift.
   */
  private async handleIndeterminate(
    opts: ExecuteOptions,
    plan: EffectPlan,
    executionId: string,
    accountId: string | null,
    message: string,
    now: () => Date,
  ): Promise<ExecutionOutcome> {
    const { tenantId, planId, traceId, sessionId } = opts;
    if (accountId) this.breaker.recordFailure(accountId);

    const idempotencyKey = idempotencyKeyFor(plan);
    const probe = accountId
      ? await this.registry.get(accountId).lookup(idempotencyKey)
      : { found: false as const };

    if (probe.found && probe.status === 'succeeded' && probe.reference) {
      // It did happen. Record it as the success it was.
      return this.settle(
        opts,
        plan,
        executionId,
        accountId,
        { status: 'succeeded', reference: probe.reference },
        now,
      );
    }

    if (probe.found && probe.status === 'failed') {
      return this.settle(
        opts,
        plan,
        executionId,
        accountId,
        {
          status: 'failed',
          code: 'processor_reported_failure',
          message: `timed out; processor lookup reports the operation did not apply`,
          retryable: true,
        },
        now,
      );
    }

    await this.db.withTenant(tenantId, async (sql) => {
      await finishExecution(sql, tenantId, executionId, {
        state: 'indeterminate',
        errorCode: 'indeterminate',
        errorDetail: message,
      });
      // The reservation is deliberately NOT released. The money may well have moved, and
      // releasing budget for a spend that might be real would let an agent exceed its
      // limit precisely when the system is least sure what it has already done.
      await setPlanState(sql, tenantId, planId, 'failed');
      await sql.query(
        `INSERT INTO reconciliation_findings (id, tenant_id, entity_ref, kind, internal_minor, currency, detail)
         VALUES ($1,$2,$3,'indeterminate_execution',$4,$5,$6)`,
        [
          newId('rec'),
          tenantId,
          `execution:${executionId}`,
          plan.totals.notional.minor,
          plan.totals.notional.currency,
          `${message}; processor lookup could not confirm the outcome`,
        ],
      );
      await enqueue(sql, tenantId, 'execution.indeterminate', { executionId, planId });
      await appendAudit(sql, {
        tenantId,
        traceId,
        sessionId,
        stage: 'RESULT',
        actor: 'system:executor',
        subjectRef: `execution:${executionId}`,
        payload: { status: 'indeterminate', detail: message, probed: true, resolved: false },
      });
    });

    return {
      status: 'needs_attention',
      executionId,
      detail: `outcome unknown and unresolvable by lookup: ${message}`,
    };
  }
}

function referenceFor(plan: EffectPlan): string {
  const payment = plan.resources.find((r) => r.kind === 'payment');
  return payment?.id ?? plan.planId;
}

export { formatDivergence };
