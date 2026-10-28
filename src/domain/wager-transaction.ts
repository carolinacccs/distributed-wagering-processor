import {
  DomainError,
  IdempotencyKeyPayloadMismatchError,
  InsufficientBalanceError,
  InvalidReversalReferenceError,
  InvalidTransactionStateError,
  ReferencedTransactionNotFoundError,
} from "./errors";
import { FailureCode } from "./failure-code";
import { Money } from "./money";
import { Wallet } from "./wallet";

export enum WagerTransactionKind {
  BET = "BET",
  WIN = "WIN",
  REFUND = "REFUND",
  ROLLBACK = "ROLLBACK",
  REVERSAL = "REVERSAL",
}

export enum WagerTransactionStatus {
  PENDING = "PENDING",
  PROCESSED = "PROCESSED",
  REJECTED = "REJECTED",
  FAILED = "FAILED",
  PENDING_REFERENCE = "PENDING_REFERENCE",
}

export enum TransactionDirection {
  DEBIT = "DEBIT",
  CREDIT = "CREDIT",
}

export interface WagerTransactionPayload {
  readonly id: string;
  readonly walletId: string;
  readonly kind: WagerTransactionKind;
  readonly amount: Money;
  readonly idempotencyKey: string;
  readonly referenceId?: string;
}

export interface RehydratedWagerTransaction extends WagerTransactionPayload {
  readonly status: WagerTransactionStatus;
  readonly failureCode?: FailureCode;
}

export class WagerTransaction {
  private currentStatus: WagerTransactionStatus;
  private currentFailureCode?: FailureCode;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly kind: WagerTransactionKind,
    public readonly amount: Money,
    public readonly idempotencyKey: string,
    public readonly referenceId: string | undefined,
    status: WagerTransactionStatus,
    failureCode?: FailureCode,
  ) {
    this.currentStatus = status;
    this.currentFailureCode = failureCode;
  }

  static create(payload: WagerTransactionPayload): WagerTransaction {
    WagerTransaction.assertPayload(payload);
    if (payload.amount.isZero()) {
      throw new DomainError("Transaction amount must be greater than zero.", FailureCode.INVALID_AMOUNT);
    }
    return new WagerTransaction(
      payload.id,
      payload.walletId,
      payload.kind,
      payload.amount,
      payload.idempotencyKey,
      payload.referenceId,
      WagerTransactionStatus.PENDING,
    );
  }

  static rehydrate(data: RehydratedWagerTransaction): WagerTransaction {
    WagerTransaction.assertPayload(data);
    if (data.amount.isZero()) {
      throw new DomainError("Transaction amount must be greater than zero.", FailureCode.INVALID_AMOUNT);
    }
    if (
      !Object.values(WagerTransactionStatus).includes(data.status) ||
      (data.status === WagerTransactionStatus.PENDING && data.failureCode !== undefined) ||
      (data.status === WagerTransactionStatus.PROCESSED && data.failureCode !== undefined) ||
      ((data.status === WagerTransactionStatus.REJECTED ||
        data.status === WagerTransactionStatus.FAILED) &&
        (!data.failureCode || !Object.values(FailureCode).includes(data.failureCode)))
    ) {
      throw new TypeError("Invalid transaction state.");
    }
    return new WagerTransaction(
      data.id,
      data.walletId,
      data.kind,
      data.amount,
      data.idempotencyKey,
      data.referenceId,
      data.status,
      data.failureCode,
    );
  }

  get status(): WagerTransactionStatus {
    return this.currentStatus;
  }

  get failureCode(): FailureCode | undefined {
    return this.currentFailureCode;
  }

  directionFor(reference?: WagerTransaction): TransactionDirection {
    switch (this.kind) {
      case WagerTransactionKind.BET:
        return TransactionDirection.DEBIT;
      case WagerTransactionKind.WIN:
        return TransactionDirection.CREDIT;
      case WagerTransactionKind.REFUND:
        if (!reference || reference.id !== this.referenceId) {
          throw new ReferencedTransactionNotFoundError(this.referenceId ?? "");
        }
        if (reference.kind !== WagerTransactionKind.BET) {
          throw new InvalidReversalReferenceError();
        }
        return TransactionDirection.CREDIT;
      case WagerTransactionKind.ROLLBACK:
        if (!reference || reference.id !== this.referenceId) {
          throw new ReferencedTransactionNotFoundError(this.referenceId ?? "");
        }
        if (reference.kind !== WagerTransactionKind.REFUND) {
          throw new InvalidReversalReferenceError();
        }
        return TransactionDirection.DEBIT;
      case WagerTransactionKind.REVERSAL:
        if (!reference || reference.id !== this.referenceId) {
          throw new ReferencedTransactionNotFoundError(this.referenceId ?? "");
        }
        if (
          reference.kind !== WagerTransactionKind.BET &&
          reference.kind !== WagerTransactionKind.WIN &&
          reference.kind !== WagerTransactionKind.REFUND
        ) {
          throw new InvalidReversalReferenceError();
        }
        return reference.kind === WagerTransactionKind.BET
          ? TransactionDirection.CREDIT
          : TransactionDirection.DEBIT;
    }
  }

  applyTo(wallet: Wallet, reference?: WagerTransaction): void {
    this.assertPending();
    if (wallet.id !== this.walletId) {
      throw new TypeError("Transaction wallet does not match.");
    }
    const direction = this.directionFor(reference);
    if (direction === TransactionDirection.CREDIT) {
      wallet.credit(this.amount);
      return;
    }

    try {
      wallet.debit(
        this.amount,
        this.kind === WagerTransactionKind.ROLLBACK
          ? FailureCode.INSUFFICIENT_BALANCE_FOR_ROLLBACK
          : this.kind === WagerTransactionKind.REVERSAL
            ? FailureCode.REVERSAL_WOULD_NEGATIVE_BALANCE
            : FailureCode.INSUFFICIENT_BALANCE_FOR_BET,
      );
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        this.reject(error.code);
        return;
      }
      throw error;
    }
  }

  markProcessed(): void {
    this.transition(WagerTransactionStatus.PROCESSED);
  }

  reject(code: FailureCode): void {
    this.transition(WagerTransactionStatus.REJECTED, code);
  }

  fail(code: FailureCode): void {
    this.transition(WagerTransactionStatus.FAILED, code);
  }

  assertPayloadMatches(payload: WagerTransactionPayload): void {
    if (payload.idempotencyKey !== this.idempotencyKey) {
      throw new TypeError("Idempotency keys do not match.");
    }
    if (
      payload.walletId !== this.walletId ||
      payload.kind !== this.kind ||
      !payload.amount.equals(this.amount) ||
      payload.referenceId !== this.referenceId
    ) {
      throw new IdempotencyKeyPayloadMismatchError();
    }
  }

  private transition(status: WagerTransactionStatus, code?: FailureCode): void {
    this.assertPending();
    if (
      !Object.values(WagerTransactionStatus).includes(status) ||
      (status === WagerTransactionStatus.REJECTED && !code) ||
      (status === WagerTransactionStatus.FAILED && !code) ||
      ((status === WagerTransactionStatus.PROCESSED ||
        status === WagerTransactionStatus.PENDING) &&
        code !== undefined) ||
      (code !== undefined && !Object.values(FailureCode).includes(code))
    ) {
      throw new TypeError("Invalid transaction transition.");
    }
    this.currentStatus = status;
    this.currentFailureCode = code;
  }

  private assertPending(): void {
    if (this.currentStatus !== WagerTransactionStatus.PENDING) {
      throw new InvalidTransactionStateError(this.currentStatus);
    }
  }

  private static assertPayload(payload: WagerTransactionPayload): void {
    if (
      !payload.id?.trim() ||
      !payload.walletId?.trim() ||
      !payload.idempotencyKey?.trim() ||
      !Object.values(WagerTransactionKind).includes(payload.kind)
    ) {
      throw new TypeError("Invalid wager transaction payload.");
    }
    if (
      (payload.kind === WagerTransactionKind.REVERSAL ||
        payload.kind === WagerTransactionKind.ROLLBACK ||
        payload.kind === WagerTransactionKind.REFUND) &&
      !payload.referenceId?.trim()
    ) {
      throw new InvalidReversalReferenceError();
    }
  }
}
