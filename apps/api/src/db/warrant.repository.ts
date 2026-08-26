import { randomUUID } from 'node:crypto';
import {
  digest,
  type AuthzDecision,
  type EffectPlan,
  type Intent,
  type UsageCounters,
} from '@warrant/core';
import type { Sql } from './db';
import { isPgError, PG_UNIQUE_VIOLATION } from './db';

export const newId = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 22)}`;

/**
 * The idempotency key for a processor call.
 *
 * Derived from the plan id together with the effect hash, and the choice between those
 * two is worth explaining because getting it wrong breaks the system in opposite
 * directions.
 *
 * Keying on the effect hash alone looks more principled -- identical effects share a key
 * -- but it is wrong. A merchant may legitimately issue two identical 10.00 refunds
 * against a 100.00 order, and after the first one the second produces an identical
 * ledger delta and identical (empty) state transitions, hence an identical hash. Those
 * two refunds would collide and the second would be silently swallowed.
 *
 * Keying on the plan id alone would be safe but useless: a fresh plan is compiled on
 * every re-verification, so retries would each get a new key and could double-charge.
 *
 * Keying on both gives the semantics that are actually wanted: idempotency is scoped to
 * one approved plan. Every retry of that plan collides; a genuinely new proposal does
 * not. Duplicate *intent* is a separate concern, handled by `recentlyExecutedEffect`,
 * which surfaces it to a human instead of silently deduplicating money movement.
 */
export function idempotencyKeyFor(plan: EffectPlan): string {
  return digest('warrant.idempotency.v1', {
    planId: plan.planId,
    effectHash: plan.effectHash,
  });
}

// ---------------------------------------------------------------------------
// intents and plans
// ---------------------------------------------------------------------------

export async function insertIntent(
  sql: Sql,
  intent: Intent,
  rawToolCall: unknown,
): Promise<void> {
  await sql.query(
    `INSERT INTO intents (id, tenant_id, session_id, action_kind, params, rationale, provenance, raw_tool_call)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      intent.id,
      intent.tenantId,
      intent.sessionId,
      intent.action.kind,
      JSON.stringify(intent.action.params),
      intent.rationale,
      JSON.stringify(intent.provenance),
      rawToolCall === undefined ? null : JSON.stringify(rawToolCall),
    ],
  );
}

export type PlanState =
  | 'compiled'
  | 'denied'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'executed'
  | 'aborted_divergence'
  | 'failed'
  | 'expired';

export async function insertPlan(
  sql: Sql,
  plan: EffectPlan,
  authz: AuthzDecision,
  state: PlanState,
): Promise<void> {
  await sql.query(
    `INSERT INTO effect_plans
       (id, tenant_id, intent_id, action_kind, effect_hash, route_hash, admissible,
        merchant_outflow_minor, notional_minor, currency, document, snapshot_version,
        authz_outcome, authz_document, state, compiled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      plan.planId,
      plan.tenantId,
      plan.intentId,
      plan.action,
      plan.effectHash,
      plan.routeHash,
      plan.admissible,
      plan.totals.merchantOutflow.minor,
      plan.totals.notional.minor,
      plan.totals.notional.currency,
      JSON.stringify(plan),
      plan.snapshotVersion,
      authz.outcome,
      JSON.stringify(authz),
      state,
      plan.compiledAt,
    ],
  );
}

export interface StoredPlan {
  plan: EffectPlan;
  state: PlanState;
  authz: AuthzDecision;
  intentId: string;
}

export async function loadPlan(
  sql: Sql,
  tenantId: string,
  planId: string,
  forUpdate = false,
): Promise<StoredPlan | null> {
  const { rows } = await sql.query<{
    document: EffectPlan;
    state: PlanState;
    authz_document: AuthzDecision;
    intent_id: string;
  }>(
    `SELECT document, state, authz_document, intent_id
       FROM effect_plans WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenantId, planId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    plan: row.document,
    state: row.state,
    authz: row.authz_document,
    intentId: row.intent_id,
  };
}

export async function setPlanState(
  sql: Sql,
  tenantId: string,
  planId: string,
  state: PlanState,
): Promise<void> {
  await sql.query(
    'UPDATE effect_plans SET state = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2',
    [tenantId, planId, state],
  );
}

/**
 * Has an effect with this exact shape already been executed recently?
 *
 * This is the duplicate-*intent* check, deliberately separate from idempotency. It does
 * not block anything; it hands the operator the fact that the same effect was committed
 * eleven minutes ago, which is the information a human needs to tell a legitimate repeat
 * refund apart from a confused agent proposing the same thing twice.
 */
export async function recentlyExecutedEffect(
  sql: Sql,
  tenantId: string,
  effectHash: string,
  withinSeconds: number,
  excludePlanId: string,
): Promise<{ planId: string; executedAt: string } | null> {
  const { rows } = await sql.query<{ id: string; updated_at: Date }>(
    `SELECT id, updated_at FROM effect_plans
      WHERE tenant_id = $1 AND effect_hash = $2 AND state = 'executed'
        AND id <> $4 AND updated_at > now() - make_interval(secs => $3)
      ORDER BY updated_at DESC LIMIT 1`,
    [tenantId, effectHash, withinSeconds, excludePlanId],
  );
  const row = rows[0];
  return row ? { planId: row.id, executedAt: row.updated_at.toISOString() } : null;
}

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

export interface StoredApproval {
  id: string;
  planId: string;
  approvedEffectHash: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
  decidedAt: string;
  expiresAt: string;
}

export async function insertApproval(
  sql: Sql,
  tenantId: string,
  approval: Omit<StoredApproval, 'decidedAt'> & { note?: string },
): Promise<void> {
  await sql.query(
    `INSERT INTO approvals (id, tenant_id, plan_id, approved_effect_hash, decision, decided_by, note, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      approval.id,
      tenantId,
      approval.planId,
      approval.approvedEffectHash,
      approval.decision,
      approval.decidedBy,
      approval.note ?? null,
      approval.expiresAt,
    ],
  );
}

export async function loadApproval(
  sql: Sql,
  tenantId: string,
  planId: string,
): Promise<StoredApproval | null> {
  const { rows } = await sql.query<{
    id: string;
    plan_id: string;
    approved_effect_hash: string;
    decision: 'approved' | 'rejected';
    decided_by: string;
    decided_at: Date;
    expires_at: Date;
  }>(
    `SELECT id, plan_id, approved_effect_hash, decision, decided_by, decided_at, expires_at
       FROM approvals WHERE tenant_id = $1 AND plan_id = $2`,
    [tenantId, planId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    planId: r.plan_id,
    approvedEffectHash: r.approved_effect_hash,
    decision: r.decision,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// executions
// ---------------------------------------------------------------------------

export type ExecutionState = 'pending' | 'succeeded' | 'failed' | 'indeterminate' | 'aborted';

export interface StoredExecution {
  id: string;
  planId: string;
  idempotencyKey: string;
  state: ExecutionState;
  attempt: number;
  processorReference: string | null;
  errorCode: string | null;
  errorDetail: string | null;
}

/**
 * Claim the right to execute this plan.
 *
 * The unique index on `idempotency_key` is what makes duplicate execution impossible
 * rather than unlikely. Two workers racing on the same plan both attempt the insert;
 * exactly one succeeds, and the loser reads back the winner's row instead of calling the
 * processor. There is no check-then-act window here, which is the point -- an
 * `if (!exists) insert` would have one.
 */
export async function claimExecution(
  sql: Sql,
  tenantId: string,
  planId: string,
  idempotencyKey: string,
  processorAccountId: string | null,
): Promise<{ claimed: boolean; execution: StoredExecution }> {
  const id = newId('exe');
  try {
    await sql.query(
      `INSERT INTO executions (id, tenant_id, plan_id, idempotency_key, state, processor_account_id)
       VALUES ($1,$2,$3,$4,'pending',$5)`,
      [id, tenantId, planId, idempotencyKey, processorAccountId],
    );
    return {
      claimed: true,
      execution: {
        id,
        planId,
        idempotencyKey,
        state: 'pending',
        attempt: 1,
        processorReference: null,
        errorCode: null,
        errorDetail: null,
      },
    };
  } catch (err) {
    if (!isPgError(err, PG_UNIQUE_VIOLATION)) throw err;
    const existing = await loadExecutionByKey(sql, tenantId, idempotencyKey);
    if (!existing) throw err;
    return { claimed: false, execution: existing };
  }
}

export async function loadExecutionByKey(
  sql: Sql,
  tenantId: string,
  idempotencyKey: string,
): Promise<StoredExecution | null> {
  const { rows } = await sql.query<{
    id: string;
    plan_id: string;
    idempotency_key: string;
    state: ExecutionState;
    attempt: number;
    processor_reference: string | null;
    error_code: string | null;
    error_detail: string | null;
  }>(
    `SELECT id, plan_id, idempotency_key, state, attempt, processor_reference, error_code, error_detail
       FROM executions WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    planId: r.plan_id,
    idempotencyKey: r.idempotency_key,
    state: r.state,
    attempt: r.attempt,
    processorReference: r.processor_reference,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
  };
}

export async function finishExecution(
  sql: Sql,
  tenantId: string,
  executionId: string,
  patch: {
    state: ExecutionState;
    processorReference?: string | null;
    errorCode?: string | null;
    errorDetail?: string | null;
    divergence?: unknown;
  },
): Promise<void> {
  await sql.query(
    `UPDATE executions
        SET state = $3,
            processor_reference = COALESCE($4, processor_reference),
            error_code = $5,
            error_detail = $6,
            divergence = COALESCE($7, divergence),
            finished_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [
      tenantId,
      executionId,
      patch.state,
      patch.processorReference ?? null,
      patch.errorCode ?? null,
      patch.errorDetail ?? null,
      patch.divergence === undefined ? null : JSON.stringify(patch.divergence),
    ],
  );
}

// ---------------------------------------------------------------------------
// budget counters
// ---------------------------------------------------------------------------

/**
 * Read usage under a row lock.
 *
 * Budgets are stored counters rather than a SUM over executions. A SUM would be simpler
 * and would race: two concurrent proposals would each read the same total, each conclude
 * there is room, and both execute. Locking the counter row inside the same transaction
 * that records the execution closes that window.
 */
export async function lockUsage(
  sql: Sql,
  tenantId: string,
  sessionId: string,
  subject: string,
  currency: string,
): Promise<UsageCounters> {
  await sql.query(
    `INSERT INTO capability_usage (tenant_id, session_id, subject, usage_date, currency)
     VALUES ($1,$2,$3,CURRENT_DATE,$4)
     ON CONFLICT (session_id, usage_date) DO NOTHING`,
    [tenantId, sessionId, subject, currency],
  );

  const { rows } = await sql.query<{
    session_spent_minor: string;
    consecutive_denials: number;
  }>(
    `SELECT session_spent_minor, consecutive_denials
       FROM capability_usage
      WHERE tenant_id = $1 AND session_id = $2 AND usage_date = CURRENT_DATE
      FOR UPDATE`,
    [tenantId, sessionId],
  );

  // The daily figure spans every session this subject ran today, so it is summed across
  // rows rather than read from this one.
  const daily = await sql.query<{ total: string | null }>(
    `SELECT SUM(session_spent_minor)::text AS total
       FROM capability_usage
      WHERE tenant_id = $1 AND subject = $2 AND usage_date = CURRENT_DATE`,
    [tenantId, subject],
  );

  return {
    sessionSpentMinor: Number(rows[0]?.session_spent_minor ?? 0),
    dailySpentMinor: Number(daily.rows[0]?.total ?? 0),
    consecutiveDenials: rows[0]?.consecutive_denials ?? 0,
  };
}

export async function chargeUsage(
  sql: Sql,
  tenantId: string,
  sessionId: string,
  amountMinor: number,
): Promise<void> {
  await sql.query(
    `UPDATE capability_usage
        SET session_spent_minor = session_spent_minor + $3,
            consecutive_denials = 0
      WHERE tenant_id = $1 AND session_id = $2 AND usage_date = CURRENT_DATE`,
    [tenantId, sessionId, amountMinor],
  );
}

export async function recordDenial(
  sql: Sql,
  tenantId: string,
  sessionId: string,
): Promise<number> {
  const { rows } = await sql.query<{ consecutive_denials: number }>(
    `UPDATE capability_usage
        SET consecutive_denials = consecutive_denials + 1
      WHERE tenant_id = $1 AND session_id = $2 AND usage_date = CURRENT_DATE
      RETURNING consecutive_denials`,
    [tenantId, sessionId],
  );
  return rows[0]?.consecutive_denials ?? 0;
}

// ---------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------

export async function enqueue(
  sql: Sql,
  tenantId: string,
  topic: string,
  payload: unknown,
  availableAt?: Date,
): Promise<void> {
  await sql.query(
    `INSERT INTO outbox (tenant_id, topic, payload, available_at)
     VALUES ($1,$2,$3,COALESCE($4, now()))`,
    [tenantId, topic, JSON.stringify(payload), availableAt ?? null],
  );
}
