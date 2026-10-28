import { describe, expect, test } from "bun:test";
import {
  WagerReference,
  WagerSnapshot,
  WagerTransactionSession,
  WageringStore,
} from "../ports/wagering-store";
import {
  SubmitWagerError,
  SubmitWagerRequest,
  SubmitWagerTransaction,
} from "../submit-wager-transaction";
import { FailureCode } from "../../domain/failure-code";
import { Money } from "../../domain/money";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";

class FakeStore implements WageringStore {
  readonly transactions = new Map<string, WagerSnapshot>();
  readonly ledger: unknown[] = [];
  readonly outbox: string[] = [];
  readonly references = new Map<string, WagerReference>();
  wallet: Wallet | null = Wallet.open("wallet-1", "USD");
  playerId = "player-1";

  async transaction<T>(work: (session: WagerTransactionSession) => Promise<T>): Promise<T> {
    const session: WagerTransactionSession = {
      recordInbox: async () => true,
      insertOrFind: async (data) => {
        const existing = [...this.transactions.values()].find(
          (transaction) =>
            (transaction.providerId === data.providerId &&
              transaction.externalTransactionId === data.externalTransactionId) ||
            transaction.idempotencyKey === data.idempotencyKey,
        );
        if (existing) {
          return { inserted: false, existing };
        }
        this.transactions.set(data.id, {
          id: data.id,
          providerId: data.providerId,
          playerId: data.playerId,
          walletId: data.walletId,
          externalTransactionId: data.externalTransactionId,
          idempotencyKey: data.idempotencyKey,
          kind: data.kind,
          status: WagerTransactionStatus.PENDING,
          amount: data.amount.amount,
          currency: data.amount.currency,
          roundId: data.roundId,
          referenceExternalTransactionId: data.referenceExternalTransactionId ?? null,
          payloadHash: data.payloadHash,
          failureCode: null,
          responseBalance: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        return { inserted: true };
      },
      lockWallet: async () =>
        this.wallet ? { wallet: this.wallet, playerId: this.playerId } : null,
      findReference: async (providerId, externalId) =>
        [...this.references.values()].find(
          (reference) =>
            reference.providerId === providerId &&
            this.transactions.get(reference.id)?.externalTransactionId === externalId,
        ) ?? null,
      hasReversal: async () => false,
      deferReference: async () => ({ attempts: 1, exhausted: false }),
      saveWallet: async () => undefined,
      updateTransaction: async (id, status, failureCode, responseBalance) => {
        const record = this.transactions.get(id);
        if (!record) {
          throw new Error("Missing test transaction");
        }
        this.transactions.set(id, {
          ...record,
          status,
          failureCode,
          responseBalance,
        });
      },
      getTransaction: async (id) => {
        const record = this.transactions.get(id);
        if (!record) {
          throw new Error("Missing test transaction");
        }
        return record;
      },
      appendLedger: async (entry) => {
        this.ledger.push(entry);
      },
      appendOutbox: async (_id, eventType) => {
        this.outbox.push(eventType);
      },
    };
    return work(session);
  }

  async listPendingReferences(): Promise<WagerSnapshot[]> {
    return [...this.transactions.values()].filter(
      (record) => record.status === WagerTransactionStatus.PENDING_REFERENCE,
    );
  }
}

function request(overrides: Partial<SubmitWagerRequest> = {}): SubmitWagerRequest {
  return {
    providerId: "provider-1",
    playerId: "player-1",
    walletId: "wallet-1",
    externalTransactionId: "external-1",
    idempotencyKey: "header-key-1",
    kind: WagerTransactionKind.BET,
    amount: "2.00",
    currency: "USD",
    roundId: "round-1",
    ...overrides,
  };
}

describe("SubmitWagerTransaction", () => {
  test("replays the persisted result and rejects a different payload", async () => {
    const store = new FakeStore();
    store.wallet?.credit(Money.from("10.00", "USD"));
    const useCase = new SubmitWagerTransaction(store);
    const first = await useCase.execute(request());
    const replay = await useCase.execute(request({ idempotencyKey: "another-header" }));

    expect(first.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(replay.id).toBe(first.id);
    expect(replay.idempotentReplay).toBe(true);

    await expect(
      useCase.execute(request({ amount: "3.00", idempotencyKey: "header-key-1" })),
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: FailureCode.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH,
    } satisfies Partial<SubmitWagerError>);
  });

  test("commits insufficient BET as rejected without ledger or outbox", async () => {
    const store = new FakeStore();
    const result = await new SubmitWagerTransaction(store).execute(request());
    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE_FOR_BET);
    expect(store.ledger).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  test("stores a missing reference as pending and reconciles it when available", async () => {
    const store = new FakeStore();
    store.wallet?.credit(Money.from("2.00", "USD"));
    const useCase = new SubmitWagerTransaction(store);
    const refund = request({
      kind: WagerTransactionKind.REFUND,
      externalTransactionId: "refund-1",
      idempotencyKey: "refund-key",
      referenceExternalTransactionId: "bet-1",
    });
    const pending = await useCase.execute(refund);
    expect(pending.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);

    const betId = "bet-reference-id";
    store.transactions.set(betId, {
      id: betId,
      providerId: refund.providerId,
      playerId: refund.playerId,
      walletId: refund.walletId,
      externalTransactionId: "bet-1",
      idempotencyKey: "bet-key",
      kind: WagerTransactionKind.BET,
      status: WagerTransactionStatus.PROCESSED,
      amount: "2.00",
      currency: "USD",
      roundId: "round-1",
      referenceExternalTransactionId: null,
      payloadHash: "reference-hash",
      failureCode: null,
      responseBalance: "2.00",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.references.set(betId, {
      id: betId,
      providerId: refund.providerId,
      playerId: refund.playerId,
      walletId: refund.walletId,
      kind: WagerTransactionKind.BET,
      status: WagerTransactionStatus.PROCESSED,
      amount: "2.00",
      currency: "USD",
      roundId: "round-1",
    });

    const reconciled = await useCase.reconcilePendingReferences();
    expect(reconciled[0]?.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(store.outbox).toHaveLength(1);
    expect(store.ledger).toHaveLength(1);
  });
});
