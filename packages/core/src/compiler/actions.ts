import type { Currency } from '../money';

/**
 * The complete set of state-changing actions an agent may *propose*.
 *
 * There is no `execute` action, and no tool in the model-facing schema performs one.
 * The agent's only write primitive is `propose_action`, which produces one of these.
 * Removing the capability from the model's reach is stronger than guarding it, because
 * it makes "the model was talked into executing" an unrepresentable state rather than a
 * check that could be bypassed.
 */
export const ACTION_KINDS = [
  'refund.issue',
  'payment.capture',
  'payment.void',
  'subscription.cancel',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export function isActionKind(v: unknown): v is ActionKind {
  return typeof v === 'string' && (ACTION_KINDS as readonly string[]).includes(v);
}

export interface RefundIssueParams {
  orderId: string;
  amountMinor: number;
  currency: Currency;
  reason: string;
}

export interface PaymentCaptureParams {
  paymentId: string;
  amountMinor: number;
  currency: Currency;
}

export interface PaymentVoidParams {
  paymentId: string;
  reason: string;
}

export interface SubscriptionCancelParams {
  subscriptionId: string;
  atPeriodEnd: boolean;
  reason: string;
}

export type ActionParams =
  | { kind: 'refund.issue'; params: RefundIssueParams }
  | { kind: 'payment.capture'; params: PaymentCaptureParams }
  | { kind: 'payment.void'; params: PaymentVoidParams }
  | { kind: 'subscription.cancel'; params: SubscriptionCancelParams };

/**
 * A structured request emitted by the model and validated at the tool gateway.
 *
 * `provenance` records where the content that produced this intent came from. An intent
 * derived from a conversation containing untrusted third-party text is not refused on
 * that basis alone, but it is a signal the policy layer may weigh, and it is recorded in
 * the audit trail so a post-incident reviewer can answer "what was in the context window
 * when the model asked for this?".
 */
export interface Intent {
  id: string;
  tenantId: string;
  sessionId: string;
  action: ActionParams;
  /**
   * Free text the model produced to justify the action. Never parsed, only displayed
   * and logged. It has no authority over anything.
   */
  rationale: string;
  provenance: {
    /** Content sources present in the model's context when it produced this intent. */
    sources: readonly string[];
    /**
     * True when at least one source is attacker-influenceable: customer messages,
     * order notes, product reviews, processor webhook metadata.
     */
    containsUntrustedContent: boolean;
  };
  createdAt: string;
}
