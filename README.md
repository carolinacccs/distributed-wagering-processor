# Distributed Wagering Processor

Wager transaction API and background workers built with Bun, strict TypeScript,
NestJS, MikroORM, PostgreSQL, and SQS. PostgreSQL is the source of truth for
wallet balances and idempotency; LocalStack provides the local SQS queues.

## Requirements

- Bun 1.2 or newer
- Docker Compose

## Local setup

```sh
bun install
docker compose up -d --wait postgres localstack
bun run migration:up
bun run start:dev
```

The HTTP API listens on `http://localhost:3000`. To run only the consumers and
scheduled workers in another process, use `bun run start:worker`. By default,
the HTTP process also runs the SQS consumer, outbox publisher, and pending
reference worker; use `BACKGROUND_WORKERS=false` to disable those workers in an
API-only process.

The Compose file starts PostgreSQL 16 on port `5432` and LocalStack on `4566`.
LocalStack's ready hook creates:

- `wager-transactions.fifo` with a five-receive redrive policy
- `wager-transactions-dlq.fifo`
- `wager-events.fifo`

The local database defaults to database/user/password `wagering`. Override
`DATABASE_URL` when connecting to another PostgreSQL instance. SQS configuration
can be overridden with `SQS_ENDPOINT`, `WAGER_QUEUE_URL`, `WAGER_DLQ_URL`,
`EVENTS_QUEUE_URL`, and `AWS_REGION`.

## Commands

```sh
bun run typecheck
bun run build
bun test src
bun run migration:up
bun run migration:down
bun run test:integration
```

`migration:down` reverts the latest migration and is destructive to data added
by that migration. The integration command starts the local services, applies
migrations, then runs tests against real PostgreSQL and SQS; it does not use
database or SQS mocks. The integration suite starts three API processes and
also exercises consumer and publisher instances against LocalStack.

## HTTP contract

All wagering payloads require `providerId`, `playerId`, `walletId`,
`externalTransactionId`, `kind`, `amount`, `currency`, and `roundId`.
`REFUND` and `ROLLBACK` also require `referenceExternalTransactionId`.
`POST /wagering/transactions` requires the `Idempotency-Key` header.

| Method and path | Purpose |
|---|---|
| `POST /wallets` | Open a wallet for a player and currency; optional `initialBalance` is recorded as an internal `OPENING` transaction |
| `GET /wallets/:walletId` | Read a wallet |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Read ledger entries in stable keyset order |
| `POST /wallets/:walletId/reconciliation` | Compare stored balance with the ledger sum |
| `POST /wagering/transactions` | Submit a wager transaction |
| `GET /wagering/transactions/:transactionId` | Find a transaction by internal ID |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Find a provider transaction |
| `GET /health/live` | Process liveness; does not check dependencies |
| `GET /health/ready` | Readiness check for PostgreSQL and SQS |
| `GET /metrics` | Prometheus metrics |

`/health/live` and `/health/ready` do not use the authentication guard.
Business routes currently use an intentional no-op `AuthGuard` extension point;
provider authentication and authorization policy must be agreed before
enforcement is enabled. Do not expose this unauthenticated configuration as a
production security boundary.

Response status mapping: `400` invalid input, `409` idempotency conflict, `422`
business rejection, `202` waiting for a referenced transaction, and `503`
transient dependency failure. Successful and replayed submissions return
`200`; the response indicates `idempotentReplay`. Reconciliation returns
`walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent`,
and `checkedEntries`. A mismatch is logged, counted, and returned; it is never
silently repaired.

## Operational notes

Logs are JSON and avoid emitting complete financial request bodies. Prometheus
metrics include transaction counts by status, idempotent duplicates, retries,
dead letters, lock conflicts, outbox lag, operation latency, and reconciliation
divergences.

SQS and outbox delivery are at-least-once. A publisher can crash after SQS
accepts an event but before PostgreSQL marks its outbox row as published, so a
later attempt may publish a duplicate. Event consumers must deduplicate by
event/message ID. Wager consumers record `(consumer_name, message_id)` in the
same SQL transaction as the financial effect and acknowledge only after commit.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for invariants, state transitions,
retry limits, and design trade-offs.
