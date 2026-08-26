import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compile, money, sum } from '../src';
import type { EffectPlan } from '../src';
import {
  COMPILE_OPTS,
  USD,
  cancelIntent,
  captureIntent,
  dispute,
  order,
  payment,
  processorAccount,
  refund,
  refundIntent,
  snapshot,
  subscription,
  voidIntent,
} from './fixtures';

function plan(result: ReturnType<typeof compile>): EffectPlan {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result.plan;
}

const inv = (p: EffectPlan, id: string) => {
  const found = p.invariants.find((i) => i.id === id);
  if (!found) throw new Error(`missing invariant ${id}`);
  return found;
};

const uncaptured = () =>
  snapshot({
    orders: [order('ord_1', { state: 'authorized' })],
    payments: [
      payment('pay_1', {
        state: 'requires_capture',
        authorized: money(10_000, USD),
        captured: money(0, USD),
        authExpiresAt: '2026-03-05T10:00:00.000Z',
      }),
    ],
  });

describe('compile payment.capture', () => {
  it('moves money from authorized funds to merchant balance', () => {
    const p = plan(compile(captureIntent(10_000), uncaptured(), COMPILE_OPTS));

    expect(p.admissible).toBe(true);
    expect(p.ledger.find((d) => d.account === 'authorized_funds')?.amount.minor).toBe(-10_000);
    expect(p.ledger.find((d) => d.account === 'merchant_balance')?.amount.minor).toBe(10_000);
    expect(p.transitions).toContainEqual({
      entity: 'payment',
      id: 'pay_1',
      from: 'requires_capture',
      to: 'captured',
    });
    expect(p.transitions).toContainEqual({
      entity: 'order',
      id: 'ord_1',
      from: 'authorized',
      to: 'paid',
    });
  });

  it('reports zero outflow but a real notional, so caps still bind on inbound actions', () => {
    const p = plan(compile(captureIntent(10_000), uncaptured(), COMPILE_OPTS));
    expect(p.totals.merchantOutflow.minor).toBe(0);
    expect(p.totals.notional.minor).toBe(10_000);
  });

  it('refuses to capture more than was authorized', () => {
    const p = plan(compile(captureIntent(12_000), uncaptured(), COMPILE_OPTS));
    expect(p.admissible).toBe(false);
    expect(inv(p, 'CAPTURE_WITHIN_AUTHORIZATION').ok).toBe(false);
  });

  it('refuses to capture an expired authorization', () => {
    const s = uncaptured();
    const p = plan(
      compile(captureIntent(10_000), s, { ...COMPILE_OPTS, now: '2026-03-06T10:00:00.000Z' }),
    );
    expect(p.admissible).toBe(false);
    expect(inv(p, 'AUTHORIZATION_NOT_EXPIRED').ok).toBe(false);
  });

  it('flags an authorization that is about to expire', () => {
    const p = plan(
      compile(captureIntent(1_000), uncaptured(), {
        ...COMPILE_OPTS,
        now: '2026-03-05T00:00:00.000Z',
      }),
    );
    expect(p.riskFlags).toContain('auth_expiring_soon');
  });

  it('refuses to capture a payment that is already captured', () => {
    const p = plan(compile(captureIntent(1_000), snapshot(), COMPILE_OPTS));
    expect(p.admissible).toBe(false);
    expect(inv(p, 'PAYMENT_CAPTURABLE').ok).toBe(false);
  });

  it('warns but does not block when the processor account is unhealthy', () => {
    const s = uncaptured();
    const degraded = {
      ...s,
      processorAccounts: [processorAccount('pa_stripe', 'stripe', { healthy: false })],
    };
    const p = plan(compile(captureIntent(10_000), degraded, COMPILE_OPTS));
    expect(inv(p, 'PROCESSOR_ACCOUNT_HEALTHY').ok).toBe(false);
    expect(inv(p, 'PROCESSOR_ACCOUNT_HEALTHY').severity).toBe('warning');
    expect(p.admissible).toBe(true);
  });
});

describe('compile payment.void', () => {
  it('releases the authorization hold and cancels the order', () => {
    const p = plan(compile(voidIntent(), uncaptured(), COMPILE_OPTS));

    expect(p.admissible).toBe(true);
    expect(p.ledger.find((d) => d.account === 'authorized_funds')?.amount.minor).toBe(-10_000);
    expect(p.ledger.find((d) => d.account === 'customer_settlement')?.amount.minor).toBe(10_000);
    expect(p.transitions).toContainEqual({
      entity: 'order',
      id: 'ord_1',
      from: 'authorized',
      to: 'cancelled',
    });
  });

  it('refuses to void a captured payment and says to refund instead', () => {
    const p = plan(compile(voidIntent(), snapshot(), COMPILE_OPTS));
    expect(p.admissible).toBe(false);
    expect(inv(p, 'PAYMENT_VOIDABLE').detail).toContain('refund');
  });

  it('leaves the order alone when a sibling payment is still captured', () => {
    const s = snapshot({
      orders: [order('ord_1', { state: 'paid' })],
      payments: [
        payment('pay_auth', {
          state: 'requires_capture',
          authorized: money(5_000, USD),
          captured: money(0, USD),
          authExpiresAt: '2026-03-05T10:00:00.000Z',
        }),
        payment('pay_done', { captured: money(5_000, USD), authorized: money(5_000, USD) }),
      ],
    });
    const p = plan(compile(voidIntent('pay_auth'), s, COMPILE_OPTS));
    expect(p.transitions.some((t) => t.entity === 'order')).toBe(false);
  });
});

describe('compile subscription.cancel', () => {
  it('cancels immediately with no ledger movement', () => {
    const s = snapshot({ subscriptions: [subscription()] });
    const p = plan(compile(cancelIntent('sub_1', false), s, COMPILE_OPTS));

    expect(p.admissible).toBe(true);
    expect(p.ledger).toHaveLength(0);
    expect(p.totals.merchantOutflow.minor).toBe(0);
    expect(p.transitions).toContainEqual({
      entity: 'subscription',
      id: 'sub_1',
      from: 'active',
      to: 'cancelled',
    });
    expect(p.riskFlags).toContain('subscription_mid_period');
  });

  it('records the effective date when cancelling at period end', () => {
    const s = snapshot({ subscriptions: [subscription()] });
    const p = plan(compile(cancelIntent('sub_1', true), s, COMPILE_OPTS));

    expect(p.transitions[0]?.effectiveAt).toBe('2026-03-23T00:00:00.000Z');
    expect(p.riskFlags).not.toContain('subscription_mid_period');
  });

  it('distinguishes cancel-now from cancel-at-period-end by effect hash', () => {
    // These differ only in when service ends. Sharing an approval between them would let
    // an approved "cancel at period end" execute as an immediate cancellation.
    const s = snapshot({ subscriptions: [subscription()] });
    const now = plan(compile(cancelIntent('sub_1', false), s, COMPILE_OPTS));
    const later = plan(compile(cancelIntent('sub_1', true), s, COMPILE_OPTS));
    expect(now.effectHash).not.toBe(later.effectHash);
  });

  it('refuses to cancel an already cancelled subscription', () => {
    const s = snapshot({ subscriptions: [subscription('sub_1', { state: 'cancelled' })] });
    const p = plan(compile(cancelIntent('sub_1'), s, COMPILE_OPTS));
    expect(p.admissible).toBe(false);
    expect(inv(p, 'SUBSCRIPTION_CANCELLABLE').ok).toBe(false);
  });
});

describe('universal properties', () => {
  // The single most valuable property in the system. Whatever the inputs, whatever the
  // action, a plan that is admissible must not create or destroy money.
  it('every admissible plan has a ledger that sums to zero', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50_000, max: 50_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.boolean(),
        (requested, captured, alreadyRefunded, withDispute) => {
          const s = snapshot({
            orders: [order('ord_1', { total: money(Math.max(captured, 1), USD) })],
            payments: [
              payment('pay_1', {
                authorized: money(Math.max(captured, 1), USD),
                captured: money(captured, USD),
              }),
            ],
            refunds:
              alreadyRefunded > 0 ? [refund('ref_prior', alreadyRefunded, { state: 'succeeded' })] : [],
            disputes: withDispute ? [dispute('dis_1', { amount: money(captured, USD) })] : [],
          });
          const result = compile(refundIntent(requested), s, COMPILE_OPTS);
          if (!result.ok) return;
          const p = result.plan;
          const total = sum(
            p.ledger.map((d) => d.amount),
            USD,
          );
          expect(total.minor).toBe(0);
          if (p.admissible) {
            expect(p.totals.merchantOutflow.minor).toBeGreaterThan(0);
            expect(p.ledger.length).toBeGreaterThan(0);
            // An open dispute must make every refund on that order inadmissible, so an
            // admissible plan proves the dispute branch was genuinely evaluated.
            expect(withDispute).toBe(false);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('an inadmissible plan never carries ledger movement', () => {
    fc.assert(
      fc.property(fc.integer({ min: -20_000, max: 60_000 }), (requested) => {
        const result = compile(refundIntent(requested), snapshot(), COMPILE_OPTS);
        if (!result.ok) return;
        if (!result.plan.admissible) expect(result.plan.ledger).toHaveLength(0);
      }),
      { numRuns: 300 },
    );
  });
});
