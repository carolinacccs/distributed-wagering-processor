import { EntityManager } from "@mikro-orm/postgresql";
import { Wallet } from "../../../domain/wallet";
import { toDomainWallet } from "../mappers/wallet.mapper";

interface WalletBalanceRow {
  id: string;
  balance: string;
  currency: string;
  version: number;
}

export class WalletRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async withLockedWallet<T>(
    walletId: string,
    operation: (wallet: Wallet) => Promise<T> | T,
  ): Promise<T | null> {
    if (!walletId.trim()) {
      throw new TypeError("Wallet id cannot be empty.");
    }

    return this.entityManager.transactional(async (transactionalEntityManager) => {
      const rows = await transactionalEntityManager.getConnection().execute<WalletBalanceRow[]>(
        `select "id", "balance"::text as "balance", "currency", "version"
         from "wallets"
         where "id" = ?
         for update`,
        [walletId],
        "all",
        transactionalEntityManager.getTransactionContext(),
      );
      const record = rows[0];
      if (!record) {
        return null;
      }

      const wallet = toDomainWallet(record);
      const initialVersion = wallet.version;
      const initialBalance = wallet.balance;
      const result = await operation(wallet);

      if (wallet.version !== initialVersion) {
        const updated = await transactionalEntityManager.getConnection().execute(
          `update "wallets"
           set "balance" = ?, "version" = ?, "updated_at" = now()
           where "id" = ? and "version" = ?`,
          [wallet.balance.amount, wallet.version, walletId, initialVersion],
          "run",
          transactionalEntityManager.getTransactionContext(),
        );
        if ("affectedRows" in updated && updated.affectedRows !== 1) {
          throw new Error(`Wallet ${walletId} changed despite holding its row lock.`);
        }
      } else if (!wallet.balance.equals(initialBalance)) {
        throw new Error("Wallet balance changed without a version increment.");
      }

      return result;
    });
  }
}
