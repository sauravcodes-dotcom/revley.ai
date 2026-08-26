# Architecture

## Component boundaries

```
packages/core/          PURE. No I/O, no clock, no network.
  money/                Integer minor units + currency. No floats anywhere.
  domain/               Entities, branded ids, state machines.
  hash/                 Canonical JSON serialization and domain-separated digests.
  compiler/             compile(), invariants, derived balances, divergence check.
  authz/                Capability documents, Ed25519 signing, authorize().

apps/api/
  db/                   Connection scoping, row mappers, snapshot loader, repositories.
  agent/                Tool schemas, model provider seam, session issuance, gateway.
  execution/            Executor and effect applier.
  processors/           Strategy interface, simulator, Stripe adapter, circuit breaker.
  webhooks/             Signature verification, normalization, out-of-order applier.
  audit/                Hash-chained append-only audit log.
  evals/                The evaluation suite.

db/                     SQL migrations, migration runner, RLS isolation tests.
```

The boundary that matters is the first one. `packages/core` has no dependency on
`apps/api`, cannot open a connection, and cannot read the time. Everything interesting —
what a refund does to the books, whether it is admissible, whether a grant permits it —
is a deterministic function there. That is why the compiler can be exhaustively property
tested, and why recompiling the same intent later is a meaningful comparison rather than
a coincidence.

## The effect plan

```ts
interface EffectPlan {
  action: ActionKind;
  ledger: LedgerDelta[];        // signed, must sum to zero per currency
  transitions: Transition[];    // {entity, id, from, to, effectiveAt?}
  route: Route | null;          // pinned to the processor holding the charge
  resources: ResourceRef[];     // every entity touched, including the customer
  allocations: RefundAllocation[];
  totals: { merchantOutflow; customerReceives; notional };
  invariants: InvariantResult[];
  preconditions: Precondition[];  // observed facts, re-checked at commit
  riskFlags: RiskFlag[];
  effectHash: string;           // financial semantics only
  routeHash: string;            // route only
  admissible: boolean;
}
```

### Why two hashes

`effectHash` covers action, tenant, ledger, transitions, resources, allocations and
totals. `routeHash` covers only the chosen processor account.

A failover to a healthy processor account does not change what happens to the merchant's
money, only which pipe it goes through. Splitting the hashes lets a merchant
pre-authorize that ("`allowRouteChange: true`", the default) without loosening anything
about amounts. Under `STRICT_TOLERANCE` a route change also invalidates the approval.

### Why `resources` exists separately

Authorization scope is checked against every entity the plan *touches*, not the ids the
model named. A refund names an order but acts on that order's payments and pays out to
that order's customer. A capability scoped to "the customer whose thread is open" is only
enforceable if the plan states which customer it actually moves money for.

### Why `allocations` exists separately

Derivable from `transitions` only by accident. A payment whose state does not change — a
second partial refund against an already partially-refunded charge — emits no transition,
and the executor would have no charge reference to call the processor with. The split is
also part of the effect hash: refunding $60 from one charge is a different effect from
splitting it across two.

## Data model

Money is `BIGINT` minor units plus `CHAR(3)` currency. No `numeric`, no float. `pg`
returns bigint as a string; the mappers parse and range-check rather than coercing with
`Number()` at the call site.

Tables, grouped:

| Group | Tables |
|---|---|
| Commerce | `tenants` `customers` `processor_accounts` `payment_methods` `orders` `payments` `refunds` `disputes` `subscriptions` |
| Agent path | `agent_sessions` `capabilities` `capability_usage` `intents` `effect_plans` `approvals` `executions` |
| Money | `ledger_entries` |
| Events | `processor_events` `domain_events` `deferred_events` `outbox` |
| Evidence | `audit_events` `reconciliation_findings` |

Constraints that carry weight:

- `payments`: `CHECK (captured_minor <= authorized_minor)` — you cannot capture more than
  the issuer authorized, enforced by the database and not only by the compiler.
- `executions`: `UNIQUE (idempotency_key)` — makes duplicate execution impossible rather
  than unlikely.
- `refunds`: `UNIQUE (execution_id) WHERE execution_id IS NOT NULL` — one execution can
  never produce two refund rows.
- `processor_events`: `UNIQUE (processor_account_id, processor_event_id)` — the entire
  duplicate-webhook defence is this index.
- `audit_events`, `ledger_entries`: `DELETE`/`UPDATE` revoked from the application role.

### Tenant isolation

Two layers.

Every repository query carries an explicit `tenant_id` predicate. That is the control.

Row-level security on all 22 tenant-scoped tables is the backstop. `warrant.tenant_id` is
set with `set_config(..., true)` — transaction-local, so it cannot leak across a pooled
connection — and every policy compares against it. `current_setting(..., true)` returns
NULL when unset, so an unscoped connection matches nothing and sees an empty database.
Failing closed is deliberate.

`FORCE ROW LEVEL SECURITY` is set so the table owner is not exempt. This is still not
sufficient on its own: superusers bypass RLS unconditionally and `FORCE` does not apply to
them, which is why the application connects as `warrant_app` (`NOSUPERUSER`,
`NOBYPASSRLS`) and only migrations use the owner. `db/rls.test.mjs` asserts all of this
from outside, as the application role.

## State machines

Five: order, payment, refund, dispute, subscription. Each declares legal transitions,
terminal states, and a **rank**.

Rank gives every state a monotonic position, and it is what makes out-of-order webhooks
tractable. The applier does not need to know delivery order; it asks whether the incoming
event would move the entity *backwards*. A `refund.succeeded` arriving after a recorded
failure is old news, and applying it would silently resurrect money that never moved.
Terminal states absorb, which is what makes replayed webhooks safe.

## The execution path

```
1. re-verify   recompile against fresh state inside REPEATABLE READ; diff vs approved
2. claim       INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING
3. call        processor.refund/capture/void with the idempotency key
4. settle      apply ledger + transitions + refund row + execution result, one transaction
```

The order is the safety argument:

- **1 before 2** — a stale plan never reaches the processor.
- **2 before 3** — a concurrent duplicate loses the insert race and reads the winner's
  result rather than placing a second call. There is no check-then-act window; an
  `if (!exists) insert` would have one.
- **4 atomic** — the ledger and the execution record cannot disagree about what happened.

### Unknown outcomes

A timeout, a 5xx or a 429 returns `indeterminate`, never `failed`. The distinction is the
difference between "it did not happen" and "we do not know", and only one of them is safe
to retry.

```
indeterminate
   └─▶ processor.lookup(idempotencyKey)
         ├─ found, succeeded  ─▶ record as the success it was
         ├─ found, failed     ─▶ record as failed, retryable
         └─ not found         ─▶ park as INDETERMINATE
                                 + reconciliation finding
                                 + audit record
                                 no retry, no guess
```

Parking is not a cop-out. An unresolvable unknown is a real state, and pretending
otherwise is what turns one ambiguous refund into silent ledger drift.

### Idempotency key derivation

`digest('warrant.idempotency.v1', { planId, effectHash })`.

Keying on `effectHash` alone breaks legitimate repeats: after one $10 refund lands, a
second identical $10 refund compiles to the same ledger delta and the same (empty)
transitions, so the same hash. Keying on `planId` alone breaks retries, because
re-verification compiles a fresh plan each time. Both together scope idempotency to one
approved plan, which is the semantics actually wanted.

## Concurrency

| Concern | Mechanism |
|---|---|
| Snapshot consistency during compilation | `REPEATABLE READ` transaction; four queries cannot observe four different moments |
| Duplicate execution | unique index on `idempotency_key` |
| Budget races | `capability_usage` row locked `FOR UPDATE` in the same transaction that stores the plan |
| Audit chain forks | `pg_advisory_xact_lock` per tenant around append |
| Stale writes | compare-and-set on state (`WHERE ... AND state = $from`) plus `version` counters |
| Queue consumers | `FOR UPDATE SKIP LOCKED` on the outbox |

A note on `pg` clients: a client is a single connection with one wire protocol stream.
Concurrent `Promise.all` queries on the same client are queued at best and an error in
pg 9. All multi-query reads are sequential.

## Audit

Append-only, hash-chained per tenant. Each row commits to its predecessor's hash, so
altering or deleting a record breaks verification for everything after it. `verifyChain`
recomputes from the beginning and reports the first record that does not verify.

This is tamper-**evidence**, not tamper-proofing. It does not stop someone with database
access from rewriting history; it makes the rewrite detectable. The application role's
`DELETE`/`UPDATE` grants on `audit_events` are revoked so the application itself cannot
try.

One record per pipeline stage: `TOOL_REQUEST`, `VALIDATION`, `COMPILATION`,
`AUTHORIZATION`, `APPROVAL_*`, `REVERIFICATION`, `RESULT`, `WEBHOOK`. "Where did this go
wrong" becomes a query — a trace with a `VALIDATION` but no `AUTHORIZATION` tells you the
tool call never parsed.

## The model seam

```ts
interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelTurn>;
}
```

Two implementations: `AnthropicModelProvider` (live) and `FixtureModelProvider`
(replays recorded turns, keyed by an explicit `[scenario:id]` marker rather than by
matching prompt text — prompt-matching fixtures stop matching when a prompt is reworded
and then quietly return the wrong scenario forever).

The fixture provider is not a testing shortcut. An eval that calls a live model measures
the model and the system together and cannot tell you which one changed between runs.

## Processors

```ts
interface PaymentProcessor {
  refund(op): Promise<ProcessorOutcome>;
  capture(op): Promise<ProcessorOutcome>;
  voidAuthorization(op): Promise<ProcessorOutcome>;
  lookup(idempotencyKey): Promise<LookupResult>;
  verifyWebhook(rawBody, headers, secret, now): WebhookVerification;
}
```

The interface is narrow on purpose: an adapter performs an already-authorized effect. It
does not decide amounts, choose routes or read the ledger. An adapter is the least
trustworthy place to put a decision — the code most likely to be written against a
vendor's quirks and least likely to be read carefully afterwards.

`verifyWebhook` takes the **raw body**, not a parsed object. Every processor signs the
exact bytes it sent; re-serializing parsed JSON changes them, and verifying a
re-serialized body is a check that passes for the wrong reasons and fails for the right
ones.

The circuit breaker is keyed on the processor **account**, not the processor. One
merchant's Adyen account can be suspended while every other merchant's works fine. Only
infrastructure failures move it — a declined card is a healthy processor saying no, and
counting it would open the breaker on a merchant whose customers have expired cards.

### The simulator

Fault injection is a pure function of `(seed, idempotencyKey, purpose)` via SHA-256, so
replaying a specific key always reproduces the same behaviour. No `Math.random`. The
aggregate sample across a run still varies, because the key derives from a random plan id
— which is why the eval assertions are invariants rather than expected counts.

It models the behaviour that separates a real processor from a mock: it is genuinely
idempotent, *including* the case where the first attempt returned `indeterminate` to the
caller after having actually succeeded. That is the case a blind retry turns into a double
refund, and it cannot be produced on demand against a real gateway.

## Deployment shape

Not built, but the design assumes: the API as a stateless service behind a load balancer,
Postgres as the only stateful dependency, the outbox drained by the same image running in
a worker mode. No broker, no cache. Horizontal scale is bounded by Postgres write
throughput; the first thing that would need to change at 10x is moving the outbox drain to
partitioned consumers, and the audit chain's per-tenant advisory lock to per-tenant
sharding.
