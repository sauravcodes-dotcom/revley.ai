import { createHash, createHmac } from 'node:crypto';
import type { ProcessorName } from '@warrant/core';
import type {
  LookupResult,
  PaymentProcessor,
  ProcessorOperation,
  ProcessorOutcome,
  WebhookVerification,
} from './types';

/**
 * A processor simulator with deterministic fault injection.
 *
 * This exists because the failures that matter cannot be produced on demand against a
 * real gateway. Nobody can ask Stripe to time out after committing a refund, or to
 * deliver a webhook twice in the wrong order. A system whose reliability claims rest on
 * "we handled the happy path against a sandbox" has not been tested; it has been demoed.
 *
 * Every decision is a pure function of (seed, idempotency key, attempt), so a run that
 * fails in CI reproduces exactly on a laptop. There is no Math.random anywhere.
 *
 * The simulator also models the one behaviour that separates a real processor from a
 * mock: it is genuinely idempotent. Submitting the same idempotency key twice returns
 * the first result rather than performing the operation again -- including when the
 * first attempt returned `indeterminate` to the caller after having actually succeeded,
 * which is precisely the case that makes blind retries dangerous.
 */
export interface FaultProfile {
  /** Fraction of requests that return `indeterminate` to the caller. */
  timeoutRate: number;
  /**
   * Of those timeouts, the fraction where the operation nonetheless succeeded on the
   * processor side. This is the case that loses money if the caller retries blindly.
   */
  timeoutButAppliedRate: number;
  /** Fraction of requests that fail with a retryable transport error. */
  transientErrorRate: number;
  /** Fraction of requests that fail permanently (declined, already refunded). */
  permanentErrorRate: number;
  /** Fraction of emitted webhooks that are delivered twice. */
  duplicateWebhookRate: number;
  /** Fraction of emitted webhooks delivered out of order relative to their siblings. */
  outOfOrderWebhookRate: number;
  /** Fraction of emitted webhooks delayed beyond the normal window. */
  delayedWebhookRate: number;
}

export const NO_FAULTS: FaultProfile = {
  timeoutRate: 0,
  timeoutButAppliedRate: 0,
  transientErrorRate: 0,
  permanentErrorRate: 0,
  duplicateWebhookRate: 0,
  outOfOrderWebhookRate: 0,
  delayedWebhookRate: 0,
};

/** The profile used in the reliability evals. Failure rates are far above anything a
 *  real processor exhibits, on purpose: rare bugs need frequent faults to surface. */
export const CHAOS: FaultProfile = {
  timeoutRate: 0.15,
  timeoutButAppliedRate: 0.5,
  transientErrorRate: 0.1,
  permanentErrorRate: 0.05,
  duplicateWebhookRate: 0.25,
  outOfOrderWebhookRate: 0.2,
  delayedWebhookRate: 0.15,
};

/**
 * Deterministic [0,1) draw from a seed and a label. Using a hash rather than a stateful
 * PRNG means the value for a given (seed, key, purpose) does not depend on how many
 * other draws happened first, so tests stay stable as unrelated code changes.
 */
export function draw(seed: string, key: string, purpose: string): number {
  const h = createHash('sha256').update(`${seed}|${key}|${purpose}`).digest();
  // 48 bits of entropy is ample and avoids float precision concerns.
  const n = h.readUIntBE(0, 6);
  return n / 2 ** 48;
}

interface RecordedOperation {
  outcome: ProcessorOutcome;
  /** What actually happened on the processor side, which may differ from what the
   *  caller was told. */
  appliedOnProcessor: boolean;
  reference: string;
}

export interface EmittedWebhook {
  eventId: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  /** Delivery instructions the harness honours: duplicates, ordering, delay. */
  deliverTimes: number;
  delayMs: number;
  sequenceHint: number;
}

export class SimulatedProcessor implements PaymentProcessor {
  private readonly operations = new Map<string, RecordedOperation>();
  private readonly emitted: EmittedWebhook[] = [];
  private sequence = 0;

  constructor(
    readonly name: ProcessorName,
    private readonly seed: string,
    private readonly faults: FaultProfile = NO_FAULTS,
    private readonly webhookSecret = 'whsec_simulated',
  ) {}

  refund(op: ProcessorOperation): Promise<ProcessorOutcome> {
    return this.perform('refund', op);
  }

  capture(op: ProcessorOperation): Promise<ProcessorOutcome> {
    return this.perform('capture', op);
  }

  voidAuthorization(op: ProcessorOperation): Promise<ProcessorOutcome> {
    return this.perform('void', op);
  }

  private async perform(kind: string, op: ProcessorOperation): Promise<ProcessorOutcome> {
    // Real idempotency: the same key returns the same answer, forever.
    const existing = this.operations.get(op.idempotencyKey);
    if (existing) return existing.outcome;

    const reference = `${this.name}_${kind}_${shortHash(op.idempotencyKey)}`;
    const roll = (purpose: string) => draw(this.seed, op.idempotencyKey, purpose);

    let record: RecordedOperation;

    if (roll('permanent') < this.faults.permanentErrorRate) {
      record = {
        outcome: {
          status: 'failed',
          code: 'charge_already_refunded',
          message: `${this.name} rejected the ${kind}: the charge is not in a state that allows it`,
          retryable: false,
        },
        appliedOnProcessor: false,
        reference,
      };
    } else if (roll('transient') < this.faults.transientErrorRate) {
      record = {
        outcome: {
          status: 'failed',
          code: 'processor_unavailable',
          message: `${this.name} returned 503`,
          retryable: true,
        },
        appliedOnProcessor: false,
        reference,
      };
    } else if (roll('timeout') < this.faults.timeoutRate) {
      // The dangerous one. We tell the caller we do not know; whether it actually
      // happened is decided here and discoverable only through lookup().
      const applied = roll('timeout-applied') < this.faults.timeoutButAppliedRate;
      record = {
        outcome: {
          status: 'indeterminate',
          message: `${this.name} did not respond within the request timeout`,
        },
        appliedOnProcessor: applied,
        reference,
      };
      if (applied) this.emit(kind, op, reference);
    } else {
      record = {
        outcome: { status: 'succeeded', reference },
        appliedOnProcessor: true,
        reference,
      };
      this.emit(kind, op, reference);
    }

    this.operations.set(op.idempotencyKey, record);
    return record.outcome;
  }

  async lookup(idempotencyKey: string): Promise<LookupResult> {
    const rec = this.operations.get(idempotencyKey);
    if (!rec) return { found: false };
    return {
      found: true,
      status: rec.appliedOnProcessor ? 'succeeded' : 'failed',
      reference: rec.reference,
    };
  }

  private emit(kind: string, op: ProcessorOperation, reference: string): void {
    this.sequence += 1;
    const key = op.idempotencyKey;
    const type = `${this.name}.${kind}.succeeded`;

    const duplicate = draw(this.seed, key, 'dup') < this.faults.duplicateWebhookRate;
    const outOfOrder = draw(this.seed, key, 'order') < this.faults.outOfOrderWebhookRate;
    const delayed = draw(this.seed, key, 'delay') < this.faults.delayedWebhookRate;

    this.emitted.push({
      eventId: `evt_${shortHash(`${key}:${kind}`)}`,
      type,
      occurredAt: new Date().toISOString(),
      payload: {
        reference,
        charge: op.chargeReference,
        amount_minor: op.amountMinor,
        currency: op.currency,
        idempotency_key: key,
      },
      deliverTimes: duplicate ? 2 : 1,
      delayMs: delayed ? 5_000 : 0,
      // A negative hint sorts the event before its siblings, which is how an "out of
      // order" delivery is expressed to the harness.
      sequenceHint: outOfOrder ? -this.sequence : this.sequence,
    });
  }

  /** Drain the webhooks this processor has emitted, in the order the harness should
   *  deliver them -- which is deliberately not the order they occurred. */
  drainWebhooks(): EmittedWebhook[] {
    const out = [...this.emitted].sort((a, b) => a.sequenceHint - b.sequenceHint);
    this.emitted.length = 0;
    return out;
  }

  /** Sign a payload the way this simulator's webhooks are signed, for the harness. */
  signWebhook(body: string, timestamp: number): string {
    const mac = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    return `t=${timestamp},v1=${mac}`;
  }

  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
    now: Date,
  ): WebhookVerification {
    const header = headers['x-warrant-signature'];
    if (!header) return { valid: false, reason: 'missing signature header' };

    const parts = Object.fromEntries(
      header.split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return [k?.trim() ?? '', v?.trim() ?? ''];
      }),
    );

    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) return { valid: false, reason: 'malformed timestamp' };

    // Replay window. Without it a captured webhook stays valid forever and can be
    // resubmitted at any point in the future.
    const ageSeconds = Math.abs(now.getTime() / 1000 - timestamp);
    if (ageSeconds > 300) return { valid: false, reason: 'timestamp outside the replay window' };

    const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    if (!timingSafeEqualHex(expected, parts.v1 ?? '')) {
      return { valid: false, reason: 'signature mismatch' };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return { valid: false, reason: 'body is not valid JSON' };
    }

    const eventId = typeof parsed.id === 'string' ? parsed.id : null;
    const type = typeof parsed.type === 'string' ? parsed.type : null;
    if (!eventId || !type) return { valid: false, reason: 'event is missing id or type' };

    return {
      valid: true,
      envelope: {
        eventId,
        type,
        occurredAt:
          typeof parsed.occurred_at === 'string' ? parsed.occurred_at : now.toISOString(),
        payload: (parsed.data as Record<string, unknown>) ?? {},
      },
    };
  }
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** Constant-time comparison of two hex strings of equal expected length. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
