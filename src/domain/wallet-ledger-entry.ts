import { Money } from "./money";
import { TransactionDirection } from "./wager-transaction";

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: TransactionDirection,
    public readonly amount: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
  ) {
    Object.freeze(this);
  }

  static create(
    id: string,
    walletId: string,
    transactionId: string,
    direction: TransactionDirection,
    amount: Money,
    balanceBefore: Money,
    balanceAfter: Money,
  ): WalletLedgerEntry {
    const expectedBalance =
      direction === TransactionDirection.CREDIT
        ? balanceBefore.add(amount)
        : balanceBefore.subtract(amount);
    if (!expectedBalance.equals(balanceAfter)) {
      throw new RangeError("Ledger entry balances do not match its direction and amount.");
    }
    if (!id.trim() || !walletId.trim() || !transactionId.trim()) {
      throw new TypeError("Ledger entry identifiers cannot be empty.");
    }
    return new WalletLedgerEntry(
      id,
      walletId,
      transactionId,
      direction,
      amount,
      balanceBefore,
      balanceAfter,
    );
  }
}
