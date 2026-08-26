# Threat model

## What is being defended

A merchant's money, and the integrity of the record of what happened to it.

## Trust boundaries

```
UNTRUSTED   customer messages, order notes, product reviews, webhook bodies,
            anything a third party can write

SEMI        the model's output. Not malicious, but steerable by anything above.
            Treated as a well-formed *request*, never as an authority.

TRUSTED     the operator's session context (which customer's thread is open),
            the capability signing key, the database, the migration path
```

The load-bearing assumption: **the model will be compromised.** Not might be. The design
question is not how to prevent that but what an attacker gets when it happens.

## Attacker capabilities assumed

An attacker can:

- write arbitrary text that reaches the model's context window
- cause the model to emit any syntactically valid tool call, with any arguments
- send arbitrary HTTP to the webhook endpoint, including replays of captured bodies
- submit the same request many times, concurrently
- know the system's design (this document is public)

An attacker cannot:

- read or forge the capability signing key
- write directly to the database
- alter an operator's session context

---

## Threats and mitigations

### T1 — Prompt injection escalating to money movement

**Attack.** Customer message claims elevated authority: pre-approved refund limits, a
manager override, a "system notice". The model believes it and proposes accordingly.

**Mitigation — layered, and none of them the prompt.**

| Layer | What it does |
|---|---|
| No execute verb | The model's only write primitive is `propose_action`. There is no tool that moves money, so no amount of persuasion reaches one. |
| Capability scope | Computed from the operator's session context and Ed25519-signed *before the model produces a token*. Injected text cannot widen it. |
| Effect-level authorization | `authorize()` receives a compiled plan and a signed grant. No model-authored string is an input. |
| Domain invariants | Refunds beyond captured, refunds on disputed orders, illegal transitions — refused regardless of who asked. |
| Amount bounds | Per-action cap on notional, session and daily budgets on outflow. |
| Provenance flag | Untrusted content in context forces human review even for a trivial amount. |
| Denial circuit | Consecutive denials cut the session off, turning a probing loop into a stop. |

**Residual risk.** An attacker who can convince the model to propose something *within*
scope, *within* budget, and *admissible* gets a proposal that a human sees. If the human
approves it, it executes. This is a real limit and it is deliberate: the system reduces
injection from an authorization bypass to a social-engineering problem against a human
who is shown the exact financial consequence. It does not eliminate it.

**Not relied upon.** The `<untrusted>` fencing and the system prompt's instructions are
mitigations, not controls. They reduce how often the model is fooled. Every guarantee
above holds whether or not they work.

**Evidence.** 12-attack corpus, every fixture a model that has already been compromised.
0.00 USD moved. Each attack asserted against the specific control expected to stop it, so
a shift to a weaker layer fails the suite.

### T2 — Time-of-check to time-of-use on an approval

**Attack.** Not necessarily adversarial — usually just concurrency. An approval is granted
at T0 and committed at T+n, during which a chargeback lands, another refund consumes the
balance, or the authorization expires. The approved tool call remains syntactically valid.

**Mitigation.** The intent is recompiled against state read inside the commit transaction
and diffed against the approved plan. Divergence in the financial effect aborts. Approvals
also carry a TTL and record the effect hash the human actually saw, so a rewritten plan
row cannot inherit an existing approval.

**Residual risk.** The window between re-verification and the processor call is not zero.
A chargeback landing inside that window still results in a refund on a disputed order.
Closing it entirely would require a distributed transaction with the processor, which does
not exist. The window is milliseconds rather than minutes, and reconciliation surfaces the
result.

**Evidence.** 4/4 stale commits prevented across four distinct mutations, with a control
case asserting an unchanged world still commits — otherwise the check would be an
unconditional refusal that passes every test and is useless.

### T3 — Cross-tenant access

**Attack.** A capability or an identifier from one merchant used against another's data.

**Mitigation.** Snapshots are loaded tenant-scoped, so a foreign id resolves to
`RESOURCE_NOT_FOUND` rather than `FORBIDDEN` — the boundary is enforced by what is
loadable, and an attacker learns nothing about whether the id exists elsewhere. Every
query carries a tenant predicate. Row-level security is the backstop, with the application
connecting as a `NOSUPERUSER NOBYPASSRLS` role. A `TENANT_ISOLATION` invariant in the
compiler catches a loader bug. `authorize()` re-checks tenant match on the plan.

**Evidence.** `db/rls.test.mjs`, 9 checks, run as the application role: unfiltered SELECT
returns only the current tenant, an explicit cross-tenant SELECT returns nothing, an
unscoped connection sees an empty database, a cross-tenant INSERT is refused, a
cross-tenant UPDATE is a no-op.

**Known history.** This protection was inert on first implementation — see README. It is
listed here because a control that has never been observed refusing something is not known
to work.

### T4 — Capability forgery or escalation

**Attack.** Modify a capability's scope, limits or expiry after issue.

**Mitigation.** Ed25519 signature over a canonical serialization of the whole document,
verified on **every proposal**, not once at session open — a grant held in memory for the
length of a conversation can be mutated by anything else in that process. Canonical
serialization means key reordering cannot produce a different signed payload.

**Evidence.** Unit tests assert that raising a limit, widening a scope, or signing with a
different key all fail verification.

**Residual risk.** The private key is the single point of failure. It lives in the
environment; there is no HSM, no rotation, no revocation list checked at authorization
time (the `revoked_at` column exists and is unused). A leaked key is a full compromise.

### T5 — Duplicate and replayed financial actions

**Attack.** Submit the same approved action many times, concurrently.

**Mitigation.** A unique index on `executions.idempotency_key`; the claim is an
`INSERT ... ON CONFLICT DO NOTHING RETURNING`, so losers read the winner's row instead of
calling the processor. The same key is passed to the processor, which enforces its own
idempotency. `refunds.execution_id` is uniquely indexed. Duplicate *intent* — the same
effect proposed again minutes later — is surfaced to a human rather than silently
deduplicated, because only a human can tell a legitimate repeat refund from a confused
agent.

**Evidence.** Five concurrent commits of one approved plan produce exactly one execution,
one refund row, and $40.00 of outflow.

### T6 — Webhook forgery and replay

**Attack.** Post a fabricated `dispute.closed` or `refund.succeeded`; or replay a genuine
captured webhook.

**Mitigation.** HMAC verification against a per-processor-account secret, over the **raw
body**. Constant-time comparison. A timestamp tolerance window bounds replay. Unsigned
requests are rejected *before* storage, so an attacker cannot grow the events table.
Duplicate delivery collides on `UNIQUE (processor_account_id, processor_event_id)` — the
dedupe is a constraint, not an `if (alreadySeen)` with a race in the middle. Out-of-order
events are rejected by state-machine rank rather than by arrival time.

**Residual risk.** Secrets are stored in plaintext in `processor_accounts.webhook_secret`.
Per-account scoping limits the blast radius of one leak; encryption at rest is not
implemented.

### T7 — Unknown-outcome double spend

**Attack.** Not an attacker — a network. A refund request times out after the processor
already applied it. A naive retry refunds twice.

**Mitigation.** `indeterminate` is a distinct outcome from `failed` and is never retried.
It is resolved by `lookup(idempotencyKey)`; if that cannot answer, the execution is parked
and a reconciliation finding is raised for a human.

**Evidence.** 60 refunds under a 15% timeout rate where half of the timeouts had already
applied. 6 unknown outcomes, all resolved by probe, zero double refunds, zero orphan
refunds, ledger sum zero.

### T8 — Tampering with the record

**Attack.** Alter or delete audit or ledger rows to hide an action.

**Mitigation.** `audit_events` is hash-chained per tenant; `verifyChain` detects any
alteration and reports the first broken record. `DELETE` and `UPDATE` are revoked from the
application role on `audit_events` and `ledger_entries`. Rejected and denied plans are
stored, not discarded — dropping them would erase exactly the evidence that makes an
injection attempt visible afterwards.

**Residual risk.** Tamper-evidence, not tamper-proofing. Anyone with owner credentials can
rewrite history and re-chain it. Detecting that would require anchoring the chain head
somewhere the database cannot reach, which is not implemented.

### T9 — SQL injection

**Mitigation.** Parameterized queries throughout; no string interpolation of user or model
input into SQL. Identifier fields are additionally constrained by schema validation to
`[A-Za-z0-9_-]`. The tenant setting uses `set_config($1, $2, true)` with bound parameters
rather than `SET LOCAL`, which does not accept them.

**Evidence.** A `'; DROP TABLE orders;--` order identifier is rejected at schema
validation in the eval corpus.

### T10 — Resource exhaustion

**Partially mitigated.** Denial circuits bound a runaway agent session; budgets bound
spend. There is **no HTTP rate limiting**, no per-tenant connection quota, and no bound on
audit or plan table growth. A merchant could be denial-of-serviced by volume.

---

## Deliberately not automated

Stated because the omissions are decisions, not gaps.

- **Approving anything above the auto-approve threshold.** A human sees the computed
  effect.
- **Retrying an unknown outcome.** Resolved by evidence or parked.
- **Reconciling a detected drift.** Findings are raised; nothing self-heals a ledger
  discrepancy.
- **Deciding whether a repeat refund is legitimate.** Surfaced, never guessed.
- **Splitting a refund that spans two processors.** Refused with an explanation; the
  operator decides.

## Summary of residual risk

| # | Residual | Severity |
|---|---|---|
| T1 | In-scope, in-budget, admissible proposal approved by a fooled human | Medium |
| T2 | Millisecond window between re-verification and processor call | Low |
| T4 | Signing key compromise is total; no rotation or revocation check | High if realised |
| T6 | Webhook secrets stored in plaintext | Medium |
| T8 | Owner credentials can rewrite and re-chain history | Medium |
| T10 | No rate limiting or table-growth bounds | Medium |
