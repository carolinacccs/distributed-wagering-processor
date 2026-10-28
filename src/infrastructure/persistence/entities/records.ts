export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  walletId!: string;
  providerId!: string;
  playerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  kind!: string;
  status!: string;
  amount!: string;
  currency!: string;
  roundId!: string | null;
  referenceId!: string | null;
  referenceExternalTransactionId!: string | null;
  payloadHash!: string;
  failureCode!: string | null;
  responseBalance!: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export class InboxMessageRecord {
  id!: string;
  consumerName!: string;
  messageId!: string;
  body!: string;
  receivedAt!: Date;
}

export class OutboxMessageRecord {
  id!: string;
  messageId!: string;
  eventType!: string;
  body!: string;
  createdAt!: Date;
  publishedAt!: Date | null;
  attempts!: number;
  nextAttemptAt!: Date;
  leaseToken!: string | null;
  leasedUntil!: Date | null;
  lastError!: string | null;
}
