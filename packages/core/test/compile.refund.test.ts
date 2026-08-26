import { describe, expect, it } from 'vitest';
import { compile, format, money } from '../src';
import type { EffectPlan } from '../src';
import {
  COMPILE_OPTS,
  TENANT_B,
  USD,
  dispute,
  intent,
  order,
  payment,
  processorAccount,
  refund,
  refundIntent,
  snapshot,
} from './fixtures';

function plan(result: ReturnType<typeof compile>): EffectPlan {
  if (!result.ok) throw new Error(`expected compile success, got ${result.code}: ${result.message}`);
  return result.plan;
}

function invariant(p: EffectPlan, id: string) {
  const found = p.invariants.find((i) => i.id === id);
  if (!found) throw new Error(`invariant ${id} not present. have: ${p.invariants.map((i) => i.id)}`);
  return found;
}

describe('compile refund.issue', () => {
  it('produces a balanced ledger and the correct state transitions for a partial refund', () => {
    const p = plan(compile(refundIntent(4_000), snapshot(), COMPILE_OPTS));

    expect(p.admissible).toBe(true);
    expect(p.totals.merchantOutflow).toEqual(money(4_000, USD));
    expect(p.totals.customerReceives).toEqual(money(4_000, USD));

    const merchant = p.ledger.find((d) => d.account === 'merchant_balance');
    const customer = p.ledger.find((d) => d.account === 'customer_settlement');
    expect(merchant?.amount.minor).toBe(-4_000);
    expect(customer?.amount.minor).toBe(4_000);
    expect(invariant(p, 'LEDGER_BALANCED').ok).toBe(true);

    expect(p.transitions).toContainEqual({
      entity: 'order',
      id: 'ord_1',
      from: 'paid',
      to: 'partially_refunded',
    });
    expect(p.transitions).toContainEqual({
      entity: 'payment',
      id: 'pay_1',
      from: 'captured',
      to: 'partially_refunded',
    });
  });

  it('marks a full refund as such and transitions the order to refunded', () => {
    const p = plan(compile(refundIntent(10_000), snapshot(), COMPILE_OPTS));

    expect(p.admissible).toBe(true);
    expect(p.riskFlags).toContain('full_order_refund');
    expect(p.transitions).toContainEqual({
      entity: 'order',
      id: 'ord_1',
      from: 'paid',
      to: 'refunded',
    });
  });

  it('rejects a refund that exceeds the captured amount', () => {
    const p = plan(compile(refundIntent(15_000), snapshot(), COMPILE_OPTS));

    expect(p.admissible).toBe(false);
    expect(invariant(p, 'REFUND_WITHIN_CAPTURED').ok).toBe(false);
    // An inadmissible plan carries no ledger movement -- there is nothing to approve.
    expect(p.ledger).toHaveLength(0);
  });

  it('counts pending refunds against the refundable balance', () => {
    // The double-refund bug: a refund submitted but not yet confirmed by the processor
    // has already committed the money. A compiler that only counts `succeeded` would let
    // this second proposal through and the merchant would pay twice.
    const s = snapshot({ refunds: [refund('ref_pending', 8_000, { state: 'pending' })] });
    const p = plan(compile(refundIntent(5_000), s, COMPILE_OPTS));

    expect(p.admissible).toBe(false);
    expect(invariant(p, 'REFUND_WITHIN_CAPTURED').detail).toContain(format(money(2_000, USD)));
  });

  it('ignores failed and cancelled refunds when computing the refundable balance', () => {
    const s = snapshot({
      refunds: [
        refund('ref_failed', 9_000, { state: 'failed' }),
        refund('ref_cancelled', 9_000, { state: 'cancelled' }),
      ],
    });
    const p = plan(compile(refundIntent(10_000), s, COMPILE_OPTS));
    expect(p.admissible).toBe(true);
  });

  it('refuses to refund an order with an open dispute', () => {
    const s = snapshot({ disputes: [dispute()] });
    const p = plan(compile(refundIntent(1_000), s, COMPILE_OPTS));

    expect(p.admissible).toBe(false);
    expect(invariant(p, 'NO_REFUND_WITH_OPEN_DISPUTE').ok).toBe(false);
    expect(p.riskFlags).toContain('open_dispute_on_order');
  });

  it('allows a refund when the dispute has already been won', () => {
    const s = snapshot({ disputes: [dispute('dis_1', { state: 'won' })] });
    const p = plan(compile(refundIntent(1_000), s, COMPILE_OPTS));
    expect(invariant(p, 'NO_REFUND_WITH_OPEN_DISPUTE').ok).toBe(true);
  });

  it('allocates across multiple captured payments oldest first', () => {
    const s = snapshot({
      orders: [order('ord_1', { total: money(15_000, USD) })],
      payments: [
        payment('pay_new', {
          captured: money(5_000, USD),
          authorized: money(5_000, USD),
          capturedAt: '2026-02-22T10:00:00.000Z',
        }),
        payment('pay_old', {
          captured: money(10_000, USD),
          authorized: money(10_000, USD),
          capturedAt: '2026-02-20T10:00:00.000Z',
        }),
      ],
    });
    const p = plan(compile(refundIntent(12_000), s, COMPILE_OPTS));

    expect(p.admissible).toBe(true);
    const alloc = p.preconditions.find((x) => x.id === 'refund.allocation');
    expect(alloc?.observed).toBe('pay_old:10000,pay_new:2000');
    expect(p.transitions).toContainEqual({
      entity: 'payment',
      id: 'pay_old',
      from: 'captured',
      to: 'refunded',
    });
    expect(p.transitions).toContainEqual({
      entity: 'payment',
      id: 'pay_new',
      from: 'captured',
      to: 'partially_refunded',
    });
  });

  it('refuses a refund that would span two processor accounts', () => {
    // You cannot refund an Adyen charge through Stripe. Splitting the refund is the
    // operator's decision, not something the system should silently do on their behalf.
    const s = snapshot({
      processorAccounts: [processorAccount(), processorAccount('pa_adyen', 'adyen')],
      payments: [
        payment('pay_stripe', {
          captured: money(6_000, USD),
          authorized: money(6_000, USD),
          capturedAt: '2026-02-20T10:00:00.000Z',
        }),
        payment('pay_adyen', {
          processorAccountId: 'pa_adyen' as never,
          processor: 'adyen',
          captured: money(6_000, USD),
          authorized: money(6_000, USD),
          capturedAt: '2026-02-21T10:00:00.000Z',
        }),
      ],
    });
    const p = plan(compile(refundIntent(9_000), s, COMPILE_OPTS));

    expect(p.admissible).toBe(false);
    expect(invariant(p, 'REFUND_SINGLE_PROCESSOR').ok).toBe(false);
  });

  it('pins the route to the processor holding the original charge', () => {
    const s = snapshot({
      processorAccounts: [processorAccount('pa_adyen', 'adyen')],
      payments: [payment('pay_1', { processorAccountId: 'pa_adyen' as never, processor: 'adyen' })],
    });
    const p = plan(compile(refundIntent(1_000), s, COMPILE_OPTS));
    expect(p.route).toEqual({
      processorAccountId: 'pa_adyen',
      processor: 'adyen',
      reason: 'pinned_to_original_processor',
    });
  });

  it('rejects zero, negative and non-integer amounts', () => {
    for (const amount of [0, -100, 12.5]) {
      const p = plan(compile(refundIntent(amount), snapshot(), COMPILE_OPTS));
      expect(p.admissible, `amount ${amount} should be inadmissible`).toBe(false);
      expect(invariant(p, 'POSITIVE_AMOUNT').ok).toBe(false);
      expect(p.ledger).toHaveLength(0);
    }
  });

  it('rejects a currency the tenant does not operate in', () => {
    const i = intent({
      kind: 'refund.issue',
      params: { orderId: 'ord_1', amountMinor: 1_000, currency: 'EUR', reason: 'x' },
    });
    const p = plan(compile(i, snapshot(), COMPILE_OPTS));
    expect(p.admissible).toBe(false);
    expect(invariant(p, 'CURRENCY_MATCH').ok).toBe(false);
  });

  it('reports an unknown order as not found rather than leaking its existence', () => {
    const r = compile(refundIntent(1_000, 'ord_does_not_exist'), snapshot(), COMPILE_OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('refuses to compile an intent from a different tenant', () => {
    const r = compile(refundIntent(1_000, 'ord_1', { tenantId: TENANT_B }), snapshot(), COMPILE_OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('TENANT_MISMATCH');
  });

  it('blocks every action when the order ledger is already inconsistent', () => {
    // Recorded refunds exceed captures. Something upstream is wrong; the correct response
    // is to stop and surface it, not to compute a refundable balance from bad data.
    const s = snapshot({ refunds: [refund('ref_1', 12_000)] });
    const p = plan(compile(refundIntent(100), s, COMPILE_OPTS));
    expect(p.admissible).toBe(false);
    expect(invariant(p, 'LEDGER_CONSISTENT').ok).toBe(false);
  });

  it('flags untrusted content in the model context', () => {
    const p = plan(
      compile(
        refundIntent(1_000, 'ord_1', {
          provenance: { sources: ['customer_message'], containsUntrustedContent: true },
        }),
        snapshot(),
        COMPILE_OPTS,
      ),
    );
    expect(p.riskFlags).toContain('untrusted_content_in_context');
  });

  it('lists the customer among the plan resources so scope can be enforced on them', () => {
    const p = plan(compile(refundIntent(1_000), snapshot(), COMPILE_OPTS));
    expect(p.resources).toContainEqual({ kind: 'customer', id: 'cus_1' });
    expect(p.resources).toContainEqual({ kind: 'order', id: 'ord_1' });
    expect(p.resources).toContainEqual({ kind: 'payment', id: 'pay_1' });
  });
});

describe('effect hash', () => {
  it('is stable across identical compilations', () => {
    const a = plan(compile(refundIntent(4_000), snapshot(), COMPILE_OPTS));
    const b = plan(compile(refundIntent(4_000), snapshot(), { ...COMPILE_OPTS, planId: 'other' }));
    expect(a.effectHash).toBe(b.effectHash);
  });

  it('changes when the amount changes', () => {
    const a = plan(compile(refundIntent(4_000), snapshot(), COMPILE_OPTS));
    const b = plan(compile(refundIntent(4_001), snapshot(), COMPILE_OPTS));
    expect(a.effectHash).not.toBe(b.effectHash);
  });

  it('changes when the resulting state transition changes', () => {
    // Same amount, but a prior refund makes this one settle the order rather than
    // partially refund it. The money is the same; the effect is not.
    const a = plan(compile(refundIntent(2_000), snapshot(), COMPILE_OPTS));
    const b = plan(
      compile(
        refundIntent(2_000),
        snapshot({ refunds: [refund('ref_prior', 8_000)] }),
        COMPILE_OPTS,
      ),
    );
    expect(a.effectHash).not.toBe(b.effectHash);
  });

  it('does not change when only the route changes', () => {
    const stripe = plan(compile(refundIntent(1_000), snapshot(), COMPILE_OPTS));
    const adyen = plan(
      compile(
        refundIntent(1_000),
        snapshot({
          processorAccounts: [processorAccount('pa_stripe', 'adyen')],
          payments: [payment('pay_1', { processor: 'adyen' })],
        }),
        COMPILE_OPTS,
      ),
    );
    expect(adyen.effectHash).toBe(stripe.effectHash);
    expect(adyen.routeHash).not.toBe(stripe.routeHash);
  });
});
