import { createHash, randomUUID } from "node:crypto";
import { FailureCode } from "../domain/failure-code";
import { Money } from "../domain/money";
import {
  TransactionDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import {
  BetPlacedEvent,
  WagerRefundedEvent,
  WagerReversedEvent,
  WagerTransactionRejectedEvent,
  WagerWonEvent,
} from "../domain/integration-events";
import {
  SubmitWagerData,
  WagerReference,
  WagerSnapshot,
  WagerTransactionSession,
  WageringStore,
} from "./ports/wagering-store";
import { logger } from "../infrastructure/observability/logger";
import {
  idempotentDuplicateCounter,
  lockConflictCounter,
  operationLatency,
  retryCounter,
  transactionCounter,
} from "../infrastructure/observability/metrics";

export interface SubmitWagerRequest {
  readonly providerId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly kind: WagerTransactionKind;
  readonly amount: string;
  readonly currency: string;
  readonly roundId: string;
  readonly referenceExternalTransactionId?: string;
  readonly messageId?: string;
  readonly consumerName?: string;
  readonly rawMessageBody?: string;
  readonly correlationId?: string;
}

export interface SubmitWagerResult extends Omit<WagerSnapshot, "payloadHash"> {
  readonly idempotentReplay: boolean;
}

export class SubmitWagerError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: 400 | 409 | 422 | 503,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

const VALID_KINDS = new Set<WagerTransactionKind>([
  WagerTransactionKind.BET,
  WagerTransactionKind.WIN,
  WagerTransactionKind.REFUND,
  WagerTransactionKind.ROLLBACK,
]);

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeRequest(request: SubmitWagerRequest): Omit<SubmitWagerData, "id" | "payloadHash"> {
  if (
    !request ||
    !request.providerId?.trim() ||
    !request.playerId?.trim() ||
    !request.walletId?.trim() ||
    !request.externalTransactionId?.trim() ||
    !request.idempotencyKey?.trim() ||
    !request.roundId?.trim() ||
    !VALID_KINDS.has(request.kind)
  ) {
    throw new SubmitWagerError("Invalid transaction payload.", 400, "INVALID_PAYLOAD");
  }
  if (
    (request.kind === WagerTransactionKind.REFUND ||
      request.kind === WagerTransactionKind.ROLLBACK) &&
    !request.referenceExternalTransactionId?.trim()
  ) {
    throw new SubmitWagerError("A reference transaction is required.", 400, "INVALID_PAYLOAD");
  }
  if (
    request.kind !== WagerTransactionKind.REFUND &&
    request.kind !== WagerTransactionKind.ROLLBACK &&
    request.referenceExternalTransactionId !== undefined
  ) {
    throw new SubmitWagerError("This transaction kind cannot reference another transaction.", 400, "INVALID_PAYLOAD");
  }
  let amount: Money;
  try {
    if (!/^[A-Z]{3}$/.test(request.currency)) {
      throw new TypeError("Currency must be a three-letter uppercase code.");
    }
    amount = Money.from(request.amount, request.currency);
    if (amount.isZero() || amount.amount.indexOf(".") > 17) {
      throw new TypeError("Amount must fit NUMERIC(19,2) and be positive.");
    }
  } catch {
    throw new SubmitWagerError("Invalid amount or currency.", 400, "INVALID_PAYLOAD");
  }

  return {
    providerId: request.providerId,
    playerId: request.playerId,
    walletId: request.walletId,
    externalTransactionId: request.externalTransactionId,
    idempotencyKey: request.idempotencyKey,
    kind: request.kind,
    amount,
    roundId: request.roundId,
    referenceExternalTransactionId: request.referenceExternalTransactionId,
  };
}

function snapshotWithReplay(
  snapshot: WagerSnapshot,
  idempotentReplay: boolean,
): SubmitWagerResult {
  const { payloadHash: _payloadHash, ...result } = snapshot;
  return { ...result, idempotentReplay };
}

function snapshotResult(
  snapshot: WagerSnapshot,
  idempotentReplay = false,
): SubmitWagerResult {
  const { payloadHash: _payloadHash, ...result } = snapshot;
  return { ...result, idempotentReplay };
}

function validateReference(
  data: SubmitWagerData,
  reference: WagerReference,
): FailureCode | null {
  const expectedKind =
    data.kind === WagerTransactionKind.REFUND
      ? WagerTransactionKind.BET
      : WagerTransactionKind.REFUND;
  if (reference.kind !== expectedKind) {
    return FailureCode.INVALID_REFERENCE_TYPE;
  }
  if (reference.providerId !== data.providerId) {
    return FailureCode.REFERENCE_PROVIDER_MISMATCH;
  }
  if (reference.playerId !== data.playerId) {
    return FailureCode.REFERENCE_PLAYER_MISMATCH;
  }
  if (reference.walletId !== data.walletId) {
    return FailureCode.REFERENCE_WALLET_MISMATCH;
  }
  if (reference.currency !== data.amount.currency) {
    return FailureCode.WALLET_CURRENCY_MISMATCH;
  }
  if (reference.roundId !== data.roundId) {
    return FailureCode.ROUND_MISMATCH;
  }
  if (reference.amount !== data.amount.amount) {
    return FailureCode.REFERENCE_PAYLOAD_MISMATCH;
  }
  return null;
}

export class SubmitWagerTransaction {
  constructor(private readonly store: WageringStore) {}

  async execute(request: SubmitWagerRequest): Promise<SubmitWagerResult> {
    return this.submit(request, false);
  }

  async reconcilePendingReferences(limit = 100): Promise<SubmitWagerResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new SubmitWagerError("Reconciliation limit must be between 1 and 1000.", 400, "INVALID_LIMIT");
    }
    let pending: WagerSnapshot[];
    try {
      pending = await this.store.listPendingReferences(limit);
    } catch (error) {
      if (isTransientDatabaseError(error)) {
        throw new SubmitWagerError("Temporary persistence failure.", 503, "TRANSIENT_FAILURE");
      }
      throw error;
    }
    const results: SubmitWagerResult[] = [];
    for (const transaction of pending) {
      results.push(
        await this.submit(
          {
            providerId: transaction.providerId,
            playerId: transaction.playerId,
            walletId: transaction.walletId,
            externalTransactionId: transaction.externalTransactionId,
            idempotencyKey: transaction.idempotencyKey,
            kind: transaction.kind,
            amount: transaction.amount,
            currency: transaction.currency,
            roundId: transaction.roundId,
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId ?? undefined,
          },
          true,
        ),
      );
    }
    return results;
  }

  private async submit(
    request: SubmitWagerRequest,
    resumePendingReference: boolean,
  ): Promise<SubmitWagerResult> {
    const normalized = normalizeRequest(request);
    const stopTimer = operationLatency.startTimer({ operation: "submit_wager" });
    const businessPayload = {
      amount: normalized.amount.amount,
      currency: normalized.amount.currency,
      externalTransactionId: normalized.externalTransactionId,
      kind: normalized.kind,
      playerId: normalized.playerId,
      providerId: normalized.providerId,
      referenceExternalTransactionId:
        normalized.referenceExternalTransactionId ?? null,
      roundId: normalized.roundId,
      walletId: normalized.walletId,
    };
    const payloadHash = createHash("sha256")
      .update(canonicalize(businessPayload))
      .digest("hex");
    const data: SubmitWagerData = {
      ...normalized,
      id: randomUUID(),
      payloadHash,
      ...(request.messageId && request.consumerName && request.rawMessageBody
        ? {
            inbox: {
              consumerName: request.consumerName,
              messageId: request.messageId,
              body: request.rawMessageBody,
            },
          }
        : {}),
    };

    try {
      const result = await this.store.transaction(async (session) => {
        let isDuplicateInbox = false;
        if (data.inbox) {
          isDuplicateInbox = !(await session.recordInbox(
            data.inbox.consumerName,
            data.inbox.messageId,
            data.inbox.body,
          ));
        }
        const inserted = await session.insertOrFind(data);
        let currentData = data;
        if (!inserted.inserted) {
          if (inserted.existing.payloadHash !== data.payloadHash) {
            throw new SubmitWagerError(
              "Idempotency key conflicts with a different business payload.",
              409,
              FailureCode.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH,
            );
          }
          if (
            !resumePendingReference ||
            inserted.existing.status !== WagerTransactionStatus.PENDING_REFERENCE
          ) {
            idempotentDuplicateCounter.inc();
            return snapshotWithReplay(inserted.existing, true);
          }
          currentData = { ...data, id: inserted.existing.id };
        } else if (isDuplicateInbox) {
          throw new Error("Inbox deduplication record exists without its wager transaction.");
        }

        const transactionId = currentData.id;
        const walletState = await session.lockWallet(currentData.walletId);
        if (!walletState) {
          return this.reject(session, currentData, FailureCode.WALLET_NOT_FOUND);
        }
        const { wallet, playerId } = walletState;
        const initialVersion = wallet.version;
        if (playerId !== currentData.playerId) {
          return this.reject(session, currentData, FailureCode.WALLET_PLAYER_MISMATCH, wallet.balance.amount);
        }
        if (wallet.balance.currency !== currentData.amount.currency) {
          return this.reject(session, currentData, FailureCode.WALLET_CURRENCY_MISMATCH, wallet.balance.amount);
        }

        let reference: WagerReference | null = null;
        if (currentData.kind === WagerTransactionKind.REFUND || currentData.kind === WagerTransactionKind.ROLLBACK) {
          reference = await session.findReference(
            currentData.providerId,
            currentData.referenceExternalTransactionId!,
          );
          if (!reference) {
            return this.pendingReference(session, currentData, wallet.balance.amount);
          }
          const invalidReference = validateReference(currentData, reference);
          if (invalidReference) {
            return this.reject(
              session,
              currentData,
              invalidReference,
              wallet.balance.amount,
              reference.id,
            );
          }
          if (reference.status !== WagerTransactionStatus.PROCESSED) {
            return this.pendingReference(session, currentData, wallet.balance.amount, reference.id);
          }
          if (await session.hasReversal(reference.id)) {
            return this.reject(
              session,
              currentData,
              FailureCode.DUPLICATE_REVERSAL,
              wallet.balance.amount,
              reference.id,
            );
          }
        }

        const before = wallet.balance;
        const direction =
          currentData.kind === WagerTransactionKind.BET ||
          currentData.kind === WagerTransactionKind.ROLLBACK
            ? TransactionDirection.DEBIT
            : TransactionDirection.CREDIT;

        if (direction === TransactionDirection.CREDIT) {
          const maximumBalance = Money.from("99999999999999999.99", before.currency);
          if (before.add(currentData.amount).isGreaterThan(maximumBalance)) {
            return this.reject(
              session,
              currentData,
              FailureCode.WALLET_BALANCE_LIMIT_EXCEEDED,
              before.amount,
            );
          }
        }

        if (direction === TransactionDirection.DEBIT) {
          if (!before.isGreaterThan(currentData.amount) && !before.equals(currentData.amount)) {
            const failureCode =
              currentData.kind === WagerTransactionKind.ROLLBACK
                ? FailureCode.ROLLBACK_WOULD_NEGATIVE_BALANCE
                : FailureCode.INSUFFICIENT_BALANCE_FOR_BET;
            return this.reject(session, currentData, failureCode, before.amount, reference?.id);
          }
          wallet.debit(currentData.amount);
        } else {
          wallet.credit(currentData.amount);
        }

        const ledger = WalletLedgerEntry.create(
          randomUUID(),
          wallet.id,
          transactionId,
          direction,
          currentData.amount,
          before,
          wallet.balance,
        );
        await session.saveWallet(wallet, initialVersion);
        await session.appendLedger(ledger);
        await session.updateTransaction(
          transactionId,
          WagerTransactionStatus.PROCESSED,
          null,
          wallet.balance.amount,
          reference?.id,
        );

        const eventId = randomUUID();
        const occurredAt = new Date().toISOString();
        const event = (() => {
          switch (currentData.kind) {
            case WagerTransactionKind.BET:
              return BetPlacedEvent.create(
                eventId,
                transactionId,
                wallet.id,
                currentData.amount,
                occurredAt,
              );
            case WagerTransactionKind.WIN:
              return WagerWonEvent.create(
                eventId,
                transactionId,
                wallet.id,
                currentData.amount,
                occurredAt,
              );
            case WagerTransactionKind.REFUND:
              return WagerRefundedEvent.create(
                eventId,
                transactionId,
                wallet.id,
                currentData.amount,
                occurredAt,
              );
            case WagerTransactionKind.ROLLBACK:
            case WagerTransactionKind.REVERSAL:
              return WagerReversedEvent.create(
                eventId,
                transactionId,
                wallet.id,
                currentData.amount,
                occurredAt,
              );
          }
        })();
        await session.appendOutbox(
          randomUUID(),
          event.type,
          JSON.stringify({
            type: event.type,
            eventId: event.eventId,
            occurredAt: event.occurredAt,
            transactionId,
            walletId: wallet.id,
            providerId: currentData.providerId,
            externalTransactionId: currentData.externalTransactionId,
            referenceExternalTransactionId: currentData.referenceExternalTransactionId ?? null,
            amount: currentData.amount.amount,
            currency: currentData.amount.currency,
          }),
        );

        return snapshotResult(await session.getTransaction(transactionId));
      });
      transactionCounter.inc({ status: result.status });
      logger.info(
        {
          event: "wager_transaction_completed",
          correlationId: request.correlationId ?? null,
          messageId: request.messageId ?? null,
          transactionId: result.id,
          walletId: request.walletId,
          providerId: request.providerId,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
        },
        "Wager transaction completed",
      );
      return result;
    } catch (error) {
      if (error instanceof SubmitWagerError) {
        throw error;
      }
      if (isDatabaseErrorCode(error, "23503")) {
        throw new SubmitWagerError(
          "Wallet not found.",
          422,
          FailureCode.WALLET_NOT_FOUND,
        );
      }
      if (isTransientDatabaseError(error)) {
        retryCounter.inc({ component: "submit" });
        if (isDatabaseErrorCode(error, "40P01") || isDatabaseErrorCode(error, "55P03")) {
          lockConflictCounter.inc();
        }
        throw new SubmitWagerError("Temporary persistence failure.", 503, "TRANSIENT_FAILURE");
      }
      throw error;
    } finally {
      stopTimer();
    }
  }

  private async reject(
    session: WagerTransactionSession,
    data: SubmitWagerData,
    code: FailureCode,
    balance: string | null = null,
    referenceId?: string,
  ): Promise<SubmitWagerResult> {
    await session.updateTransaction(
      data.id,
      WagerTransactionStatus.REJECTED,
      code,
      balance,
      referenceId,
    );
    return snapshotResult(await session.getTransaction(data.id));
  }

  private async pendingReference(
    session: WagerTransactionSession,
    data: SubmitWagerData,
    balance: string | null,
    referenceId?: string,
  ): Promise<SubmitWagerResult> {
    const retry = await session.deferReference(data.id);
    if (retry.exhausted) {
      const event = WagerTransactionRejectedEvent.create(
        randomUUID(),
        data.id,
        data.walletId,
        data.amount,
        FailureCode.REFERENCED_TRANSACTION_NOT_FOUND,
      );
      await session.updateTransaction(
        data.id,
        WagerTransactionStatus.REJECTED,
        FailureCode.REFERENCED_TRANSACTION_NOT_FOUND,
        balance,
      );
      await session.appendOutbox(
        randomUUID(),
        event.type,
        JSON.stringify({
          type: event.type,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          transactionId: event.transactionId,
          walletId: event.walletId,
          failureCode: event.failureCode,
        }),
      );
      return snapshotResult(await session.getTransaction(data.id));
    }

    retryCounter.inc({ component: "pending_reference" });
    await session.updateTransaction(
      data.id,
      WagerTransactionStatus.PENDING_REFERENCE,
      null,
      balance,
      referenceId,
    );
    return snapshotResult(await session.getTransaction(data.id));
  }
}

function isTransientDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const code = String(error.code);
  return (
    code.startsWith("08") ||
    code.startsWith("40") ||
    code === "53300" ||
    code === "57P01" ||
    code === "55P03" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE"
  );
}

function isDatabaseErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    String(error.code) === expectedCode
  );
}
