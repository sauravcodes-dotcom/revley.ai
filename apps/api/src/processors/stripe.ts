import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ProcessorName } from '@warrant/core';
import type {
  LookupResult,
  PaymentProcessor,
  ProcessorOperation,
  ProcessorOutcome,
  WebhookVerification,
} from './types';

/**
 * Stripe adapter.
 *
 * Written against Stripe's documented HTTP contract with no SDK, because the SDK hides
 * the two things this project is actually about: the Idempotency-Key header and the
 * webhook signature scheme.
 *
 * Honesty note, repeated in the README: the request paths here have been exercised
 * against Stripe's documented API shape and unit tests, not against a live Stripe
 * account. The webhook verification below is tested end to end offline, because
 * signatures can be constructed locally -- and it is the part with the security
 * consequences.
 */
export class StripeProcessor implements PaymentProcessor {
  readonly name: ProcessorName = 'stripe';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.stripe.com/v1',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async refund(op: ProcessorOperation): Promise<ProcessorOutcome> {
    return this.post(
      '/refunds',
      {
        charge: op.chargeReference,
        amount: String(op.amountMinor),
        // Stripe expects lowercase ISO-4217.
        currency: op.currency.toLowerCase(),
        ...(op.reason ? { 'metadata[reason]': op.reason } : {}),
        ...this.metadataFields(op),
      },
      op.idempotencyKey,
    );
  }

  async capture(op: ProcessorOperation): Promise<ProcessorOutcome> {
    return this.post(
      `/payment_intents/${encodeURIComponent(op.chargeReference)}/capture`,
      { amount_to_capture: String(op.amountMinor), ...this.metadataFields(op) },
      op.idempotencyKey,
    );
  }

  async voidAuthorization(op: ProcessorOperation): Promise<ProcessorOutcome> {
    return this.post(
      `/payment_intents/${encodeURIComponent(op.chargeReference)}/cancel`,
      { cancellation_reason: 'requested_by_customer', ...this.metadataFields(op) },
      op.idempotencyKey,
    );
  }

  /**
   * Resolve an indeterminate result.
   *
   * Stripe records the idempotency key on the object it created, so a search by that key
   * answers "did my request land" without guessing. This is the query that must run
   * before any retry of an unknown-result operation.
   */
  async lookup(idempotencyKey: string): Promise<LookupResult> {
    const url = `${this.baseUrl}/refunds/search?query=${encodeURIComponent(
      `metadata['warrant_idempotency_key']:'${idempotencyKey}'`,
    )}`;
    try {
      const res = await this.fetchImpl(url, { headers: this.headers() });
      if (!res.ok) return { found: false };
      const body = (await res.json()) as { data?: { id: string; status: string }[] };
      const hit = body.data?.[0];
      if (!hit) return { found: false };
      return {
        found: true,
        status: hit.status === 'failed' || hit.status === 'canceled' ? 'failed' : 'succeeded',
        reference: hit.id,
      };
    } catch {
      return { found: false };
    }
  }

  private metadataFields(op: ProcessorOperation): Record<string, string> {
    // Mirrored into metadata so `lookup` can find the object later. The Idempotency-Key
    // header prevents the duplicate; the metadata is what lets us *find out* whether it
    // was prevented.
    const fields: Record<string, string> = {
      'metadata[warrant_idempotency_key]': op.idempotencyKey,
    };
    for (const [k, v] of Object.entries(op.metadata ?? {})) {
      fields[`metadata[${k}]`] = v;
    }
    return fields;
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    };
  }

  private async post(
    path: string,
    form: Record<string, string>,
    idempotencyKey: string,
  ): Promise<ProcessorOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(idempotencyKey),
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
      });

      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: { code?: string; type?: string; message?: string };
      };

      if (res.ok && body.id) return { status: 'succeeded', reference: body.id, raw: body };

      // 409 means a different request already used this idempotency key. That is a bug
      // in key derivation, not a transient condition, and retrying cannot help.
      if (res.status === 409) {
        return {
          status: 'failed',
          code: 'idempotency_key_reuse',
          message: body.error?.message ?? 'idempotency key reused with different parameters',
          retryable: false,
          raw: body,
        };
      }

      // 5xx and 429 leave the outcome genuinely unknown: the request may have been
      // applied before the failure. Reporting these as `failed` would invite a retry.
      if (res.status >= 500 || res.status === 429) {
        return {
          status: 'indeterminate',
          message: `stripe returned ${res.status}; outcome unknown`,
        };
      }

      return {
        status: 'failed',
        code: body.error?.code ?? body.error?.type ?? `http_${res.status}`,
        message: body.error?.message ?? `stripe returned ${res.status}`,
        retryable: false,
        raw: body,
      };
    } catch (err) {
      // A timeout or socket error tells us nothing about what the processor did.
      return {
        status: 'indeterminate',
        message: err instanceof Error ? err.message : 'network failure',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Verify a Stripe webhook signature.
   *
   * Implements the documented `Stripe-Signature` scheme: `t=<unix>,v1=<hmac-sha256 of
   * "<t>.<raw body>" keyed with the endpoint secret>`. Three details are load-bearing:
   *
   *  - the raw body is used, never a re-serialized parse
   *  - the comparison is constant time
   *  - the timestamp is checked against a tolerance, which is what stops a captured
   *    webhook from being replayed indefinitely
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
    now: Date,
    toleranceSeconds = 300,
  ): WebhookVerification {
    const header = headers['stripe-signature'];
    if (!header) return { valid: false, reason: 'missing Stripe-Signature header' };

    let timestamp: number | null = null;
    const signatures: string[] = [];

    for (const part of header.split(',')) {
      const [key, value] = part.split('=', 2);
      if (key?.trim() === 't') timestamp = Number(value);
      // Stripe may send several v1 signatures during a secret rotation; any match is
      // sufficient, so they are all collected.
      if (key?.trim() === 'v1' && value) signatures.push(value.trim());
    }

    if (timestamp === null || !Number.isFinite(timestamp)) {
      return { valid: false, reason: 'malformed or missing timestamp' };
    }
    if (signatures.length === 0) return { valid: false, reason: 'no v1 signature present' };

    const age = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);
    if (age > toleranceSeconds) {
      return { valid: false, reason: `timestamp is ${age}s old, outside the replay window` };
    }

    const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
    const matched = signatures.some((sig) => {
      let provided: Buffer;
      try {
        provided = Buffer.from(sig, 'hex');
      } catch {
        return false;
      }
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    });

    if (!matched) return { valid: false, reason: 'no signature matched' };

    let parsed: { id?: string; type?: string; created?: number; data?: { object?: unknown } };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      return { valid: false, reason: 'body is not valid JSON' };
    }

    if (!parsed.id || !parsed.type) {
      return { valid: false, reason: 'event is missing id or type' };
    }

    return {
      valid: true,
      envelope: {
        eventId: parsed.id,
        type: parsed.type,
        occurredAt: new Date((parsed.created ?? timestamp) * 1000).toISOString(),
        payload: (parsed.data?.object as Record<string, unknown>) ?? {},
      },
    };
  }
}
