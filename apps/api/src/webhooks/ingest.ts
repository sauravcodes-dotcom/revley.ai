import {
  DISPUTE_SM,
  PAYMENT_SM,
  REFUND_SM,
  isRegression,
  type StateMachine,
} from '@warrant/core';
import { appendAudit, newTraceId } from '../audit/audit';
import type { Db, Sql } from '../db/db';
import { isPgError, PG_UNIQUE_VIOLATION } from '../db/db';
import { enqueue, newId } from '../db/warrant.repository';
import type { ProcessorRegistry } from '../processors/registry';

/**
 * The unified internal event model.
 *
 * Every processor describes the same happenings differently -- Stripe's `charge.refunded`,
 * Adyen's `REFUND` notification, Braintree's `dispute_opened`. Normalizing at the edge
 * means the rest of the system reasons about one vocabulary, and adding a fifth processor
 * is a mapping table rather than a change to every consumer.
 */
export type DomainEventType =
  | 'refund.succeeded'
  | 'refund.failed'
  | 'payment.captured'
  | 'payment.voided'
  | 'dispute.opened'
  | 'dispute.closed';

export interface NormalizedEvent {
  type: DomainEventType;
  entityRef: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export type IngestOutcome =
  | 'applied'
  | 'duplicate'
  | 'stale'
  | 'deferred'
  | 'unhandled'
  | 'rejected';

export interface IngestResult {
  outcome: IngestOutcome;
  detail: string;
}

/**
 * Normalize a processor-specific event.
 *
 * Returns null for event types the system does not act on. That is a deliberate,
 * recorded outcome (`unhandled`) rather than an error: processors emit dozens of event
 * types, most of them irrelevant, and treating every unknown type as a failure produces
 * an alert channel nobody reads.
 */
export function normalize(
  processor: string,
  type: string,
  payload: Record<string, unknown>,
  occurredAt: string,
): NormalizedEvent | null {
  const idempotencyKey = String(payload.idempotency_key ?? '');
  const reference = String(payload.reference ?? '');

  const map: Record<string, DomainEventType> = {
    // simulated processors
    'refund.succeeded': 'refund.succeeded',
    'refund.failed': 'refund.failed',
    'capture.succeeded': 'payment.captured',
    'void.succeeded': 'payment.voided',
    // stripe
    'charge.refunded': 'refund.succeeded',
    'charge.refund.updated': 'refund.failed',
    'payment_intent.amount_capturable_updated': 'payment.captured',
    'payment_intent.canceled': 'payment.voided',
    'charge.dispute.created': 'dispute.opened',
    'charge.dispute.closed': 'dispute.closed',
  };

  // Simulated events arrive as `<processor>.<kind>.succeeded`; strip the vendor prefix.
  const bare = type.startsWith(`${processor}.`) ? type.slice(processor.length + 1) : type;
  const mapped = map[bare] ?? map[type];
  if (!mapped) return null;

  return {
    type: mapped,
    entityRef: idempotencyKey ? `idempotency:${idempotencyKey}` : `reference:${reference}`,
    occurredAt,
    payload,
  };
}

const SM_FOR: Partial<Record<DomainEventType, { sm: StateMachine<string>; to: string }>> = {
  'refund.succeeded': { sm: REFUND_SM as StateMachine<string>, to: 'succeeded' },
  'refund.failed': { sm: REFUND_SM as StateMachine<string>, to: 'failed' },
  'payment.captured': { sm: PAYMENT_SM as StateMachine<string>, to: 'captured' },
  'payment.voided': { sm: PAYMENT_SM as StateMachine<string>, to: 'voided' },
  'dispute.opened': { sm: DISPUTE_SM as StateMachine<string>, to: 'open' },
};

export class WebhookIngestService {
  constructor(
    private readonly db: Db,
    private readonly registry: ProcessorRegistry,
  ) {}

  /**
   * Accept one inbound webhook.
   *
   * The order of the checks is the reliability argument:
   *
   *   signature -> store raw (unique on processor event id) -> normalize -> apply
   *
   * Verifying before storing means an unsigned request cannot fill the table. Storing
   * before applying means a redelivery collides on the unique index and is answered
   * `duplicate` without the handler running twice -- the dedupe is a constraint, not an
   * `if (alreadySeen)` check with a race in the middle.
   */
  async ingest(input: {
    tenantId: string;
    processorAccountId: string;
    rawBody: string;
    headers: Record<string, string | undefined>;
    now?: Date;
  }): Promise<IngestResult> {
    const now = input.now ?? new Date();
    const traceId = newTraceId();

    const secretRow = await this.db.withTenant(input.tenantId, (sql) =>
      sql.query<{ webhook_secret: string; processor: string }>(
        'SELECT webhook_secret, processor FROM processor_accounts WHERE tenant_id = $1 AND id = $2',
        [input.tenantId, input.processorAccountId],
      ),
    );
    const account = secretRow.rows[0];
    if (!account) return { outcome: 'rejected', detail: 'unknown processor account' };

    const processor = this.registry.get(input.processorAccountId);
    const verified = processor.verifyWebhook(
      input.rawBody,
      input.headers,
      account.webhook_secret,
      now,
    );

    if (!verified.valid) {
      // Not stored. An attacker who can post unsigned bodies must not be able to grow
      // the events table, and a failed signature carries no trustworthy identifiers to
      // record anyway.
      await this.db.withTenant(input.tenantId, (sql) =>
        appendAudit(sql, {
          tenantId: input.tenantId,
          traceId,
          stage: 'WEBHOOK',
          actor: `processor:${account.processor}`,
          subjectRef: `processor_account:${input.processorAccountId}`,
          payload: { accepted: false, reason: verified.reason },
        }),
      );
      return { outcome: 'rejected', detail: verified.reason };
    }

    const envelope = verified.envelope;

    return this.db.withTenant(input.tenantId, async (sql) => {
      const eventRowId = newId('pev');
      try {
        await sql.query(
          `INSERT INTO processor_events
             (id, tenant_id, processor_account_id, processor, processor_event_id, event_type,
              payload, signature_valid, occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)`,
          [
            eventRowId,
            input.tenantId,
            input.processorAccountId,
            account.processor,
            envelope.eventId,
            envelope.type,
            JSON.stringify(envelope.payload),
            envelope.occurredAt,
          ],
        );
      } catch (err) {
        if (isPgError(err, PG_UNIQUE_VIOLATION)) {
          return { outcome: 'duplicate' as const, detail: `event ${envelope.eventId} already seen` };
        }
        throw err;
      }

      const normalized = normalize(
        account.processor,
        envelope.type,
        envelope.payload,
        envelope.occurredAt,
      );

      if (!normalized) {
        await sql.query(
          `UPDATE processor_events SET processed_at = now(), outcome = 'unhandled' WHERE id = $1`,
          [eventRowId],
        );
        return { outcome: 'unhandled' as const, detail: `no mapping for ${envelope.type}` };
      }

      const result = await this.apply(sql, input.tenantId, normalized, eventRowId);

      await sql.query(`UPDATE processor_events SET processed_at = now(), outcome = $2 WHERE id = $1`, [
        eventRowId,
        result.outcome,
      ]);

      await appendAudit(sql, {
        tenantId: input.tenantId,
        traceId,
        stage: 'WEBHOOK',
        actor: `processor:${account.processor}`,
        subjectRef: normalized.entityRef,
        payload: {
          accepted: true,
          eventId: envelope.eventId,
          type: normalized.type,
          outcome: result.outcome,
        },
      });

      return result;
    });
  }

  /**
   * Apply a normalized event to internal state.
   *
   * Out-of-order delivery is the norm, not an exception, so ordering is decided by the
   * entity's own lifecycle rather than by arrival time. If the event would move the
   * entity *backwards* through its state machine, it is stale and dropped -- a
   * `refund.succeeded` arriving after we already recorded a failure is old news, and
   * applying it would silently resurrect money that never moved.
   */
  private async apply(
    sql: Sql,
    tenantId: string,
    event: NormalizedEvent,
    processorEventId: string,
  ): Promise<IngestResult> {
    const spec = SM_FOR[event.type];
    if (!spec) return { outcome: 'unhandled', detail: `no applier for ${event.type}` };

    const idempotencyKey = event.entityRef.startsWith('idempotency:')
      ? event.entityRef.slice('idempotency:'.length)
      : null;

    if (event.type === 'refund.succeeded' || event.type === 'refund.failed') {
      const target = idempotencyKey
        ? await sql.query<{ id: string; state: string }>(
            `SELECT r.id, r.state FROM refunds r
               JOIN executions e ON e.id = r.execution_id
              WHERE r.tenant_id = $1 AND e.idempotency_key = $2
              FOR UPDATE`,
            [tenantId, idempotencyKey],
          )
        : { rows: [], rowCount: 0 };

      const refund = target.rows[0];
      if (!refund) {
        // The event beat our own write. Park it rather than dropping it: this is the
        // ordinary case where a processor's webhook overtakes its own HTTP response.
        await sql.query(
          `INSERT INTO deferred_events (id, tenant_id, processor_event_id, reason, next_attempt_at)
           VALUES ($1,$2,$3,$4, now() + interval '10 seconds')`,
          [newId('dev'), tenantId, processorEventId, 'refund not yet recorded locally'],
        );
        return { outcome: 'deferred', detail: 'refund not yet recorded locally' };
      }

      if (isRegression(spec.sm, refund.state, spec.to) || refund.state === spec.to) {
        return {
          outcome: refund.state === spec.to ? 'duplicate' : 'stale',
          detail: `refund is already ${refund.state}; event says ${spec.to}`,
        };
      }

      await sql.query(
        `UPDATE refunds SET state = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, refund.id, spec.to],
      );
      await this.recordDomainEvent(sql, tenantId, event, processorEventId);
      return { outcome: 'applied', detail: `refund ${refund.id} -> ${spec.to}` };
    }

    if (event.type === 'dispute.opened') {
      const orderId = String(event.payload.order_id ?? '');
      const paymentId = String(event.payload.payment_id ?? '');
      if (!orderId || !paymentId) {
        return { outcome: 'unhandled', detail: 'dispute event lacks order or payment reference' };
      }
      await sql.query(
        `INSERT INTO disputes (id, tenant_id, order_id, payment_id, state, amount_minor, currency, reason, opened_at, respond_by)
         VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8, $8::timestamptz + interval '10 days')
         ON CONFLICT (id) DO NOTHING`,
        [
          newId('dis'),
          tenantId,
          orderId,
          paymentId,
          Number(event.payload.amount_minor ?? 0),
          String(event.payload.currency ?? 'USD'),
          String(event.payload.reason ?? 'unspecified'),
          event.occurredAt,
        ],
      );
      await sql.query(
        `UPDATE orders SET state = 'disputed', version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND state <> 'disputed'`,
        [tenantId, orderId],
      );
      await this.recordDomainEvent(sql, tenantId, event, processorEventId);
      await enqueue(sql, tenantId, 'dispute.opened', { orderId, paymentId });
      return { outcome: 'applied', detail: `dispute opened on ${orderId}` };
    }

    await this.recordDomainEvent(sql, tenantId, event, processorEventId);
    return { outcome: 'applied', detail: `recorded ${event.type}` };
  }

  private async recordDomainEvent(
    sql: Sql,
    tenantId: string,
    event: NormalizedEvent,
    processorEventId: string,
  ): Promise<void> {
    await sql.query(
      `INSERT INTO domain_events (id, tenant_id, type, entity_ref, payload, processor_event_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        newId('dme'),
        tenantId,
        event.type,
        event.entityRef,
        JSON.stringify(event.payload),
        processorEventId,
        event.occurredAt,
      ],
    );
  }
}
