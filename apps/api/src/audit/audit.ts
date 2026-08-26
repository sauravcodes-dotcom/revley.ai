import { randomUUID } from 'node:crypto';
import { digest, type CanonicalValue } from '@warrant/core';
import type { Sql } from '../db/db';

/**
 * The stages of the agent execution path.
 *
 * Every agentic action walks these in order, and every stage writes exactly one audit
 * record. The value of naming them is that "where did this go wrong" becomes a query
 * rather than an investigation: a trace with a MODEL_DECISION and a VALIDATION but no
 * AUTHORIZATION tells you the tool call never parsed.
 */
export type AuditStage =
  | 'MODEL_DECISION'
  | 'TOOL_REQUEST'
  | 'VALIDATION'
  | 'COMPILATION'
  | 'AUTHORIZATION'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_DECIDED'
  | 'REVERIFICATION'
  | 'EXECUTION'
  | 'RESULT'
  | 'WEBHOOK'
  | 'RECONCILIATION';

export interface AuditRecord {
  tenantId: string;
  traceId: string;
  sessionId?: string | null;
  stage: AuditStage;
  actor: string;
  subjectRef?: string | null;
  payload: CanonicalValue;
}

const GENESIS = '0'.repeat(64);

/**
 * Append one record to the tenant's audit chain.
 *
 * Each row commits to the previous row's hash, so altering or deleting a record breaks
 * verification for every record after it. This is tamper-evidence, not tamper-proofing:
 * it does not prevent someone with database access from rewriting history, it makes the
 * rewrite detectable by anyone who re-runs `verifyChain`.
 *
 * The transaction-scoped advisory lock serialises appends per tenant. Without it two
 * concurrent requests could read the same `prev_hash` and write two records claiming the
 * same predecessor, forking the chain and making verification fail for honest reasons --
 * which is worse than no chain at all, because it trains people to ignore the alarm.
 */
export async function appendAudit(sql: Sql, record: AuditRecord): Promise<string> {
  await sql.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${record.tenantId}`]);

  const prev = await sql.query<{ hash: string }>(
    'SELECT hash FROM audit_events WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1',
    [record.tenantId],
  );
  const prevHash = prev.rows[0]?.hash ?? GENESIS;

  const hash = digest('warrant.audit.v1', {
    prevHash,
    tenantId: record.tenantId,
    traceId: record.traceId,
    sessionId: record.sessionId ?? null,
    stage: record.stage,
    actor: record.actor,
    subjectRef: record.subjectRef ?? null,
    payload: record.payload,
  });

  await sql.query(
    `INSERT INTO audit_events
       (tenant_id, trace_id, session_id, stage, actor, subject_ref, payload, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      record.tenantId,
      record.traceId,
      record.sessionId ?? null,
      record.stage,
      record.actor,
      record.subjectRef ?? null,
      JSON.stringify(record.payload),
      prevHash,
      hash,
    ],
  );

  return hash;
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  /** Sequence number of the first record that does not verify, if any. */
  brokenAt?: number;
  detail?: string;
}

/**
 * Recompute the chain from the beginning and report the first record that does not
 * verify. Exposed over the API so that "is the audit trail intact" is a question anyone
 * can answer without database access.
 */
export async function verifyChain(sql: Sql, tenantId: string): Promise<ChainVerification> {
  const { rows } = await sql.query<{
    seq: string;
    trace_id: string;
    session_id: string | null;
    stage: string;
    actor: string;
    subject_ref: string | null;
    payload: CanonicalValue;
    prev_hash: string;
    hash: string;
  }>(
    `SELECT seq, trace_id, session_id, stage, actor, subject_ref, payload, prev_hash, hash
       FROM audit_events WHERE tenant_id = $1 ORDER BY seq ASC`,
    [tenantId],
  );

  let expectedPrev = GENESIS;
  let checked = 0;

  for (const r of rows) {
    const seq = Number(r.seq);
    if (r.prev_hash !== expectedPrev) {
      return {
        valid: false,
        checked,
        brokenAt: seq,
        detail: `record ${seq} claims predecessor ${r.prev_hash.slice(0, 12)} but the chain is at ${expectedPrev.slice(0, 12)}`,
      };
    }

    const recomputed = digest('warrant.audit.v1', {
      prevHash: r.prev_hash,
      tenantId,
      traceId: r.trace_id,
      sessionId: r.session_id,
      stage: r.stage,
      actor: r.actor,
      subjectRef: r.subject_ref,
      payload: r.payload,
    });

    if (recomputed !== r.hash) {
      return {
        valid: false,
        checked,
        brokenAt: seq,
        detail: `record ${seq} content does not match its recorded hash`,
      };
    }

    expectedPrev = r.hash;
    checked += 1;
  }

  return { valid: true, checked };
}

export const newTraceId = (): string => `trc_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
