import { randomBytes } from 'node:crypto';
import {
  signCapability,
  type ActionKind,
  type Capability,
  type Currency,
  type SignedCapability,
} from '@warrant/core';
import type { Db, Sql } from '../db/db';
import { newId } from '../db/warrant.repository';

export interface OpenSessionInput {
  tenantId: string;
  /** The customer whose thread the operator opened. This is the trusted anchor. */
  customerId: string;
  operator: string;
  subject: string;
  actions: readonly ActionKind[];
  currency: Currency;
  perActionMaxMinor: number;
  sessionBudgetMinor: number;
  dailyBudgetMinor: number;
  autoApproveBelowMinor: number;
  alwaysApprove?: readonly ActionKind[];
  ttlSeconds?: number;
}

export interface OpenedSession {
  sessionId: string;
  capability: SignedCapability;
}

/**
 * Open an agent session and issue its capability.
 *
 * The important line in this function is the one that builds `scope`: it is a query
 * against the database for the resources belonging to the customer the *operator*
 * opened, and nothing in it comes from the model or from the conversation. That is the
 * property that makes prompt injection a bounded problem. An attacker who fully controls
 * the model's context can make it request anything; they cannot make the session's scope
 * include an order it was not opened for, because the scope was computed and signed
 * before the model produced a single token.
 *
 * The grant is also short-lived by default. A capability that outlives the conversation
 * it was issued for is a credential waiting to be replayed.
 */
export async function openSession(
  db: Db,
  privateKeyPem: string,
  input: OpenSessionInput,
): Promise<OpenedSession> {
  const sessionId = newId('ses');
  const now = new Date();
  const notAfter = new Date(now.getTime() + (input.ttlSeconds ?? 3600) * 1000);

  const capability = await db.withTenant(input.tenantId, async (sql) => {
    await sql.query(
      `INSERT INTO agent_sessions (id, tenant_id, subject, customer_id, operator)
       VALUES ($1,$2,$3,$4,$5)`,
      [sessionId, input.tenantId, input.subject, input.customerId, input.operator],
    );

    const scope = await scopeForCustomer(sql, input.tenantId, input.customerId);

    const cap: Capability = {
      capId: newId('cap'),
      tenantId: input.tenantId,
      sessionId,
      subject: input.subject,
      actions: input.actions,
      scope,
      limits: {
        currency: input.currency,
        perActionMaxMinor: input.perActionMaxMinor,
        sessionBudgetMinor: input.sessionBudgetMinor,
        dailyBudgetMinor: input.dailyBudgetMinor,
        maxDeniedAttempts: 3,
      },
      autoApproveBelowMinor: input.autoApproveBelowMinor,
      alwaysApprove: input.alwaysApprove ?? [],
      issuedAt: now.toISOString(),
      notAfter: notAfter.toISOString(),
      nonce: randomBytes(12).toString('base64url'),
    };

    const signed = signCapability(cap, privateKeyPem);

    await sql.query(
      `INSERT INTO capabilities (id, tenant_id, session_id, subject, document, signature, issued_at, not_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        cap.capId,
        input.tenantId,
        sessionId,
        input.subject,
        JSON.stringify(cap),
        signed.signature,
        cap.issuedAt,
        cap.notAfter,
      ],
    );

    return signed;
  });

  return { sessionId, capability };
}

/** Everything this customer owns, and nothing else. Deny by default: a customer with no
 *  orders yields empty arrays, which authorize() treats as "no resources in scope". */
async function scopeForCustomer(
  sql: Sql,
  tenantId: string,
  customerId: string,
): Promise<Capability['scope']> {
  // Sequential: one client, one connection. See loadSnapshot for the same note.
  const orders = await sql.query<{ id: string }>(
    'SELECT id FROM orders WHERE tenant_id = $1 AND customer_id = $2',
    [tenantId, customerId],
  );
  const payments = await sql.query<{ id: string }>(
    `SELECT p.id FROM payments p
       JOIN orders o ON o.id = p.order_id
      WHERE p.tenant_id = $1 AND o.customer_id = $2`,
    [tenantId, customerId],
  );
  const subscriptions = await sql.query<{ id: string }>(
    'SELECT id FROM subscriptions WHERE tenant_id = $1 AND customer_id = $2',
    [tenantId, customerId],
  );

  return {
    orders: orders.rows.map((r) => r.id),
    payments: payments.rows.map((r) => r.id),
    subscriptions: subscriptions.rows.map((r) => r.id),
    customers: [customerId],
  };
}
