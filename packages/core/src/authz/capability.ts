import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { Currency } from '../money';
import type { ActionKind } from '../compiler/actions';
import type { ResourceKind } from '../compiler/plan';
import { canonicalize } from '../hash/canonical';

/**
 * A capability is a signed, expiring, narrowly scoped grant issued to one agent session.
 *
 * The design rule that matters: **every field here is derived from trusted context at
 * issue time, never from model output.** When an operator opens a support thread for
 * customer C, the API issues a capability scoped to C's orders. The model can then name
 * any order id it likes in a tool call; if that order is not in scope, the plan is denied
 * before any question of amounts or thresholds arises. Prompt injection can change what
 * the model asks for. It cannot change what the session is allowed to affect.
 */
export interface CapabilityScope {
  /**
   * Resource ids this session may affect, by kind. An empty array for a kind means *no*
   * resources of that kind are in scope -- deny by default, never allow-all. The absence
   * of a wildcard is deliberate; a wildcard capability is the thing that leaks.
   */
  readonly orders: readonly string[];
  readonly payments: readonly string[];
  readonly subscriptions: readonly string[];
  readonly customers: readonly string[];
}

export interface CapabilityLimits {
  currency: Currency;
  /** Largest single action, measured against `plan.totals.notional`. */
  perActionMaxMinor: number;
  /** Total outflow this session may cause, measured against `merchantOutflow`. */
  sessionBudgetMinor: number;
  /** Total outflow this subject may cause today, across sessions. */
  dailyBudgetMinor: number;
  /**
   * Consecutive denied proposals before the session is cut off. A model that is being
   * driven by injected instructions tends to retry variations of the same forbidden
   * action; this turns that pattern into a stop rather than an unbounded loop.
   */
  maxDeniedAttempts: number;
}

export interface Capability {
  capId: string;
  tenantId: string;
  sessionId: string;
  /** Who is acting, e.g. `agent:support` or `agent:billing-ops`. */
  subject: string;
  actions: readonly ActionKind[];
  scope: CapabilityScope;
  limits: CapabilityLimits;
  /**
   * Plans whose outflow is at or below this amount may execute without a human. Above
   * it, the plan goes to the approval queue. Set to 0 to require approval for everything
   * that moves money.
   */
  autoApproveBelowMinor: number;
  /** Actions that always require a human regardless of amount. */
  alwaysApprove: readonly ActionKind[];
  issuedAt: string;
  notAfter: string;
  /** Random per-issue value; makes two otherwise identical capabilities distinguishable
   *  and gives the revocation list a stable key. */
  nonce: string;
}

export interface SignedCapability {
  capability: Capability;
  /** base64url Ed25519 signature over the canonical serialization of `capability`. */
  signature: string;
}

const CAPABILITY_DOMAIN = 'warrant.capability.v1';

function capabilityBytes(cap: Capability): Buffer {
  return Buffer.from(`${CAPABILITY_DOMAIN} ${canonicalize(cap as never)}`, 'utf8');
}

export function signCapability(cap: Capability, privateKeyPem: string): SignedCapability {
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, capabilityBytes(cap), key).toString('base64url');
  return { capability: cap, signature };
}

export type CapabilityVerification =
  | { valid: true }
  | { valid: false; reason: 'bad_signature' | 'malformed' };

/**
 * Verify the signature only. Expiry, tenant, scope and limits are *not* checked here:
 * they are policy, and they are evaluated in `authorize` against a compiled plan. Keeping
 * the two apart means the signature check has one job and cannot be accidentally
 * satisfied by a policy pass.
 */
export function verifyCapability(
  signed: SignedCapability,
  publicKeyPem: string,
): CapabilityVerification {
  try {
    const key = createPublicKey(publicKeyPem);
    const sig = Buffer.from(signed.signature, 'base64url');
    const okSig = verify(null, capabilityBytes(signed.capability), key, sig);
    return okSig ? { valid: true } : { valid: false, reason: 'bad_signature' };
  } catch {
    return { valid: false, reason: 'malformed' };
  }
}

export function scopeFor(scope: CapabilityScope, kind: ResourceKind): readonly string[] {
  switch (kind) {
    case 'order':
      return scope.orders;
    case 'payment':
      return scope.payments;
    case 'subscription':
      return scope.subscriptions;
    case 'customer':
      return scope.customers;
  }
}

export const EMPTY_SCOPE: CapabilityScope = {
  orders: [],
  payments: [],
  subscriptions: [],
  customers: [],
};
