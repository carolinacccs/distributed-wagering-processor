import { EntitySchema } from "@mikro-orm/core";
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
  WagerTransactionRecord,
} from "./records";

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "text", primary: true },
    playerId: { type: "text", fieldName: "player_id" },
    currency: { type: "text" },
    balance: { type: "numeric", precision: 19, scale: 2 },
    version: { type: "integer" },
    createdAt: { type: "timestamptz", fieldName: "created_at" },
    updatedAt: { type: "timestamptz", fieldName: "updated_at" },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "text", primary: true },
    walletId: { type: "text", fieldName: "wallet_id" },
    providerId: { type: "text", fieldName: "provider_id" },
    playerId: { type: "text", fieldName: "player_id" },
    externalTransactionId: { type: "text", fieldName: "external_transaction_id" },
    idempotencyKey: { type: "text", fieldName: "idempotency_key" },
    kind: { type: "text" },
    status: { type: "text" },
    amount: { type: "numeric", precision: 19, scale: 2 },
    currency: { type: "text" },
    roundId: { type: "text", fieldName: "round_id", nullable: true },
    referenceId: { type: "text", fieldName: "reference_id", nullable: true },
    referenceExternalTransactionId: {
      type: "text",
      fieldName: "reference_external_transaction_id",
      nullable: true,
    },
    payloadHash: { type: "text", fieldName: "payload_hash" },
    failureCode: { type: "text", fieldName: "failure_code", nullable: true },
    responseBalance: {
      type: "numeric",
      precision: 19,
      scale: 2,
      fieldName: "response_balance",
      nullable: true,
    },
    referenceAttempts: { type: "integer", fieldName: "reference_attempts" },
    nextReferenceAttemptAt: {
      type: "timestamptz",
      fieldName: "next_reference_attempt_at",
    },
    createdAt: { type: "timestamptz", fieldName: "created_at" },
    updatedAt: { type: "timestamptz", fieldName: "updated_at" },
  },
});

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "text", primary: true },
    walletId: { type: "text", fieldName: "wallet_id" },
    transactionId: { type: "text", fieldName: "transaction_id" },
    direction: { type: "text" },
    amount: { type: "numeric", precision: 19, scale: 2 },
    currency: { type: "text" },
    balanceBefore: { type: "numeric", precision: 19, scale: 2, fieldName: "balance_before" },
    balanceAfter: { type: "numeric", precision: 19, scale: 2, fieldName: "balance_after" },
    createdAt: { type: "timestamptz", fieldName: "created_at" },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: "inbox_messages",
  properties: {
    id: { type: "text", primary: true },
    consumerName: { type: "text", fieldName: "consumer_name" },
    messageId: { type: "text", fieldName: "message_id" },
    body: { type: "text" },
    receivedAt: { type: "timestamptz", fieldName: "received_at" },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "text", primary: true },
    messageId: { type: "text", fieldName: "message_id" },
    eventType: { type: "text", fieldName: "event_type" },
    body: { type: "text" },
    createdAt: { type: "timestamptz", fieldName: "created_at" },
    publishedAt: { type: "timestamptz", fieldName: "published_at", nullable: true },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "timestamptz", fieldName: "next_attempt_at" },
    leaseToken: { type: "text", fieldName: "lease_token", nullable: true },
    leasedUntil: { type: "timestamptz", fieldName: "leased_until", nullable: true },
    lastError: { type: "text", fieldName: "last_error", nullable: true },
  },
});

export const persistenceEntities = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
