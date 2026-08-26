import type { Currency, ProcessorName } from '@warrant/core';

/**
 * The processor abstraction.
 *
 * Four operations and a webhook verifier. The interface is deliberately narrow: it takes
 * an already-authorized, already-approved effect and performs it. It does not decide
 * amounts, choose routes, or read the ledger, because a processor adapter is the least
 * trustworthy place in the system to put a decision -- it is the code most likely to be
 * written against a vendor's quirks and least likely to be read carefully afterwards.
 *
 * `lookup` is not optional and not an afterthought. It is the resolution path for the
 * one failure mode that actually loses money: a request that timed out, where we do not
 * know whether the processor performed it. Retrying blind is how a customer gets
 * refunded twice; `lookup` is how we find out first.
 */

export interface ProcessorOperation {
  /**
   * Stable across retries of the same approved effect. Derived from the effect hash, so
   * two syntactically different requests that mean the same thing collide here rather
   * than executing twice.
   */
  idempotencyKey: string;
  /** The processor's own reference for the original charge. */
  chargeReference: string;
  amountMinor: number;
  currency: Currency;
  reason?: string;
  metadata?: Record<string, string>;
}

export type ProcessorOutcome =
  | { status: 'succeeded'; reference: string; raw?: unknown }
  | {
      status: 'failed';
      code: string;
      message: string;
      /** Whether a retry could plausibly succeed. A declined card is not retryable; a
       *  502 from the processor's edge is. */
      retryable: boolean;
      raw?: unknown;
    }
  | {
      /**
       * The request may or may not have been performed. Never retried automatically --
       * see ExecutionService, which probes with `lookup` before deciding anything.
       */
      status: 'indeterminate';
      message: string;
    };

export interface LookupResult {
  found: boolean;
  status?: 'succeeded' | 'failed';
  reference?: string;
}

export interface WebhookEnvelope {
  eventId: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export type WebhookVerification =
  | { valid: true; envelope: WebhookEnvelope }
  | { valid: false; reason: string };

export interface PaymentProcessor {
  readonly name: ProcessorName;

  refund(op: ProcessorOperation): Promise<ProcessorOutcome>;
  capture(op: ProcessorOperation): Promise<ProcessorOutcome>;
  voidAuthorization(op: ProcessorOperation): Promise<ProcessorOutcome>;

  /** Resolve an indeterminate result by asking the processor what it recorded. */
  lookup(idempotencyKey: string): Promise<LookupResult>;

  /**
   * Verify and normalize an inbound webhook.
   *
   * Takes the raw body, not a parsed object: every processor signs the exact bytes it
   * sent, and re-serializing parsed JSON changes them. Verifying a re-serialized body is
   * a signature check that passes for the wrong reasons and fails for the right ones.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
    now: Date,
  ): WebhookVerification;
}

export class ProcessorTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessorTimeoutError';
  }
}
