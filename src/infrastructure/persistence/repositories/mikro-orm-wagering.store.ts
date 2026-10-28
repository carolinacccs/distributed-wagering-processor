import { EntityManager } from "@mikro-orm/postgresql";
import {
  SubmitWagerData,
  WagerReference,
  WagerSnapshot,
  WagerTransactionSession,
  WageringStore,
} from "../../../application/ports/wagering-store";
import { FailureCode } from "../../../domain/failure-code";
import {
  TransactionDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wager-transaction";
import { Wallet } from "../../../domain/wallet";
import { toDomainWallet } from "../mappers/wallet.mapper";
import { randomUUID } from "node:crypto";

interface WalletRow {
  id: string;
  player_id: string;
  balance: string;
  currency: string;
  version: number;
}

interface TransactionRow {
  id: string;
  provider_id: string;
  player_id: string;
  wallet_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  amount: string;
  currency: string;
  round_id: string | null;
  reference_external_transaction_id: string | null;
  payload_hash: string;
  failure_code: FailureCode | null;
  response_balance: string | null;
  created_at: Date | string;
}

function snapshot(row: TransactionRow): WagerSnapshot {
  return {
    id: row.id,
    providerId: row.provider_id,
    playerId: row.player_id,
    walletId: row.wallet_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    roundId: row.round_id ?? "",
    referenceExternalTransactionId: row.reference_external_transaction_id,
    payloadHash: row.payload_hash,
    failureCode: row.failure_code,
    responseBalance: row.response_balance,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class MikroOrmWageringStore implements WageringStore {
  constructor(private readonly entityManager: EntityManager) {}

  transaction<T>(work: (session: WagerTransactionSession) => Promise<T>): Promise<T> {
    return this.entityManager.transactional(async (transactionalEntityManager) => {
      const connection = transactionalEntityManager.getConnection();
      const context = transactionalEntityManager.getTransactionContext();
      const query = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => {
        return (await connection.execute<R[]>(sql, params, "all", context)) as R[];
      };
      const session: WagerTransactionSession = {
        recordInbox: async (consumerName, messageId, body) => {
          const rows = await query<{ id: string }>(
            `insert into "inbox_messages" ("id", "consumer_name", "message_id", "body")
             values (?, ?, ?, ?)
             on conflict ("consumer_name", "message_id") do nothing
             returning "id"`,
            [randomUUID(), consumerName, messageId, body],
          );
          return rows.length === 1;
        },

        insertOrFind: async (data: SubmitWagerData) => {
          const inserted = await query<{ id: string }>(
            `insert into "wager_transactions"
              ("id", "wallet_id", "provider_id", "player_id", "external_transaction_id",
               "idempotency_key", "kind", "status", "amount", "currency", "round_id",
               "reference_external_transaction_id", "payload_hash")
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict do nothing
             returning "id"`,
            [
              data.id,
              data.walletId,
              data.providerId,
              data.playerId,
              data.externalTransactionId,
              data.idempotencyKey,
              data.kind,
              WagerTransactionStatus.PENDING,
              data.amount.amount,
              data.amount.currency,
              data.roundId,
              data.referenceExternalTransactionId ?? null,
              data.payloadHash,
            ],
          );
          if (inserted.length > 0) {
            return { inserted: true };
          }
          const existingRows = await query<TransactionRow>(
            `select "id", "provider_id", "player_id", "wallet_id",
                    "external_transaction_id", "idempotency_key", "kind", "status",
                    "amount"::text as "amount", "currency", "round_id",
                    "reference_external_transaction_id", "payload_hash", "failure_code",
                    "response_balance"::text as "response_balance", "created_at"
             from "wager_transactions"
             where ("provider_id" = ? and "external_transaction_id" = ?)
                or "idempotency_key" = ?
             for update`,
            [data.providerId, data.externalTransactionId, data.idempotencyKey],
          );
          const existing =
            existingRows.find((row) => row.payload_hash !== data.payloadHash) ??
            existingRows[0];
          if (!existing) {
            throw new Error("Idempotency conflict row could not be loaded.");
          }
          return { inserted: false, existing: snapshot(existing) };
        },

        lockWallet: async (walletId: string) => {
          const rows = await query<WalletRow>(
            `select "id", "player_id", "balance"::text as "balance", "currency", "version"
             from "wallets"
             where "id" = ?
             for update`,
            [walletId],
          );
          const row = rows[0];
          if (!row) {
            return null;
          }
          return {
            wallet: toDomainWallet({
              id: row.id,
              balance: row.balance,
              currency: row.currency,
              version: row.version,
            }),
            playerId: row.player_id,
          };
        },

        findReference: async (providerId: string, externalTransactionId: string) => {
          const rows = await query<TransactionRow>(
            `select "id", "provider_id", "player_id", "wallet_id",
                    "external_transaction_id", "idempotency_key", "kind", "status",
                    "amount"::text as "amount", "currency", "round_id",
                    "reference_external_transaction_id", "payload_hash", "failure_code",
                    "response_balance"::text as "response_balance", "created_at"
             from "wager_transactions"
             where "provider_id" = ? and "external_transaction_id" = ?
             for update`,
            [providerId, externalTransactionId],
          );
          const row = rows[0];
          if (!row) {
            return null;
          }
          const record = snapshot(row);
          const reference: WagerReference = {
            id: record.id,
            providerId: record.providerId,
            playerId: record.playerId,
            walletId: record.walletId,
            kind: record.kind,
            status: record.status,
            amount: record.amount,
            currency: record.currency,
            roundId: record.roundId,
          };
          return reference;
        },

        hasReversal: async (referenceId: string, kind: WagerTransactionKind) => {
          const rows = await query<{ exists: boolean }>(
            `select exists(
               select 1 from "wager_transactions"
               where "reference_id" = ?
                 and "kind" = ?
                 and "status" <> 'REJECTED'
             ) as "exists"`,
            [referenceId, kind],
          );
          return rows[0]?.exists ?? false;
        },

        deferReference: async (id: string) => {
          const rows = await query<{ reference_attempts: number }>(
            `update "wager_transactions"
             set "reference_attempts" = "reference_attempts" + 1,
                 "next_reference_attempt_at" =
                   now() + make_interval(secs => least(900, 5 * power(2, "reference_attempts"))::int),
                 "updated_at" = now()
             where "id" = ?
             returning "reference_attempts"`,
            [id],
          );
          const attempts = rows[0]?.reference_attempts;
          if (attempts === undefined) {
            throw new Error(`Pending reference transaction ${id} was not found.`);
          }
          return { attempts, exhausted: attempts >= 12 };
        },

        saveWallet: async (wallet: Wallet, expectedVersion: number) => {
          const result = await connection.execute(
            `update "wallets"
             set "balance" = ?, "version" = ?, "updated_at" = now()
             where "id" = ? and "version" = ?`,
            [wallet.balance.amount, wallet.version, wallet.id, expectedVersion],
            "run",
            context,
          );
          if ("affectedRows" in result && result.affectedRows !== 1) {
            throw new Error(`Wallet ${wallet.id} changed despite holding its row lock.`);
          }
        },

        updateTransaction: async (id, status, failureCode, responseBalance, referenceId) => {
          await connection.execute(
            `update "wager_transactions"
             set "status" = ?, "failure_code" = ?, "response_balance" = ?,
                 "reference_id" = ?, "updated_at" = now()
             where "id" = ?`,
            [
              status,
              failureCode,
              responseBalance,
              status === WagerTransactionStatus.PROCESSED ? referenceId ?? null : null,
              id,
            ],
            "run",
            context,
          );
        },

        getTransaction: async (id: string) => {
          const rows = await query<TransactionRow>(
            `select "id", "provider_id", "player_id", "wallet_id",
                    "external_transaction_id", "idempotency_key", "kind", "status",
                    "amount"::text as "amount", "currency", "round_id",
                    "reference_external_transaction_id", "payload_hash", "failure_code",
                    "response_balance"::text as "response_balance", "created_at"
             from "wager_transactions"
             where "id" = ?`,
            [id],
          );
          const row = rows[0];
          if (!row) {
            throw new Error(`Wager transaction ${id} was not found after its update.`);
          }
          return snapshot(row);
        },

        appendLedger: async (entry) => {
          await connection.execute(
            `insert into "wallet_ledger_entries"
              ("id", "wallet_id", "transaction_id", "direction", "amount", "currency",
               "balance_before", "balance_after")
             values (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              entry.id,
              entry.walletId,
              entry.transactionId,
              entry.direction,
              entry.amount.amount,
              entry.amount.currency,
              entry.balanceBefore.amount,
              entry.balanceAfter.amount,
            ],
            "run",
            context,
          );
        },

        appendOutbox: async (id, eventType, body) => {
          await connection.execute(
            `insert into "outbox_messages" ("id", "message_id", "event_type", "body")
             values (?, ?, ?, ?)`,
            [id, id, eventType, body],
            "run",
            context,
          );
        },
      };
      return work(session);
    });
  }

  async listPendingReferences(limit: number): Promise<WagerSnapshot[]> {
    const rows = await this.entityManager.transactional(async (em) => {
      const connection = em.getConnection();
      const context = em.getTransactionContext();
      return connection.execute<TransactionRow[]>(
        `with candidates as (
           select "id"
           from "wager_transactions"
           where "status" = ?
             and "next_reference_attempt_at" <= now()
             and "reference_attempts" < 12
           order by "next_reference_attempt_at", "created_at", "id"
           for update skip locked
           limit ?
         )
         update "wager_transactions" as transaction
         set "next_reference_attempt_at" = now() + interval '30 seconds'
         from candidates
         where transaction."id" = candidates."id"
         returning transaction."id", transaction."provider_id", transaction."player_id",
                   transaction."wallet_id", transaction."external_transaction_id",
                   transaction."idempotency_key", transaction."kind", transaction."status",
                   transaction."amount"::text as "amount", transaction."currency",
                   transaction."round_id", transaction."reference_external_transaction_id",
                   transaction."payload_hash", transaction."failure_code",
                   transaction."response_balance"::text as "response_balance",
                   transaction."created_at"`,
        [WagerTransactionStatus.PENDING_REFERENCE, limit],
        "all",
        context,
      ) as Promise<TransactionRow[]>;
    });
    return rows.map(snapshot);
  }
}
