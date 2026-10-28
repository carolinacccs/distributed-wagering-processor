# Architecture and invariants

## Layering and persistence

`src/domain` contains pure domain objects: `Money`, `Wallet`,
`WagerTransaction`, ledger entries, failure codes, inbox/outbox messages, and
integration events. It has no NestJS or MikroORM decorators. Application
services depend on ports; infrastructure implements those ports with MikroORM
and PostgreSQL. HTTP controllers and SQS workers both call the same
`SubmitWagerTransaction` use case.

MikroORM `EntitySchema` definitions live in
`src/infrastructure/persistence/entities/schemas.ts`. Money is persisted as
`NUMERIC(19,2)` with currency in a separate column. Database values are mapped
back into the domain with `Money.from`, which applies the domain's validation
and fixed two-decimal scale. JavaScript `number` is not used for monetary
arithmetic.

Versioned migrations create wallets, wager transactions, immutable ledger,
inbox, and outbox tables, with reversible `up` and `down` paths. Schema
constraints enforce wallet uniqueness by `(player_id, currency)`, nonnegative
balances, transaction uniqueness by provider/external ID and idempotency key,
inbox uniqueness, one ledger row per wallet/transaction, and balance arithmetic.
A database trigger rejects ledger `UPDATE` and `DELETE`; an outbox partial index
covers unpublished rows.

## Atomic submission and concurrency

`SubmitWagerTransaction` performs the transaction record, wallet mutation,
ledger insert, and outbox insert within one SQL transaction. Failures roll back
all effects. On a consumed SQS message, the inbox insert is part of this same
transaction. The consumer deletes/acknowledges the SQS message only after the
SQL commit, so a crash between commit and ack is safe to redeliver.

Wallet updates use `SELECT ... FOR UPDATE` for the targeted `wallet_id`, never a
global lock. This serializes balance checks and writes to one wallet while
allowing unrelated wallets to proceed concurrently. The unique database
constraints arbitrate concurrent requests with the same provider/external
transaction ID or idempotency key; the losing submission reads the persisted
transaction and returns its original result when the payload matches. Pessimistic
row locking is used instead of relying on optimistic-lock conflict/retry loops:
the balance decision, mutation, ledger, and outbox must be atomic, and a wallet
is a natural serialization boundary. The update also checks the previously read
version as a stale-write guard while the row lock is held; that version check is
not the concurrency strategy. The wallet version increments only when balance
changes.

Idempotency identity is persisted, not cached in process memory. The SHA-256
`payloadHash` is computed from canonical JSON of business fields only:
`amount`, `currency`, `externalTransactionId`, `kind`, `playerId`, `providerId`,
`referenceExternalTransactionId` (null when absent), `roundId`, and `walletId`.
Object keys are sorted recursively before serialization. Headers and transport
metadata (idempotency header, correlation ID, SQS message ID) are excluded.
Same identity and hash returns the original result with
`idempotentReplay: true`; a different hash is an idempotency conflict.

## Transaction states and failure codes

The HTTP/use-case kinds are `BET`, `WIN`, `REFUND`, and `ROLLBACK`. `BET` and
`ROLLBACK` debit; `WIN` and `REFUND` credit. The domain also declares
`REVERSAL`, but the submission use case does not accept it. A `REFUND` must
reference a processed `BET`; a `ROLLBACK` must reference a processed `REFUND`.
The reference must match provider, player, wallet, currency, round, and amount.
A missing or not-yet-processed reference is persisted as `PENDING_REFERENCE`.
Duplicate reversals and invalid references are rejected without a ledger row.

The domain aggregate permits only these transitions:

| From | To | Domain operation |
|---|---|---|
| `PENDING` | `PROCESSED` | `markProcessed()` |
| `PENDING` | `REJECTED` | `reject(failureCode)` |
| `PENDING` | `FAILED` | `fail(failureCode)` |

`PROCESSED`, `REJECTED`, and `FAILED` are terminal. `PENDING` and
`PENDING_REFERENCE` are non-terminal persisted statuses. `PENDING_REFERENCE`
is managed by the application/store retry workflow rather than a transition
method on the domain aggregate; a retry may process it or reject it after the
reference arrives or the retry limit is exhausted. A successful financial
mutation creates one immutable ledger entry and its event in the outbox in the
same commit. Rejections do not create a ledger entry.

All `FailureCode` values declared in `src/domain/failure-code.ts` are listed
below. The application currently emits the specifically noted codes; generic
and legacy codes remain available to domain operations and are not necessarily
returned by the HTTP submission path.

| Code | Meaning and provider action |
|---|---|
| `INSUFFICIENT_BALANCE` | Generic domain debit failure. Do not retry unchanged; resolve the balance/business condition and use a new transaction identity. |
| `INSUFFICIENT_BALANCE_FOR_BET` | BET exceeds available balance. Do not retry unchanged; resolve funds and submit as a new transaction. |
| `INSUFFICIENT_BALANCE_FOR_ROLLBACK` | Generic domain rollback debit failure. Do not retry unchanged; reconcile the reversal and submit a corrected transaction with a new identity if appropriate. |
| `REVERSAL_WOULD_NEGATIVE_BALANCE` | Generic/legacy reversal would overdraw. Do not retry unchanged; reconcile and correct the reversal. |
| `ROLLBACK_WOULD_NEGATIVE_BALANCE` | ROLLBACK would overdraw. Do not retry unchanged; reconcile the refund/reference and submit a corrected new transaction if appropriate. |
| `WALLET_BALANCE_LIMIT_EXCEEDED` | Credit exceeds the supported NUMERIC balance range. Correct the business amount or wallet handling; do not retry unchanged. |
| `REFERENCED_TRANSACTION_NOT_FOUND` | Reference did not arrive before the pending retry limit. Check provider history; do not resend the identical transaction, and correct the reference/use a new identity if resubmission is needed. |
| `INVALID_REVERSAL_REFERENCE` | Domain reference kind is invalid. Correct the referenced transaction and use a new transaction identity. |
| `INVALID_REFERENCE_TYPE` | REFUND/ROLLBACK references the wrong kind. Correct the reference and use a new identity. |
| `REFERENCE_PAYLOAD_MISMATCH` | Referenced amount differs. Correct the amount/reference and use a new identity. |
| `REFERENCE_PROVIDER_MISMATCH` | Reference belongs to another provider. Correct provider/reference and use a new identity. |
| `REFERENCE_PLAYER_MISMATCH` | Reference belongs to another player. Correct player/reference and use a new identity. |
| `REFERENCE_WALLET_MISMATCH` | Reference belongs to another wallet. Correct wallet/reference and use a new identity. |
| `WALLET_CURRENCY_MISMATCH` | Wallet/reference currency differs from the request. Correct the currency or wallet selection and use a new identity. |
| `ROUND_MISMATCH` | Reference round differs. Correct the round/reference and use a new identity. |
| `DUPLICATE_REVERSAL` | Reference already has a reversal. Do not retry; stop and reconcile. |
| `WALLET_NOT_FOUND` | Wallet is absent. Correct provisioning or wallet ID; then submit with a new identity. |
| `WALLET_PLAYER_MISMATCH` | Wallet does not belong to the supplied player. Correct player/wallet and use a new identity. |
| `CURRENCY_MISMATCH` | Generic domain Money currency mismatch. Correct the currency data; do not retry unchanged. |
| `INVALID_AMOUNT` | Domain amount is invalid. Correct the amount and request. |
| `INVALID_TRANSACTION_STATE` | A terminal/non-pending domain transaction was transitioned. Do not retry unchanged; reconcile transaction state. |
| `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` | A persisted identity/key was reused with a different payload. This is a `409`: inspect the original result, do not change-and-retry under that identity. |

The use case returns `503` for recognized transient persistence failures; the
provider should retry the same identity and payload. Missing references return
`202` while pending and are retried internally; query the transaction rather
than resending it. Once rejected, correct the cause and use a new identity.
`400` means correct the request; `409` means inspect the original result and
never reuse its identity with changed business fields; `422` means the
transaction was rejected as a business outcome and must not be blindly retried.
These provider actions are operational guidance, not an automatic retry
contract for every domain-only failure code.

## HTTP and security boundary

The API exposes wallet creation and lookup, wallet ledger keyset pagination,
wallet reconciliation, transaction submission, lookup by internal transaction
ID or provider/external ID, liveness, readiness, and Prometheus metrics.
Ledger cursors are opaque base64url-encoded keyset positions based on
`(created_at, id)`; clients should treat them as opaque and pass them back
unchanged. The ledger `limit` defaults to 50 and accepts only decimal integer
values from 1 through 100. Invalid limits and malformed cursors return `400`
with `{ code: "INVALID_QUERY", message }`.

The `AuthGuard` is deliberately a no-op extension point because no provider
credential format or authorization policy is specified. It is not
authentication. Health endpoints remain unauthenticated; production deployment
must wire and document the chosen provider authentication and wallet/provider
authorization rules before exposure.

Reconciliation locks the wallet row while comparing its stored balance with
the signed sum of ledger amounts. It reports `consistent: false`, logs a
structured divergence, and increments a metric on mismatch; it never alters
either the balance or ledger to hide divergence.

## SQS consumer and outbox publisher

`wager-transactions.fifo` has a five-receive redrive policy to
`wager-transactions-dlq.fifo`. The consumer deduplicates messages through the
database inbox. Business rejections are acknowledged. Transient errors receive
exponential visibility backoff; permanent errors and messages at the receive
limit go to the DLQ. On SIGTERM, Nest shutdown hooks stop polling and wait for
the active message, allowing successful work to commit and ack; interrupted
work remains unacknowledged for redelivery.

Outbox publishers claim rows in short transactions using
`FOR UPDATE SKIP LOCKED`, lease them, then publish only after that claim
transaction commits. Attempts and `next_attempt_at` implement capped
exponential backoff; successful sends mark the row published. A process crash
after sending but before marking can cause a duplicate, so downstream event
consumers must be idempotent. SQS FIFO deduplication reduces duplicates within
its deduplication window but is not a replacement for consumer deduplication.

The pending-reference worker scans due `PENDING_REFERENCE` transactions.
Each deferral increments `reference_attempts` and schedules a delay of
`min(900, 5 * 2^reference_attempts)` seconds. At 12 attempts it rejects with
`REFERENCED_TRANSACTION_NOT_FOUND` and inserts the rejection event into the
outbox in the same transaction. The 12-attempt limit bounds pending rows and
database work while allowing about 80 minutes of scheduled retry delay under
the current progression (actual time also includes worker polling). It is an
operational policy, not a provider guarantee; change it if reference-arrival
SLAs change.

## Observability and tests

Pino emits structured JSON with correlation/message/transaction/wallet/provider
identifiers when available, without logging full financial payloads.
Prometheus metrics cover transaction status, idempotent duplicate count,
retry and DLQ count, lock conflicts, outbox lag, operation latency, and
reconciliation divergences.

Unit tests run with `bun test src`. `bun run test:integration` starts real
PostgreSQL and LocalStack through Compose, applies migrations, and runs the
integration suite without database or SQS mocks. It covers concurrent
insufficient-balance bets, repeated idempotent submissions, distinct wallets,
commit-before-ack redelivery, concurrent publishers, out-of-order references,
multiple application processes, and process restart. The suite's final check
compares every wallet balance with the signed ledger reconstruction.

## Known limitations

The SQS transient-retry test injects a transient error at the use-case boundary;
it does not simulate PostgreSQL being offline. There is no load/performance
test. The ledger starts from zero and has no opening-balance/bootstrap entry,
so reconciliation is meaningful only for wallets whose entire balance history
is represented by ledger rows.
