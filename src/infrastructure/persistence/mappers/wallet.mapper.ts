import { Money } from "../../../domain/money";
import { Wallet } from "../../../domain/wallet";
import { WalletRecord } from "../entities/records";

export function toDomainWallet(record: Pick<WalletRecord, "id" | "balance" | "currency" | "version">): Wallet {
  return Wallet.rehydrate(
    record.id,
    Money.from(record.balance, record.currency),
    record.version,
  );
}
