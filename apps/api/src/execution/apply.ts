import type { EffectPlan } from '@warrant/core';
import type { Sql } from '../db/db';
import { newId } from '../db/warrant.repository';

/**
 * Apply a plan's effects to the database.
 *
 * This is the only code in the system that writes commerce state as a result of an agent
 * action, and it writes exactly what the plan says -- the ledger deltas, the state
 * transitions and the refund rows the compiler computed. It does no arithmetic of its own
 * and makes no decisions. If this function had to work out how much to refund, the plan
 * a human approved and the money that actually moved could differ, and the whole premise
 * of approving effects would be gone.
 *
 * Runs inside the caller's transaction, alongside the execution row update, so state and
 * ledger either both land or neither does.
 */
export async function applyPlanEffects(
  sql: Sql,
  tenantId: string,
  plan: EffectPlan,
  executionId: string,
  processorReference: string | null,
): Promise<void> {
  for (const delta of plan.ledger) {
    await sql.query(
      `INSERT INTO ledger_entries (tenant_id, execution_id, account, amount_minor, currency, entity_ref, effect_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        tenantId,
        executionId,
        delta.account,
        delta.amount.minor,
        delta.amount.currency,
        delta.entityRef,
        plan.effectHash,
      ],
    );
  }

  // Refunds are created `pending`, not `succeeded`. The processor has accepted the
  // request; it has not settled it. Recording success here would mean the refundable
  // balance drops before the money actually moves, and a subsequent failure webhook would
  // have to un-refund an order. Pending is both true and, because derived balances count
  // pending refunds, safe.
  for (const alloc of plan.allocations) {
    await sql.query(
      `INSERT INTO refunds (id, tenant_id, order_id, payment_id, state, amount_minor, currency, reason, processor_reference, execution_id)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9)
       ON CONFLICT (execution_id) WHERE execution_id IS NOT NULL DO NOTHING`,
      [
        newId('ref'),
        tenantId,
        orderIdFor(plan),
        alloc.paymentId,
        alloc.amountMinor,
        plan.totals.notional.currency,
        'agent-issued refund',
        processorReference,
        executionId,
      ],
    );
  }

  for (const t of plan.transitions) {
    // A scheduled transition is recorded as an intent to change later, not applied now.
    if (t.effectiveAt) {
      if (t.entity === 'subscription') {
        await sql.query(
          `UPDATE subscriptions SET cancel_at = $3, version = version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, t.id, t.effectiveAt],
        );
      }
      continue;
    }

    switch (t.entity) {
      case 'order':
        // The `state = $3` guard makes this a compare-and-set: if a concurrent writer
        // already moved the order, zero rows update and the transaction that owns the
        // execution will see a mismatch rather than clobbering the newer state.
        await sql.query(
          `UPDATE orders SET state = $4, version = version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND state = $3`,
          [tenantId, t.id, t.from, t.to],
        );
        break;
      case 'payment':
        await sql.query(
          `UPDATE payments SET state = $4, version = version + 1
            WHERE tenant_id = $1 AND id = $2 AND state = $3`,
          [tenantId, t.id, t.from, t.to],
        );
        break;
      case 'subscription':
        await sql.query(
          `UPDATE subscriptions SET state = $4, version = version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND state = $3`,
          [tenantId, t.id, t.from, t.to],
        );
        break;
      default:
        break;
    }
  }

  // Captures move money into the merchant balance and must also record the captured
  // amount on the payment itself, which the transition alone does not carry.
  if (plan.action === 'payment.capture') {
    const captured = plan.ledger.find((d) => d.account === 'merchant_balance');
    const paymentRef = captured?.entityRef.replace(/^payment:/, '');
    if (captured && paymentRef) {
      await sql.query(
        `UPDATE payments SET captured_minor = captured_minor + $3, captured_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, paymentRef, captured.amount.minor],
      );
    }
  }
}

function orderIdFor(plan: EffectPlan): string {
  const ref = plan.resources.find((r) => r.kind === 'order');
  if (!ref) throw new Error(`plan ${plan.planId} has allocations but no order resource`);
  return ref.id;
}
