import { Db } from './db/db';
import { loadConfig } from './config';

/**
 * Deterministic demo data.
 *
 * Fixed ids so the demo script and the eval suite can refer to them directly, and so a
 * reader can follow a refund from the seed through the audit trail without cross
 * referencing generated uuids.
 *
 * The shape is chosen to make the interesting cases reachable: one order paid by a single
 * Stripe capture (the ordinary path), one order split across two processors (which the
 * compiler must refuse to refund in one go), and an uncaptured authorization (capture and
 * void).
 */
export const DEMO = {
  tenantId: 'ten_demo',
  otherTenantId: 'ten_rival',
  customerId: 'cus_amara',
  otherCustomerId: 'cus_bystander',
  orderId: 'ord_1001',
  otherCustomerOrderId: 'ord_2001',
  splitOrderId: 'ord_1002',
  authOrderId: 'ord_1003',
  paymentId: 'pay_1001',
  authPaymentId: 'pay_1003',
  subscriptionId: 'sub_1001',
  stripeAccountId: 'pa_stripe_demo',
  adyenAccountId: 'pa_adyen_demo',
  webhookSecret: 'whsec_simulated',
} as const;

/**
 * Return the demo tenant to its starting state.
 *
 * The demo deliberately mutates the world -- it opens a chargeback mid-approval -- so
 * without this a second run finds ord_1001 already disputed and the "legitimate refund"
 * step fails for entirely correct reasons. A demo that only works once is a demo nobody
 * trusts, and a reviewer running it twice is exactly the person to convince.
 *
 * This takes the *admin* connection, not the application one, and that is not an
 * accident. The first version of this function ran as the application role and failed
 * with `permission denied for table domain_events`, because migration 003 revokes DELETE
 * on the append-only tables. That refusal is the feature working. Erasing evidence is an
 * operator action, so it uses an operator's credentials.
 */
export async function resetDemoState(admin: Db): Promise<void> {
  const t = DEMO;
  await admin.withTenant(t.tenantId, async (sql) => {
    // Order matters: children before parents, and the ledger before the executions it
    // references.
    await sql.query('DELETE FROM domain_events WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM deferred_events WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM processor_events WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM refunds WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM disputes WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM ledger_entries WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM audit_events WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM approvals WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM executions WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM effect_plans WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM intents WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM capability_usage WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM capabilities WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM agent_sessions WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM reconciliation_findings WHERE tenant_id = $1', [t.tenantId]);
    await sql.query('DELETE FROM outbox WHERE tenant_id = $1', [t.tenantId]);

    await sql.query(
      `UPDATE orders SET state = 'paid', version = 1 WHERE tenant_id = $1 AND id = ANY($2)`,
      [t.tenantId, [t.orderId, t.splitOrderId, t.otherCustomerOrderId]],
    );
    await sql.query(
      `UPDATE orders SET state = 'authorized', version = 1 WHERE tenant_id = $1 AND id = $2`,
      [t.tenantId, t.authOrderId],
    );
    await sql.query(
      `UPDATE payments SET state = 'captured', captured_minor = authorized_minor, version = 1
        WHERE tenant_id = $1 AND id <> $2`,
      [t.tenantId, t.authPaymentId],
    );
    await sql.query(
      `UPDATE payments SET state = 'requires_capture', captured_minor = 0, captured_at = NULL, version = 1
        WHERE tenant_id = $1 AND id = $2`,
      [t.tenantId, t.authPaymentId],
    );
    await sql.query(
      `UPDATE subscriptions SET state = 'active', cancel_at = NULL, version = 1 WHERE tenant_id = $1`,
      [t.tenantId],
    );
  });

}

export async function seed(db: Db): Promise<void> {
  const t = DEMO;

  await db.withoutTenant(async (sql) => {
    await sql.query(
      `INSERT INTO tenants (id, name, default_currency) VALUES ($1,'Northwind Supply','USD'), ($2,'Rival Goods','USD')
       ON CONFLICT (id) DO NOTHING`,
      [t.tenantId, t.otherTenantId],
    );
  });

  await db.withTenant(t.tenantId, async (sql) => {
    await sql.query(
      `INSERT INTO customers (id, tenant_id, email) VALUES ($1,$3,'amara@example.test'), ($2,$3,'bystander@example.test')
       ON CONFLICT (id) DO NOTHING`,
      [t.customerId, t.otherCustomerId, t.tenantId],
    );

    await sql.query(
      `INSERT INTO processor_accounts (id, tenant_id, processor, webhook_secret, supported_currencies)
       VALUES ($1,$3,'stripe',$4,ARRAY['USD']), ($2,$3,'adyen',$4,ARRAY['USD'])
       ON CONFLICT (id) DO NOTHING`,
      [t.stripeAccountId, t.adyenAccountId, t.tenantId, t.webhookSecret],
    );

    await sql.query(
      `INSERT INTO payment_methods (id, tenant_id, customer_id, vault_token, brand, last4, exp_month, exp_year, processor_tokens)
       VALUES ('pm_1001',$1,$2,'vault_tok_amara','visa','4242',12,2030,'{"stripe":"pm_stripe_1","adyen":"pm_adyen_1"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [t.tenantId, t.customerId],
    );

    // The main order: 100.00 fully captured on Stripe.
    await sql.query(
      `INSERT INTO orders (id, tenant_id, customer_id, state, total_minor, currency)
       VALUES ($1,$2,$3,'paid',10000,'USD') ON CONFLICT (id) DO NOTHING`,
      [t.orderId, t.tenantId, t.customerId],
    );
    await sql.query(
      `INSERT INTO payments (id, tenant_id, order_id, processor_account_id, processor, payment_method_id,
                             state, authorized_minor, captured_minor, currency, authorized_at, captured_at,
                             auth_expires_at, processor_reference)
       VALUES ($1,$2,$3,$4,'stripe','pm_1001','captured',10000,10000,'USD',
               now() - interval '6 days', now() - interval '6 days', now() + interval '1 day','ch_demo_1001')
       ON CONFLICT (id) DO NOTHING`,
      [t.paymentId, t.tenantId, t.orderId, t.stripeAccountId],
    );

    // A different customer's order, used to show that scope is not a suggestion.
    await sql.query(
      `INSERT INTO orders (id, tenant_id, customer_id, state, total_minor, currency)
       VALUES ($1,$2,$3,'paid',50000,'USD') ON CONFLICT (id) DO NOTHING`,
      [t.otherCustomerOrderId, t.tenantId, t.otherCustomerId],
    );
    await sql.query(
      `INSERT INTO payment_methods (id, tenant_id, customer_id, vault_token, brand, last4, exp_month, exp_year, processor_tokens)
       VALUES ('pm_2001',$1,$2,'vault_tok_bystander','visa','1881',6,2029,'{"stripe":"pm_stripe_2"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [t.tenantId, t.otherCustomerId],
    );
    await sql.query(
      `INSERT INTO payments (id, tenant_id, order_id, processor_account_id, processor, payment_method_id,
                             state, authorized_minor, captured_minor, currency, authorized_at, captured_at,
                             auth_expires_at, processor_reference)
       VALUES ('pay_2001',$1,$2,$3,'stripe','pm_2001','captured',50000,50000,'USD',
               now() - interval '3 days', now() - interval '3 days', now() + interval '4 days','ch_demo_2001')
       ON CONFLICT (id) DO NOTHING`,
      [t.tenantId, t.otherCustomerOrderId, t.stripeAccountId],
    );

    // A split-tender order: half Stripe, half Adyen.
    await sql.query(
      `INSERT INTO orders (id, tenant_id, customer_id, state, total_minor, currency)
       VALUES ($1,$2,$3,'paid',12000,'USD') ON CONFLICT (id) DO NOTHING`,
      [t.splitOrderId, t.tenantId, t.customerId],
    );
    await sql.query(
      `INSERT INTO payments (id, tenant_id, order_id, processor_account_id, processor, payment_method_id,
                             state, authorized_minor, captured_minor, currency, authorized_at, captured_at,
                             auth_expires_at, processor_reference)
       VALUES ('pay_1002a',$1,$2,$3,'stripe','pm_1001','captured',6000,6000,'USD',
               now() - interval '5 days', now() - interval '5 days', now() + interval '2 days','ch_demo_1002a'),
              ('pay_1002b',$1,$2,$4,'adyen','pm_1001','captured',6000,6000,'USD',
               now() - interval '5 days', now() - interval '5 days', now() + interval '2 days','ch_demo_1002b')
       ON CONFLICT (id) DO NOTHING`,
      [t.tenantId, t.splitOrderId, t.stripeAccountId, t.adyenAccountId],
    );

    // An authorization that has not been captured yet.
    await sql.query(
      `INSERT INTO orders (id, tenant_id, customer_id, state, total_minor, currency)
       VALUES ($1,$2,$3,'authorized',7500,'USD') ON CONFLICT (id) DO NOTHING`,
      [t.authOrderId, t.tenantId, t.customerId],
    );
    await sql.query(
      `INSERT INTO payments (id, tenant_id, order_id, processor_account_id, processor, payment_method_id,
                             state, authorized_minor, captured_minor, currency, authorized_at,
                             auth_expires_at, processor_reference)
       VALUES ($1,$2,$3,$4,'stripe','pm_1001','requires_capture',7500,0,'USD',
               now() - interval '1 day', now() + interval '6 days','pi_demo_1003')
       ON CONFLICT (id) DO NOTHING`,
      [t.authPaymentId, t.tenantId, t.authOrderId, t.stripeAccountId],
    );

    await sql.query(
      `INSERT INTO subscriptions (id, tenant_id, customer_id, state, amount_minor, currency, interval_days,
                                  current_period_end, payment_method_id)
       VALUES ($1,$2,$3,'active',4900,'USD',30, now() + interval '22 days','pm_1001')
       ON CONFLICT (id) DO NOTHING`,
      [t.subscriptionId, t.tenantId, t.customerId],
    );
  });
}

if (require.main === module) {
  const config = loadConfig();
  const db = new Db(config.DATABASE_URL);
  seed(db)
    .then(() => process.stdout.write('seeded\n'))
    .catch((err: Error) => {
      process.stderr.write(`${err.stack}\n`);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}
