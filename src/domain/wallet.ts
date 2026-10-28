import { FailureCode } from "./failure-code";
import { CurrencyMismatchError, InsufficientBalanceError } from "./errors";
import { Money } from "./money";

export class Wallet {
  private constructor(
    public readonly id: string,
    private currentBalance: Money,
    private currentVersion: number,
  ) {}

  static open(id: string, currency: string): Wallet {
    Wallet.assertId(id);
    return new Wallet(id, Money.zero(currency), 0);
  }

  static rehydrate(id: string, balance: Money, version: number): Wallet {
    Wallet.assertId(id);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new RangeError("Wallet version must be a non-negative safe integer.");
    }
    return new Wallet(id, balance, version);
  }

  get balance(): Money {
    return this.currentBalance;
  }

  get version(): number {
    return this.currentVersion;
  }

  debit(amount: Money, failureCode = FailureCode.INSUFFICIENT_BALANCE): void {
    this.assertCurrency(amount);
    if (
      !this.currentBalance.equals(amount) &&
      !this.currentBalance.isGreaterThan(amount)
    ) {
      throw new InsufficientBalanceError(failureCode);
    }

    this.changeBalance(this.currentBalance.subtract(amount));
  }

  credit(amount: Money): void {
    this.assertCurrency(amount);
    this.changeBalance(this.currentBalance.add(amount));
  }

  private changeBalance(balance: Money): void {
    if (!this.currentBalance.equals(balance)) {
      this.currentBalance = balance;
      this.currentVersion += 1;
    }
  }

  private assertCurrency(amount: Money): void {
    if (this.balance.currency !== amount.currency) {
      throw new CurrencyMismatchError();
    }
  }

  private static assertId(id: string): void {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new TypeError("Wallet id cannot be empty.");
    }
  }
}
