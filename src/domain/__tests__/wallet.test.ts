import { describe, expect, test } from "bun:test";
import { IdempotencyKeyPayloadMismatchError, ReferencedTransactionNotFoundError } from "../errors";
import { FailureCode } from "../failure-code";
import { Money } from "../money";
import { Wallet } from "../wallet";
import {
  TransactionDirection,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../wager-transaction";

describe("Wallet", () => {
  test("increments its version only when its balance changes", () => {
    const wallet = Wallet.open("wallet-1", "USD");
    wallet.credit(Money.zero("USD"));
    expect(wallet.version).toBe(0);
    wallet.credit(Money.from("1.00", "USD"));
    expect(wallet.version).toBe(1);
    wallet.debit(Money.from("1.00", "USD"));
    expect(wallet.balance.amount).toBe("0.00");
    expect(wallet.version).toBe(2);
  });

  test("does not allow a negative balance", () => {
    const wallet = Wallet.open("wallet-1", "USD");
    expect(() => wallet.debit(Money.from("1.00", "USD"))).toThrow();
    expect(wallet.balance.amount).toBe("0.00");
    expect(wallet.version).toBe(0);
  });
});

describe("wager transaction kind rules", () => {
  const create = (kind: WagerTransactionKind, id = "transaction-1", referenceId?: string) =>
    WagerTransaction.create({
      id,
      walletId: "wallet-1",
      kind,
      amount: Money.from("2.00", "USD"),
      idempotencyKey: `key-${id}`,
      referenceId,
    });

  test("BET debits and insufficient balance gets the BET failure code", () => {
    const wallet = Wallet.open("wallet-1", "USD");
    const bet = create(WagerTransactionKind.BET);
    expect(bet.directionFor()).toBe(TransactionDirection.DEBIT);
    bet.applyTo(wallet);
    expect(bet.status).toBe(WagerTransactionStatus.REJECTED);
    expect(bet.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE_FOR_BET);
  });

  test("a funded BET debits the wallet", () => {
    const wallet = Wallet.open("wallet-1", "USD");
    wallet.credit(Money.from("5.00", "USD"));
    create(WagerTransactionKind.BET, "bet-funded").applyTo(wallet);
    expect(wallet.balance.amount).toBe("3.00");
  });

  test("WIN credits the wallet", () => {
    const wallet = Wallet.open("wallet-1", "USD");
    const transaction = create(WagerTransactionKind.WIN, "transaction-win");
    expect(transaction.directionFor()).toBe(TransactionDirection.CREDIT);
    transaction.applyTo(wallet);
    expect(wallet.balance.amount).toBe("2.00");
  });

  test("REFUND credits only its referenced BET", () => {
    const wallet = Wallet.open("wallet-1", "USD");
    const bet = create(WagerTransactionKind.BET, "bet-to-refund");
    bet.markProcessed();
    const refund = create(WagerTransactionKind.REFUND, "refund-1", bet.id);
    expect(refund.directionFor(bet)).toBe(TransactionDirection.CREDIT);
    refund.applyTo(wallet, bet);
    expect(wallet.balance.amount).toBe("2.00");
  });

  test("ROLLBACK debits only its referenced REFUND", () => {
    const wallet = Wallet.open("wallet-1", "USD");
    wallet.credit(Money.from("4.00", "USD"));
    const bet = create(WagerTransactionKind.BET, "bet-for-rollback");
    bet.markProcessed();
    const refund = create(WagerTransactionKind.REFUND, "refund-for-rollback", bet.id);
    refund.markProcessed();
    const rollback = create(WagerTransactionKind.ROLLBACK, "rollback-1", refund.id);
    expect(rollback.directionFor(refund)).toBe(TransactionDirection.DEBIT);
    rollback.applyTo(wallet, refund);
    expect(wallet.balance.amount).toBe("2.00");
  });

  test("REVERSAL applies the opposite of the referenced transaction", () => {
    const wallet = Wallet.open("wallet-1", "USD");
    wallet.credit(Money.from("5.00", "USD"));
    const win = create(WagerTransactionKind.WIN, "win-1");
    const reversal = create(WagerTransactionKind.REVERSAL, "reversal-1", win.id);
    expect(reversal.directionFor(win)).toBe(TransactionDirection.DEBIT);
    reversal.applyTo(wallet, win);
    expect(wallet.balance.amount).toBe("3.00");
  });

  test("reversing a BET credits the wallet", () => {
    const wallet = Wallet.open("wallet-1", "USD");
    const bet = create(WagerTransactionKind.BET, "bet-to-reverse");
    const reversal = create(WagerTransactionKind.REVERSAL, "reversal-of-bet", bet.id);
    expect(reversal.directionFor(bet)).toBe(TransactionDirection.CREDIT);
    reversal.applyTo(wallet, bet);
    expect(wallet.balance.amount).toBe("2.00");
  });

  test("rejects a reversal that would make the balance negative with a distinct code", () => {
    const wallet = Wallet.open("wallet-1", "USD");
    const win = create(WagerTransactionKind.WIN, "win-2");
    const reversal = create(WagerTransactionKind.REVERSAL, "reversal-2", win.id);
    reversal.applyTo(wallet, win);
    expect(reversal.failureCode).toBe(FailureCode.REVERSAL_WOULD_NEGATIVE_BALANCE);
  });

  test("requires an existing reference and rejects payload changes for a reused key", () => {
    const reversal = create(WagerTransactionKind.REVERSAL, "reversal-3", "missing");
    expect(() => reversal.directionFor()).toThrow(ReferencedTransactionNotFoundError);

    const bet = create(WagerTransactionKind.BET, "bet-1");
    expect(() =>
      bet.assertPayloadMatches({
        id: "retry-id",
        walletId: "wallet-1",
        kind: WagerTransactionKind.BET,
        amount: Money.from("2.00", "USD"),
        idempotencyKey: "key-bet-1",
      }),
    ).not.toThrow();
    expect(() =>
      bet.assertPayloadMatches({
        id: "bet-1",
        walletId: "wallet-1",
        kind: WagerTransactionKind.BET,
        amount: Money.from("3.00", "USD"),
        idempotencyKey: "key-bet-1",
      }),
    ).toThrow(IdempotencyKeyPayloadMismatchError);
  });

  test("terminal states cannot transition again", () => {
    const transaction = create(WagerTransactionKind.BET, "bet-2");
    transaction.markProcessed();
    expect(() => transaction.fail(FailureCode.INVALID_AMOUNT)).toThrow();
    expect(() => transaction.markProcessed()).toThrow();
  });
});
