import { createHash, randomUUID } from "node:crypto";
import { EntityManager } from "@mikro-orm/postgresql";
import Decimal from "decimal.js";
import { logger } from "../../observability/logger";
import {
  operationLatency,
  reconciliationDivergenceCounter,
} from "../../observability/metrics";
import { Money } from "../../../domain/money";
import { TransactionDirection, WagerTransaction, WagerTransactionKind } from "../../../domain/wager-transaction";
import { WalletLedgerEntry } from "../../../domain/wallet-ledger-entry";
import { WalletOpenedEvent } from "../../../domain/integration-events";

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: string;
  readonly version: number;
  readonly createdAt: string;
}

export interface LedgerView {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: string;
  readonly amount: string;
  readonly currency: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly createdAt: string;
}

export interface LedgerPage {
  readonly items: LedgerView[];
  readonly nextCursor: string | null;
}

export interface WalletReconciliation {
  readonly walletId: string;
  readonly storedBalance: string;
  readonly calculatedBalance: string;
  readonly difference: string;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date | string;
}

function walletView(row: WalletRow): WalletView {
  return {
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: row.balance,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class WageringQueriesRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async createWallet(
    playerId: string,
    currency: string,
    initialBalance = "0.00",
  ): Promise<WalletView> {
    if (!playerId.trim() || !/^[A-Z]{3}$/.test(currency)) {
      throw new TypeError("Player id and ISO currency are required.");
    }
    const openingBalance = Money.from(initialBalance, currency);
    if (openingBalance.amount.indexOf(".") > 17) {
      throw new TypeError("Initial balance must fit NUMERIC(19,2).");
    }
    const walletId = randomUUID();

    return this.entityManager.transactional(async (em) => {
      const connection = em.getConnection();
      const context = em.getTransactionContext();
      const rows = await connection.execute<WalletRow[]>(
        `insert into "wallets" ("id", "player_id", "currency", "balance", "version")
         values (?, ?, ?, ?, ?)
         returning "id", "player_id", "currency", "balance"::text as "balance",
                   "version", "created_at"`,
        [
          walletId,
          playerId,
          currency,
          openingBalance.amount,
          openingBalance.isZero() ? 0 : 1,
        ],
        "all",
        context,
      ) as WalletRow[];
      const row = rows[0];
      if (!row) {
        throw new Error("Wallet insert did not return a row.");
      }

      if (!openingBalance.isZero()) {
        const transactionId = randomUUID();
        const eventId = randomUUID();
        const idempotencyKey = `opening:${walletId}`;
        const opening = WagerTransaction.create({
          id: transactionId,
          walletId,
          kind: WagerTransactionKind.OPENING,
          amount: openingBalance,
          idempotencyKey,
        });
        opening.markProcessed();
        const payloadHash = createHash("sha256")
          .update(JSON.stringify({ walletId, amount: openingBalance.amount, currency }))
          .digest("hex");
        const occurredAt = new Date().toISOString();
        const event = WalletOpenedEvent.create(
          eventId,
          transactionId,
          walletId,
          openingBalance,
          occurredAt,
        );
        const ledger = WalletLedgerEntry.create(
          randomUUID(),
          walletId,
          transactionId,
          TransactionDirection.CREDIT,
          openingBalance,
          Money.zero(currency),
          openingBalance,
        );

        await connection.execute(
          `insert into "wager_transactions"
            ("id", "wallet_id", "provider_id", "player_id", "external_transaction_id",
             "idempotency_key", "kind", "status", "amount", "currency", "round_id",
             "reference_external_transaction_id", "payload_hash", "response_balance")
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)`,
          [
            transactionId,
            walletId,
            "internal",
            playerId,
            `opening:${walletId}`,
            idempotencyKey,
            opening.kind,
            opening.status,
            opening.amount.amount,
            opening.amount.currency,
            "opening",
            payloadHash,
            openingBalance.amount,
          ],
          "run",
          context,
        );
        await connection.execute(
          `insert into "wallet_ledger_entries"
            ("id", "wallet_id", "transaction_id", "direction", "amount", "currency",
             "balance_before", "balance_after")
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ledger.id,
            ledger.walletId,
            ledger.transactionId,
            ledger.direction,
            ledger.amount.amount,
            ledger.amount.currency,
            ledger.balanceBefore.amount,
            ledger.balanceAfter.amount,
          ],
          "run",
          context,
        );
        await connection.execute(
          `insert into "outbox_messages" ("id", "message_id", "event_type", "body")
           values (?, ?, ?, ?)`,
          [
            randomUUID(),
            event.eventId,
            event.type,
            JSON.stringify({
              type: event.type,
              eventId: event.eventId,
              occurredAt: event.occurredAt,
              transactionId: event.transactionId,
              walletId: event.walletId,
              amount: event.amount.amount,
              currency: event.amount.currency,
            }),
          ],
          "run",
          context,
        );
      }
      return walletView(row);
    });
  }

  async findWallet(walletId: string): Promise<WalletView | null> {
    const rows = await this.entityManager.getConnection().execute<WalletRow[]>(
      `select "id", "player_id", "currency", "balance"::text as "balance",
              "version", "created_at"
       from "wallets" where "id" = ?`,
      [walletId],
      "all",
    ) as WalletRow[];
    return rows[0] ? walletView(rows[0]) : null;
  }

  async findWalletByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<WalletView | null> {
    const rows = await this.entityManager.getConnection().execute<WalletRow[]>(
      `select "id", "player_id", "currency", "balance"::text as "balance",
              "version", "created_at"
       from "wallets" where "player_id" = ? and "currency" = ?`,
      [playerId, currency],
      "all",
    ) as WalletRow[];
    return rows[0] ? walletView(rows[0]) : null;
  }

  async findTransaction(
    transactionId: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.entityManager.getConnection().execute<Record<string, unknown>[]>(
      `select "id", "provider_id" as "providerId", "player_id" as "playerId",
              "wallet_id" as "walletId", "external_transaction_id" as "externalTransactionId",
              "kind", "status", "amount"::text as "amount", "currency", "round_id" as "roundId",
              "reference_external_transaction_id" as "referenceExternalTransactionId",
              "failure_code" as "failureCode", "response_balance"::text as "responseBalance",
              "created_at" as "createdAt"
       from "wager_transactions"
       where "id" = ?`,
      [transactionId],
      "all",
    ) as Record<string, unknown>[];
    return rows[0] ?? null;
  }

  async findProviderTransaction(
    providerId: string,
    externalTransactionId: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.entityManager.getConnection().execute<Record<string, unknown>[]>(
      `select "id", "provider_id" as "providerId", "player_id" as "playerId",
              "wallet_id" as "walletId", "external_transaction_id" as "externalTransactionId",
              "kind", "status", "amount"::text as "amount", "currency", "round_id" as "roundId",
              "reference_external_transaction_id" as "referenceExternalTransactionId",
              "failure_code" as "failureCode", "response_balance"::text as "responseBalance",
              "created_at" as "createdAt"
       from "wager_transactions"
       where "provider_id" = ? and "external_transaction_id" = ?`,
      [providerId, externalTransactionId],
      "all",
    ) as Record<string, unknown>[];
    return rows[0] ?? null;
  }

  async listWalletLedger(
    walletId: string,
    cursor?: string,
    limit = 50,
  ): Promise<LedgerPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Ledger limit must be between 1 and 100.");
    }
    const decoded = cursor === undefined ? null : decodeCursor(cursor);
    const params: unknown[] = [walletId];
    const cursorClause = decoded
      ? `and ("created_at", "id") > (?, ?)`
      : "";
    if (decoded) {
      params.push(decoded.createdAt, decoded.id);
    }
    params.push(limit + 1);
    const rows = await this.entityManager.getConnection().execute<LedgerView[]>(
      `select "id", "wallet_id" as "walletId", "transaction_id" as "transactionId",
              "direction", "amount"::text as "amount", "currency",
              "balance_before"::text as "balanceBefore",
              "balance_after"::text as "balanceAfter", "created_at"::text as "createdAt"
       from "wallet_ledger_entries"
       where "wallet_id" = ? ${cursorClause}
       order by "created_at", "id"
       limit ?`,
      params,
      "all",
    ) as LedgerView[];
    const hasMore = rows.length > limit;
    const rawLast = rows[Math.min(rows.length, limit) - 1];
    const items = rows.slice(0, limit).map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
    return {
      items,
      nextCursor:
        hasMore && rawLast
          ? encodeCursor(rawLast.createdAt, rawLast.id)
          : null,
    };
  }

  async reconcileWallet(walletId: string): Promise<WalletReconciliation | null> {
    const end = operationLatency.startTimer({ operation: "wallet_reconciliation" });
    try {
      return await this.entityManager.transactional(async (em) => {
        const connection = em.getConnection();
        const context = em.getTransactionContext();
        const wallets = await connection.execute<WalletRow[]>(
          `select "id", "player_id", "currency", "balance"::text as "balance",
                  "version", "created_at"
           from "wallets" where "id" = ? for update`,
          [walletId],
          "all",
          context,
        ) as WalletRow[];
        const wallet = wallets[0];
        if (!wallet) {
          return null;
        }
        const totals = await connection.execute<
          Array<{ total: string; entries: number }>
        >(
          `select coalesce(sum(case
                    when "direction" = 'CREDIT' then "amount"
                    else -"amount"
                  end), 0)::text as "total",
                  count(*)::int as "entries"
           from "wallet_ledger_entries"
           where "wallet_id" = ?`,
          [walletId],
          "all",
          context,
        );
        const row = (totals as Array<{ total: string; entries: number }>)[0];
        if (!row) {
          throw new Error("Wallet ledger reconciliation returned no aggregate row.");
        }
        const stored = Money.from(wallet.balance, wallet.currency);
        const calculated = Money.from(row.total, wallet.currency);
        const difference = new Decimal(stored.amount)
          .minus(calculated.amount)
          .toFixed(2);
        const result: WalletReconciliation = {
          walletId,
          storedBalance: stored.amount,
          calculatedBalance: calculated.amount,
          difference,
          consistent: new Decimal(difference).isZero(),
          checkedEntries: row.entries,
        };
        if (!result.consistent) {
          reconciliationDivergenceCounter.inc();
          logger.error(
            {
              event: "wallet_reconciliation_divergence",
              walletId,
              checkedEntries: result.checkedEntries,
            },
            "Wallet ledger reconciliation found a balance divergence",
          );
        }
        return result;
      });
    } finally {
      end();
    }
  }
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    if (!cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new TypeError();
    }
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      value === null ||
      typeof value !== "object" ||
      !("createdAt" in value) ||
      !("id" in value) ||
      typeof value.createdAt !== "string" ||
      Number.isNaN(Date.parse(value.createdAt)) ||
      typeof value.id !== "string" ||
      !value.id
    ) {
      throw new TypeError();
    }
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new TypeError("Invalid ledger cursor.");
  }
}
