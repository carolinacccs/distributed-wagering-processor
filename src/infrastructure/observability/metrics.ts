import {
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

export const metricsRegistry = new Registry();

export const transactionCounter = new Counter({
  name: "wager_transactions_total",
  help: "Wager transaction results by status.",
  labelNames: ["status"] as const,
  registers: [metricsRegistry],
});

export const idempotentDuplicateCounter = new Counter({
  name: "wager_idempotent_duplicates_total",
  help: "Requests replayed from persistent idempotency records.",
  registers: [metricsRegistry],
});

export const retryCounter = new Counter({
  name: "wager_retries_total",
  help: "Retries scheduled for transient or unresolved work.",
  labelNames: ["component"] as const,
  registers: [metricsRegistry],
});

export const deadLetterCounter = new Counter({
  name: "wager_dead_letter_total",
  help: "Messages moved to a dead-letter queue.",
  labelNames: ["component"] as const,
  registers: [metricsRegistry],
});

export const lockConflictCounter = new Counter({
  name: "wager_lock_conflicts_total",
  help: "PostgreSQL lock conflicts and deadlocks.",
  registers: [metricsRegistry],
});

export const reconciliationDivergenceCounter = new Counter({
  name: "wallet_reconciliation_divergences_total",
  help: "Wallet ledger reconciliations that found a divergence.",
  registers: [metricsRegistry],
});

export const outboxLagGauge = new Gauge({
  name: "wager_outbox_lag_seconds",
  help: "Age of the oldest unpublished outbox entry.",
  registers: [metricsRegistry],
});

export const operationLatency = new Histogram({
  name: "wager_operation_duration_seconds",
  help: "Wagering operation latency in seconds.",
  labelNames: ["operation"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});
