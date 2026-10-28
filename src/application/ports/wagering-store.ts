import { FailureCode } from "../../domain/failure-code";
import { Money } from "../../domain/money";
import { Wallet } from "../../domain/wallet";
import {
  TransactionDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";

export interface SubmitWagerData {
  readonly id: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly kind: WagerTransactionKind;
  readonly amount: Money;
  readonly roundId: string;
  readonly referenceExternalTransactionId?: string;
  readonly payloadHash: string;
  readonly inbox?: {
    readonly consumerName: string;
    readonly messageId: string;
    readonly body: string;
  };
}

export interface WagerSnapshot {
  readonly id: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus;
  readonly amount: string;
  readonly currency: string;
  readonly roundId: string;
  readonly referenceExternalTransactionId: string | null;
  readonly payloadHash: string;
  readonly failureCode: FailureCode | null;
  readonly responseBalance: string | null;
  readonly createdAt: string;
}

export interface WalletForUpdate {
  readonly wallet: Wallet;
  readonly playerId: string;
}

export interface WagerReference {
  readonly id: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus;
  readonly amount: string;
  readonly currency: string;
  readonly roundId: string;
}

export interface WagerTransactionSession {
  recordInbox(
    consumerName: string,
    messageId: string,
    body: string,
  ): Promise<boolean>;
  insertOrFind(data: SubmitWagerData): Promise<
    | { readonly inserted: true }
    | { readonly inserted: false; readonly existing: WagerSnapshot }
  >;
  lockWallet(walletId: string): Promise<WalletForUpdate | null>;
  findReference(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerReference | null>;
  hasReversal(referenceId: string, kind: WagerTransactionKind): Promise<boolean>;
  deferReference(id: string): Promise<{ attempts: number; exhausted: boolean }>;
  saveWallet(wallet: Wallet, expectedVersion: number): Promise<void>;
  updateTransaction(
    id: string,
    status: WagerTransactionStatus,
    failureCode: FailureCode | null,
    responseBalance: string | null,
    referenceId?: string,
  ): Promise<void>;
  getTransaction(id: string): Promise<WagerSnapshot>;
  appendLedger(entry: {
    id: string;
    walletId: string;
    transactionId: string;
    direction: TransactionDirection;
    amount: Money;
    balanceBefore: Money;
    balanceAfter: Money;
  }): Promise<void>;
  appendOutbox(id: string, eventType: string, body: string): Promise<void>;
}

export interface WageringStore {
  transaction<T>(work: (session: WagerTransactionSession) => Promise<T>): Promise<T>;
  listPendingReferences(limit: number): Promise<WagerSnapshot[]>;
}
