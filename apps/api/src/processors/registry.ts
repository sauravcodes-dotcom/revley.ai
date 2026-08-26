import type { ProcessorName } from '@warrant/core';
import type { PaymentProcessor } from './types';

/**
 * A per-account circuit breaker.
 *
 * Scoped to the processor *account*, not the processor. One merchant's Adyen account can
 * be suspended while every other merchant's works fine, and a breaker keyed on "adyen"
 * would take them all down together.
 *
 * Only outcomes that say something about the processor's health move the breaker.
 * A declined card is a perfectly healthy processor telling us no, and counting it as a
 * failure would open the breaker on a merchant whose customers happen to have expired
 * cards.
 */
export type BreakerState = 'closed' | 'open' | 'half_open';

interface BreakerRecord {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
}

export class CircuitBreaker {
  private readonly records = new Map<string, BreakerRecord>();

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  state(accountId: string): BreakerState {
    const rec = this.records.get(accountId);
    if (!rec || rec.state === 'closed') return 'closed';
    if (rec.state === 'open' && rec.openedAt !== null && this.now() - rec.openedAt >= this.cooldownMs) {
      // Let exactly one request through to find out whether the processor recovered.
      rec.state = 'half_open';
      return 'half_open';
    }
    return rec.state;
  }

  allows(accountId: string): boolean {
    return this.state(accountId) !== 'open';
  }

  recordSuccess(accountId: string): void {
    this.records.set(accountId, { state: 'closed', consecutiveFailures: 0, openedAt: null });
  }

  /** Only call for infrastructure failures: timeouts, 5xx, transport errors. */
  recordFailure(accountId: string): void {
    const rec = this.records.get(accountId) ?? {
      state: 'closed' as BreakerState,
      consecutiveFailures: 0,
      openedAt: null,
    };
    rec.consecutiveFailures += 1;
    if (rec.consecutiveFailures >= this.threshold) {
      rec.state = 'open';
      rec.openedAt = this.now();
    }
    this.records.set(accountId, rec);
  }

  snapshot(): Record<string, BreakerRecord> {
    return Object.fromEntries(this.records);
  }
}

/**
 * Resolves a processor account to the adapter that talks to it.
 *
 * Registration is by account id rather than processor name because two merchants on the
 * same processor hold different credentials, and because a merchant can hold more than
 * one account with the same processor -- which is exactly the setup that makes failover
 * possible without leaving the processor.
 */
export class ProcessorRegistry {
  private readonly byAccount = new Map<string, PaymentProcessor>();

  register(accountId: string, processor: PaymentProcessor): void {
    this.byAccount.set(accountId, processor);
  }

  get(accountId: string): PaymentProcessor {
    const p = this.byAccount.get(accountId);
    if (!p) throw new Error(`no processor adapter registered for account ${accountId}`);
    return p;
  }

  has(accountId: string): boolean {
    return this.byAccount.has(accountId);
  }

  accountsFor(processor: ProcessorName): string[] {
    return [...this.byAccount.entries()]
      .filter(([, p]) => p.name === processor)
      .map(([id]) => id);
  }

  clear(): void {
    this.byAccount.clear();
  }
}
