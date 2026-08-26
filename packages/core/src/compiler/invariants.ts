import type { Currency, Money } from '../money';
import { format, money, sum } from '../money';
import {
  DISPUTE_SM,
  ORDER_SM,
  PAYMENT_SM,
  REFUND_SM,
  SUBSCRIPTION_SM,
  canTransition,
  type StateMachine,
} from '../domain/states';
import type { InvariantResult, LedgerDelta, Transition } from './plan';

const SM_BY_ENTITY: Record<Transition['entity'], StateMachine<string>> = {
  order: ORDER_SM as StateMachine<string>,
  payment: PAYMENT_SM as StateMachine<string>,
  refund: REFUND_SM as StateMachine<string>,
  dispute: DISPUTE_SM as StateMachine<string>,
  subscription: SUBSCRIPTION_SM as StateMachine<string>,
};

export const ok = (id: string, detail: string): InvariantResult => ({
  id,
  ok: true,
  severity: 'blocking',
  detail,
});

export const fail = (id: string, detail: string): InvariantResult => ({
  id,
  ok: false,
  severity: 'blocking',
  detail,
});

export const warn = (id: string, passed: boolean, detail: string): InvariantResult => ({
  id,
  ok: passed,
  severity: 'warning',
  detail,
});

export const check = (id: string, passed: boolean, detail: string): InvariantResult =>
  passed ? ok(id, detail) : fail(id, detail);

/**
 * Every plan's ledger must sum to zero within each currency.
 *
 * This is the single most valuable invariant in the system. A refund that debits the
 * merchant without crediting the customer, a capture that creates money out of nothing,
 * an allocation bug that double-counts a split -- all of them surface here as a nonzero
 * sum, before anything is executed and regardless of which action produced the plan.
 */
export function ledgerBalanced(ledger: readonly LedgerDelta[]): InvariantResult {
  const byCurrency = new Map<Currency, Money[]>();
  for (const d of ledger) {
    const list = byCurrency.get(d.amount.currency) ?? [];
    list.push(d.amount);
    byCurrency.set(d.amount.currency, list);
  }
  const imbalances: string[] = [];
  for (const [currency, amounts] of byCurrency) {
    const total = sum(amounts, currency);
    if (total.minor !== 0) imbalances.push(`${currency}: ${format(total)}`);
  }
  return check(
    'LEDGER_BALANCED',
    imbalances.length === 0,
    imbalances.length === 0
      ? `ledger balances across ${byCurrency.size || 0} currency bucket(s)`
      : `ledger does not sum to zero -- ${imbalances.join(', ')}`,
  );
}

/** Every transition in the plan must be legal for that entity's state machine. */
export function transitionsLegal(transitions: readonly Transition[]): InvariantResult {
  const illegal: string[] = [];
  for (const t of transitions) {
    const sm = SM_BY_ENTITY[t.entity];
    if (!canTransition(sm, t.from, t.to)) {
      illegal.push(`${t.entity}:${t.id} ${t.from} -> ${t.to}`);
    }
  }
  return check(
    'TRANSITIONS_LEGAL',
    illegal.length === 0,
    illegal.length === 0
      ? `${transitions.length} transition(s) legal`
      : `illegal transition(s): ${illegal.join('; ')}`,
  );
}

export function positiveAmount(amountMinor: number, currency: Currency): InvariantResult {
  const valid = Number.isInteger(amountMinor) && amountMinor > 0;
  return check(
    'POSITIVE_AMOUNT',
    valid,
    valid
      ? `amount ${format(money(amountMinor, currency))} is a positive integer`
      : `amount must be a positive integer number of minor units, got ${amountMinor}`,
  );
}

export function currencyMatch(requested: Currency, expected: Currency): InvariantResult {
  return check(
    'CURRENCY_MATCH',
    requested === expected,
    requested === expected
      ? `currency ${requested} matches`
      : `requested currency ${requested} does not match ${expected}`,
  );
}

export function tenantIsolation(foreign: readonly string[]): InvariantResult {
  return check(
    'TENANT_ISOLATION',
    foreign.length === 0,
    foreign.length === 0
      ? 'all entities in snapshot belong to the acting tenant'
      : `snapshot contains entities from another tenant: ${foreign.join(', ')}`,
  );
}
