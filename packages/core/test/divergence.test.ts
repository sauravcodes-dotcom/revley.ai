import { describe, expect, it } from 'vitest';
import { STRICT_TOLERANCE, compile, formatDivergence, money, verifyForCommit } from '../src';
import type { EffectPlan } from '../src';
import {
  COMPILE_OPTS,
  USD,
  dispute,
  order,
  payment,
  processorAccount,
  refund,
  refundIntent,
  snapshot,
} from './fixtures';

function plan(result: ReturnType<typeof compile>): EffectPlan {
  if (!result.ok) throw new Error('expected compile success');
  return result.plan;
}

/**
 * These tests are the reason this project exists.
 *
 * Each one is a situation where an intent-level approval system executes an action that a
 * human approved but would no longer approve, because the world moved between the
 * approval and the commit. The approved tool call is still perfectly valid in every case.
 */
describe('commit-time re-verification', () => {
  const intent = refundIntent(4_000);

  it('reports no divergence when nothing changed', () => {
    const approved = plan(compile(intent, snapshot(), COMPILE_OPTS));
    const fresh = compile(intent, snapshot(), { ...COMPILE_OPTS, planId: 'plan_2' });
    const report = verifyForCommit(approved, fresh);

    expect(report.diverged).toBe(false);
    expect(formatDivergence(report)).toBe('no divergence');
  });

  it('aborts when a chargeback lands between approval and commit', () => {
    // The demo case. An operator approves a 40.00 refund on a 100.00 order. Ninety
    // seconds later the customer's bank opens a dispute for the full amount. Executing
    // the approved refund now pays the customer twice and concedes the dispute.
    const approved = plan(compile(intent, snapshot(), COMPILE_OPTS));
    const fresh = compile(intent, snapshot({ disputes: [dispute()] }), {
      ...COMPILE_OPTS,
      planId: 'plan_2',
    });

    const report = verifyForCommit(approved, fresh);

    expect(report.diverged).toBe(true);
    expect(report.reasons.some((r) => r.kind === 'admissibility')).toBe(true);
    expect(report.reasons.some((r) => r.detail.includes('NO_REFUND_WITH_OPEN_DISPUTE'))).toBe(true);

    const openDisputes = report.reasons.find((r) => r.detail.includes('open disputes'));
    expect(openDisputes?.before).toBe(0);
    expect(openDisputes?.after).toBe(1);
  });

  it('aborts when someone else consumed the refundable balance first', () => {
    // Two support agents, or one agent and a self-service portal, both looking at the
    // same order. Without re-verification the merchant refunds 80.00 on an 100.00 order
    // that had already been 80.00 refunded.
    const approved = plan(compile(intent, snapshot(), COMPILE_OPTS));
    const fresh = compile(intent, snapshot({ refunds: [refund('ref_other', 8_000)] }), {
      ...COMPILE_OPTS,
      planId: 'plan_2',
    });

    const report = verifyForCommit(approved, fresh);
    expect(report.diverged).toBe(true);
    const balance = report.reasons.find((r) => r.detail.includes('refundable balance'));
    expect(balance?.before).toBe(10_000);
    expect(balance?.after).toBe(2_000);
  });

  it('aborts when the effect is the same size but lands on a different order state', () => {
    // Same money, different meaning: after a prior 6,000 refund this 4,000 refund closes
    // the order out entirely. The operator approved a partial refund, not a full one.
    const approved = plan(compile(intent, snapshot(), COMPILE_OPTS));
    const fresh = compile(intent, snapshot({ refunds: [refund('ref_other', 6_000)] }), {
      ...COMPILE_OPTS,
      planId: 'plan_2',
    });

    const report = verifyForCommit(approved, fresh);
    expect(report.diverged).toBe(true);
    expect(report.reasons.some((r) => r.kind === 'effect_hash')).toBe(true);
  });

  it('aborts when the resource has disappeared entirely', () => {
    const approved = plan(compile(intent, snapshot(), COMPILE_OPTS));
    const fresh = compile(intent, snapshot({ orders: [order('ord_other')] }), {
      ...COMPILE_OPTS,
      planId: 'plan_2',
    });

    const report = verifyForCommit(approved, fresh);
    expect(report.diverged).toBe(true);
    expect(report.reasons[0]?.kind).toBe('compile_failure');
  });

  it('tolerates a processor failover by default but not under a strict tolerance', () => {
    const approved = plan(compile(intent, snapshot(), COMPILE_OPTS));
    const failedOver = snapshot({
      processorAccounts: [processorAccount('pa_adyen', 'adyen')],
      payments: [payment('pay_1', { processorAccountId: 'pa_adyen' as never, processor: 'adyen' })],
    });
    const fresh = compile(intent, failedOver, { ...COMPILE_OPTS, planId: 'plan_2' });

    expect(verifyForCommit(approved, fresh).diverged).toBe(false);

    const strict = verifyForCommit(approved, fresh, STRICT_TOLERANCE);
    expect(strict.diverged).toBe(true);
    expect(strict.reasons[0]?.kind).toBe('route');
  });

  it('detects an authorization that expired while waiting for approval', () => {
    const uncaptured = snapshot({
      orders: [order('ord_1', { state: 'authorized' })],
      payments: [
        payment('pay_1', {
          state: 'requires_capture',
          authorized: money(10_000, USD),
          captured: money(0, USD),
          authExpiresAt: '2026-03-01T18:00:00.000Z',
        }),
      ],
    });
    const captureIntent = {
      ...refundIntent(0),
      action: {
        kind: 'payment.capture' as const,
        params: { paymentId: 'pay_1', amountMinor: 10_000, currency: USD },
      },
    };

    const approved = plan(compile(captureIntent, uncaptured, COMPILE_OPTS));
    expect(approved.admissible).toBe(true);

    // Approval sat in the queue past the authorization window.
    const fresh = compile(captureIntent, uncaptured, {
      ...COMPILE_OPTS,
      planId: 'plan_2',
      now: '2026-03-02T00:00:00.000Z',
    });

    const report = verifyForCommit(approved, fresh);
    expect(report.diverged).toBe(true);
    expect(report.reasons.some((r) => r.detail.includes('AUTHORIZATION_NOT_EXPIRED'))).toBe(true);
  });

  it('renders divergence in a form an operator can act on', () => {
    const approved = plan(compile(intent, snapshot(), COMPILE_OPTS));
    const fresh = compile(intent, snapshot({ refunds: [refund('ref_other', 8_000)] }), {
      ...COMPILE_OPTS,
      planId: 'plan_2',
    });
    const text = formatDivergence(verifyForCommit(approved, fresh));

    expect(text).toContain('refundable balance changed');
    expect(text).toContain('10000 -> 2000');
  });
});
