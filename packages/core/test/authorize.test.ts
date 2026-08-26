import { describe, expect, it } from 'vitest';
import {
  ZERO_USAGE,
  authorize,
  compile,
  signCapability,
  verifyCapability,
} from '../src';
import type { AuthzDecision, EffectPlan } from '../src';
import {
  COMPILE_OPTS,
  T0,
  TENANT_B,
  cancelIntent,
  capability,
  captureIntent,
  keypair,
  refundIntent,
  snapshot,
  subscription,
} from './fixtures';

function plan(result: ReturnType<typeof compile>): EffectPlan {
  if (!result.ok) throw new Error(`compile failed: ${result.code}`);
  return result.plan;
}

const refundPlan = (amountMinor: number, orderId = 'ord_1'): EffectPlan =>
  plan(compile(refundIntent(amountMinor, orderId), snapshot(), COMPILE_OPTS));

const denied = (d: AuthzDecision) => d.denials.map((r) => r.code);
const needs = (d: AuthzDecision) => d.approvalRequirements.map((r) => r.code);

describe('capability signing', () => {
  it('verifies a capability it signed', () => {
    const { publicKey, privateKey } = keypair();
    const signed = signCapability(capability(), privateKey);
    expect(verifyCapability(signed, publicKey)).toEqual({ valid: true });
  });

  it('rejects a capability whose limits were raised after signing', () => {
    const { publicKey, privateKey } = keypair();
    const signed = signCapability(capability(), privateKey);
    const tampered = {
      ...signed,
      capability: {
        ...signed.capability,
        limits: { ...signed.capability.limits, perActionMaxMinor: 10_000_000 },
      },
    };
    expect(verifyCapability(tampered, publicKey)).toEqual({
      valid: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a capability whose scope was widened after signing', () => {
    const { publicKey, privateKey } = keypair();
    const signed = signCapability(capability(), privateKey);
    const tampered = {
      ...signed,
      capability: {
        ...signed.capability,
        scope: { ...signed.capability.scope, orders: ['ord_1', 'ord_someone_elses'] },
      },
    };
    expect(verifyCapability(tampered, publicKey).valid).toBe(false);
  });

  it('rejects a signature produced by a different key', () => {
    const a = keypair();
    const b = keypair();
    const signed = signCapability(capability(), a.privateKey);
    expect(verifyCapability(signed, b.publicKey).valid).toBe(false);
  });
});

describe('authorize', () => {
  it('allows a small in-scope refund without a human', () => {
    const d = authorize(refundPlan(2_000), capability(), ZERO_USAGE, T0);
    expect(d.outcome).toBe('allow');
    expect(d.denials).toHaveLength(0);
    expect(d.budgetChargeMinor).toBe(2_000);
  });

  it('requires approval above the auto-approve threshold', () => {
    const d = authorize(refundPlan(5_000), capability(), ZERO_USAGE, T0);
    expect(d.outcome).toBe('require_approval');
    expect(needs(d)).toContain('ABOVE_AUTO_APPROVE_THRESHOLD');
  });

  it('denies an action the capability does not grant', () => {
    const cap = capability({ actions: ['payment.capture'] });
    const d = authorize(refundPlan(1_000), cap, ZERO_USAGE, T0);
    expect(d.outcome).toBe('deny');
    expect(denied(d)).toContain('ACTION_NOT_GRANTED');
  });

  it('denies a plan whose resources are outside the session scope', () => {
    // The core prompt-injection defence. The session was opened for customer cus_1; the
    // model can name any order it likes, but a plan touching another customer's order is
    // refused before amounts or thresholds are even considered.
    const cap = capability({
      scope: { orders: ['ord_someone_else'], payments: [], subscriptions: [], customers: [] },
    });
    const d = authorize(refundPlan(1_000), cap, ZERO_USAGE, T0);
    expect(d.outcome).toBe('deny');
    expect(denied(d)).toContain('RESOURCE_OUT_OF_SCOPE');
  });

  it('denies when the plan reaches a customer outside scope even if the order is in scope', () => {
    // A capability could be misconfigured to list the order but not its customer. The
    // check runs over every resource the plan actually touches, not just the one the
    // model named, so the narrower of the two wins.
    const cap = capability({
      scope: { orders: ['ord_1'], payments: ['pay_1'], subscriptions: [], customers: [] },
    });
    const d = authorize(refundPlan(1_000), cap, ZERO_USAGE, T0);
    expect(d.outcome).toBe('deny');
    expect(d.denials[0]?.detail).toContain('customer:cus_1');
  });

  it('denies a plan from another tenant', () => {
    const cap = capability({ tenantId: TENANT_B });
    const d = authorize(refundPlan(1_000), cap, ZERO_USAGE, T0);
    expect(denied(d)).toContain('TENANT_MISMATCH');
  });

  it('denies an expired capability', () => {
    const d = authorize(refundPlan(1_000), capability(), ZERO_USAGE, '2026-03-01T14:00:00.000Z');
    expect(denied(d)).toContain('CAPABILITY_EXPIRED');
  });

  it('denies a capability presented before it is valid', () => {
    const d = authorize(refundPlan(1_000), capability(), ZERO_USAGE, '2026-03-01T10:00:00.000Z');
    expect(denied(d)).toContain('CAPABILITY_NOT_YET_VALID');
  });

  it('denies an inadmissible plan regardless of everything else', () => {
    const overRefund = refundPlan(50_000);
    expect(overRefund.admissible).toBe(false);
    const generous = capability({
      limits: { ...capability().limits, perActionMaxMinor: 10_000_000 },
    });
    const d = authorize(overRefund, generous, ZERO_USAGE, T0);
    expect(denied(d)).toContain('PLAN_INADMISSIBLE');
  });

  it('denies a single action above the per-action cap', () => {
    // A full 100.00 refund is perfectly admissible; the cap is what stops it.
    const cap = capability({ limits: { ...capability().limits, perActionMaxMinor: 5_000 } });
    const d = authorize(refundPlan(10_000), cap, ZERO_USAGE, T0);
    expect(d.outcome).toBe('deny');
    expect(denied(d)).toContain('PER_ACTION_LIMIT_EXCEEDED');
  });

  it('applies the per-action cap to inbound actions too, where outflow is zero', () => {
    const s = snapshot();
    const capturePlan = plan(compile(captureIntent(10_000), s, COMPILE_OPTS));
    expect(capturePlan.totals.merchantOutflow.minor).toBe(0);
    const d = authorize(capturePlan, capability({ limits: { ...capability().limits, perActionMaxMinor: 5_000 } }), ZERO_USAGE, T0);
    expect(denied(d)).toContain('PER_ACTION_LIMIT_EXCEEDED');
  });

  it('denies when the session budget would be exceeded', () => {
    const usage = { ...ZERO_USAGE, sessionSpentMinor: 49_000 };
    const d = authorize(refundPlan(2_000), capability(), usage, T0);
    expect(denied(d)).toContain('SESSION_BUDGET_EXCEEDED');
  });

  it('denies when the daily budget would be exceeded', () => {
    const usage = { ...ZERO_USAGE, dailySpentMinor: 199_000 };
    const d = authorize(refundPlan(2_000), capability(), usage, T0);
    expect(denied(d)).toContain('DAILY_BUDGET_EXCEEDED');
  });

  it('cuts the session off after repeated denials', () => {
    // A model being driven by injected instructions retries variations of the same
    // forbidden action. This turns an unbounded probing loop into a stop.
    const usage = { ...ZERO_USAGE, consecutiveDenials: 3 };
    const d = authorize(refundPlan(500), capability(), usage, T0);
    expect(denied(d)).toContain('DENIAL_CIRCUIT_OPEN');
  });

  it('collects every applicable denial rather than stopping at the first', () => {
    const cap = capability({ tenantId: TENANT_B, actions: [] });
    const d = authorize(refundPlan(50_000), cap, ZERO_USAGE, '2026-03-01T14:00:00.000Z');
    expect(denied(d)).toEqual(
      expect.arrayContaining([
        'CAPABILITY_EXPIRED',
        'TENANT_MISMATCH',
        'ACTION_NOT_GRANTED',
        'PLAN_INADMISSIBLE',
        'PER_ACTION_LIMIT_EXCEEDED',
      ]),
    );
  });

  it('forces approval when the model saw untrusted content, even for a trivial amount', () => {
    const p = plan(
      compile(
        refundIntent(100, 'ord_1', {
          provenance: { sources: ['customer_message'], containsUntrustedContent: true },
        }),
        snapshot(),
        COMPILE_OPTS,
      ),
    );
    const d = authorize(p, capability(), ZERO_USAGE, T0);
    expect(d.outcome).toBe('require_approval');
    expect(d.approvalRequirements.some((r) => r.detail.includes('attacker-influenceable'))).toBe(
      true,
    );
  });

  it('forces approval for actions listed as always-approve', () => {
    const s = snapshot({ subscriptions: [subscription()] });
    const p = plan(compile(cancelIntent('sub_1', true), s, COMPILE_OPTS));
    const cap = capability({ alwaysApprove: ['subscription.cancel'] });
    const d = authorize(p, cap, ZERO_USAGE, T0);
    expect(d.outcome).toBe('require_approval');
    expect(needs(d)).toContain('ACTION_ALWAYS_REQUIRES_APPROVAL');
  });

  it('denial beats approval: a plan that is both risky and forbidden is denied', () => {
    const cap = capability({ actions: [] });
    const d = authorize(refundPlan(5_000), cap, ZERO_USAGE, T0);
    expect(d.outcome).toBe('deny');
    expect(d.approvalRequirements.length).toBeGreaterThan(0);
  });
});
