import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import { Pool } from "pg";
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  ReceiveMessageCommandOutput,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  SubmitWagerError,
  SubmitWagerRequest,
  SubmitWagerTransaction,
} from "../application/submit-wager-transaction";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { OutboxPublisher } from "../infrastructure/messaging/outbox-publisher";
import { sqsClient, wagerDlqUrl, wagerQueueUrl, eventsQueueUrl } from "../infrastructure/messaging/sqs-client";
import { WagerSqsConsumer } from "../infrastructure/messaging/wager-sqs-consumer";
import { MikroOrmWageringStore } from "../infrastructure/persistence/repositories/mikro-orm-wagering.store";
import ormConfig from "../infrastructure/persistence/mikro-orm.config";

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = describe.skipIf(!enabled);
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://wagering:wagering@localhost:5432/wagering";
const API_PORTS = [3101, 3102, 3103];
const API_URLS = API_PORTS.map((port) => `http://127.0.0.1:${port}`);
const CONSUMER_NAME = "wager-transactions-v1";

interface WalletResponse {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
}

interface WagerResponse {
  id: string;
  status: string;
  failureCode: string | null;
  walletId: string;
}

let pool: Pool;
let orm: MikroORM;
let useCase: SubmitWagerTransaction;
let children: ChildProcess[] = [];

describeIntegration("real PostgreSQL, SQS, and multiple application processes", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query("select 1");
    orm = await MikroORM.init(ormConfig);
    useCase = new SubmitWagerTransaction(
      new MikroOrmWageringStore(orm.em.fork()),
    );
    children = await Promise.all(API_PORTS.map((port) => startApi(port)));
    await drainQueue(wagerQueueUrl);
    await drainQueue(wagerDlqUrl);
    await drainQueue(eventsQueueUrl);
  }, 120_000);

  beforeEach(async () => {
    await pool.query(
      `truncate table "outbox_messages", "inbox_messages", "wallet_ledger_entries",
       "wager_transactions", "wallets" cascade`,
    );
    await drainQueue(wagerQueueUrl);
    await drainQueue(wagerDlqUrl);
    await drainQueue(eventsQueueUrl);
  });

  afterAll(async () => {
    if (pool) await expectAllWalletsConsistent();
    await stopApis();
    await orm?.close(true);
    await pool?.end();
    await sqsClient.destroy();
  }, 30_000);

  afterEach(async () => {
    await expectAllWalletsConsistent();
  });

  test("two parallel BETs of 80 against 100 process exactly one debit", async () => {
    const wallet = await createWallet("player-lock", "USD");
    await submit({
      walletId: wallet.id,
      externalTransactionId: "fund-lock",
      kind: WagerTransactionKind.WIN,
      amount: "100.00",
    });

    const results = await Promise.all([
      submit({ walletId: wallet.id, externalTransactionId: "bet-lock-1", amount: "80.00" }),
      submit({ walletId: wallet.id, externalTransactionId: "bet-lock-2", amount: "80.00" }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect((await walletById(wallet.id)).balance).toBe("20.00");
    const { rows } = await pool.query(
      `select count(*)::int as count
       from "wallet_ledger_entries"
       where "wallet_id" = $1 and "direction" = 'DEBIT'`,
      [wallet.id],
    );
    expect(rows[0]?.count).toBe(1);
  });

  test("50 simultaneous submissions of the same BET create one debit", async () => {
    const wallet = await createWallet("player-idempotent", "USD");
    await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "fund-idempotent",
      kind: WagerTransactionKind.WIN,
      amount: "100.00",
    });
    const submissions = await Promise.all(
      Array.from({ length: 50 }, () =>
        submit({
          walletId: wallet.id,
          playerId: wallet.playerId,
          externalTransactionId: "same-bet",
          idempotencyKey: "same-key",
          amount: "50.00",
        }),
      ),
    );
    expect(new Set(submissions.map((result) => result.id)).size).toBe(1);
    expect(submissions.map((result) => result.status)).toEqual(
      Array.from({ length: 50 }, () => "PROCESSED"),
    );
    expect((await walletById(wallet.id)).balance).toBe("50.00");
    const { rows } = await pool.query(
      `select count(*)::int as count
       from "wallet_ledger_entries"
       where "wallet_id" = $1 and "direction" = 'DEBIT'`,
      [wallet.id],
    );
    expect(rows[0]?.count).toBe(1);
  });

  test("different wallets proceed concurrently without sharing a wallet lock", async () => {
    const [first, second] = await Promise.all([
      createWallet("player-distinct-a", "USD"),
      createWallet("player-distinct-b", "USD"),
    ]);
    await Promise.all([
      submit({
        walletId: first.id,
        playerId: first.playerId,
        externalTransactionId: "fund-a",
        kind: WagerTransactionKind.WIN,
        amount: "10.00",
      }),
      submit({
        walletId: second.id,
        playerId: second.playerId,
        externalTransactionId: "fund-b",
        kind: WagerTransactionKind.WIN,
        amount: "10.00",
      }),
    ]);
    const [a, b] = await Promise.all([
      submit({
        walletId: first.id,
        playerId: first.playerId,
        externalTransactionId: "bet-a",
        amount: "10.00",
      }),
      submit({
        walletId: second.id,
        playerId: second.playerId,
        externalTransactionId: "bet-b",
        amount: "10.00",
      }),
    ]);
    expect(a.status).toBe("PROCESSED");
    expect(b.status).toBe("PROCESSED");
    expect((await walletById(first.id)).balance).toBe("0.00");
    expect((await walletById(second.id)).balance).toBe("0.00");
  });

  test("ledger pagination rejects invalid limits and cursors with HTTP 400", async () => {
    const wallet = await createWallet("player-invalid-ledger-query", "USD");
    const invalidQueries = ["limit=abc", "limit=0", "limit=-1", "limit=101", "cursor=invalid"];
    for (const query of invalidQueries) {
      const response = await fetch(
        `${API_URLS[0]}/wallets/${wallet.id}/ledger?${query}`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: "INVALID_QUERY",
        message:
          query.startsWith("limit=")
            ? "Ledger limit must be an integer between 1 and 100."
            : "Invalid ledger cursor.",
      });
    }
  });

  test("wallet opening balance creates a processed OPENING, ledger credit, and reconciles", async () => {
    const wallet = await createWallet("player-opening", "USD", "25.50");
    expect(wallet.balance).toBe("25.50");
    const { rows } = await pool.query(
      `select transaction."kind", transaction."status", ledger."direction",
              ledger."balance_before"::text as "balance_before",
              ledger."balance_after"::text as "balance_after"
       from "wallet_ledger_entries" ledger
       join "wager_transactions" transaction on transaction."id" = ledger."transaction_id"
       where ledger."wallet_id" = $1`,
      [wallet.id],
    );
    expect(rows).toEqual([
      {
        kind: "OPENING",
        status: "PROCESSED",
        direction: "CREDIT",
        balance_before: "0.00",
        balance_after: "25.50",
      },
    ]);
    const reconciliation = await fetch(
      `${API_URLS[0]}/wallets/${wallet.id}/reconciliation`,
      { method: "POST" },
    );
    expect(reconciliation.status).toBe(201);
    expect(await reconciliation.json()).toMatchObject({
      walletId: wallet.id,
      storedBalance: "25.50",
      calculatedBalance: "25.50",
      difference: "0.00",
      consistent: true,
      checkedEntries: 1,
    });
    const eventRows = await pool.query(
      `select count(*)::int as count from "outbox_messages"
       where "event_type" = 'WALLET_OPENED'
         and "body"::jsonb->>'walletId' = $1`,
      [wallet.id],
    );
    expect(eventRows.rows[0]?.count).toBe(1);
  });

  test("ROLLBACK of a BET credits once and rejects a duplicate same-kind reversal", async () => {
    const wallet = await createWallet("player-rollback-bet", "USD", "10.00");
    const bet = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "rollback-bet-target",
      amount: "3.00",
    });
    expect(bet.status).toBe("PROCESSED");
    const rollback = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "rollback-bet",
      kind: WagerTransactionKind.ROLLBACK,
      amount: "3.00",
      referenceExternalTransactionId: "rollback-bet-target",
    });
    expect(rollback.status).toBe("PROCESSED");
    expect((await walletById(wallet.id)).balance).toBe("10.00");
    const duplicate = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "rollback-bet-duplicate",
      kind: WagerTransactionKind.ROLLBACK,
      amount: "3.00",
      referenceExternalTransactionId: "rollback-bet-target",
    });
    expect(duplicate.status).toBe("REJECTED");
    expect(duplicate.failureCode).toBe("DUPLICATE_REVERSAL");
    expect((await walletById(wallet.id)).balance).toBe("10.00");
  });

  test("ROLLBACK of a WIN debits", async () => {
    const wallet = await createWallet("player-rollback-win", "USD", "10.00");
    const win = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "rollback-win-target",
      kind: WagerTransactionKind.WIN,
      amount: "3.00",
    });
    expect(win.status).toBe("PROCESSED");
    const rollback = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "rollback-win",
      kind: WagerTransactionKind.ROLLBACK,
      amount: "3.00",
      referenceExternalTransactionId: "rollback-win-target",
    });
    expect(rollback.status).toBe("PROCESSED");
    expect((await walletById(wallet.id)).balance).toBe("10.00");
  });

  test("ROLLBACK of a REFUND debits", async () => {
    const wallet = await createWallet("player-rollback-refund", "USD", "10.00");
    const bet = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "rollback-refund-bet",
      amount: "3.00",
    });
    expect(bet.status).toBe("PROCESSED");
    const refund = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "rollback-refund-target",
      kind: WagerTransactionKind.REFUND,
      amount: "3.00",
      referenceExternalTransactionId: "rollback-refund-bet",
    });
    expect(refund.status).toBe("PROCESSED");
    const rollback = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "rollback-refund",
      kind: WagerTransactionKind.ROLLBACK,
      amount: "3.00",
      referenceExternalTransactionId: "rollback-refund-target",
    });
    expect(rollback.status).toBe("PROCESSED");
    expect((await walletById(wallet.id)).balance).toBe("7.00");
  });

  test("PostgreSQL enforces balance, uniqueness, and ledger immutability constraints", async () => {
    const wallet = await createWallet("player-schema-constraints", "USD");
    const funded = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "constraint-funding",
      idempotencyKey: "constraint-funding-key",
      kind: WagerTransactionKind.WIN,
      amount: "12.00",
    });
    expect(funded.status).toBe("PROCESSED");

    await expectPostgresError(
      () => pool.query(`update "wallets" set "balance" = -1 where "id" = $1`, [wallet.id]),
      "23514",
    );
    await expectPostgresError(
      () =>
        pool.query(
          `insert into "wallets" ("id", "player_id", "currency")
           values ($1, $2, $3)`,
          [randomUUID(), wallet.playerId, wallet.currency],
        ),
      "23505",
    );
    await expectPostgresError(
      () =>
        pool.query(
          `insert into "wager_transactions"
            ("id", "wallet_id", "provider_id", "player_id", "external_transaction_id",
             "idempotency_key", "kind", "status", "amount", "currency", "round_id",
             "payload_hash")
           values ($1, $2, $3, $4, $5, $6, 'WIN', 'PENDING', 1, 'USD', 'round', 'hash')`,
          [
            randomUUID(),
            wallet.id,
            "provider-duplicate-key",
            wallet.playerId,
            "external-duplicate-key",
            "constraint-funding-key",
          ],
        ),
      "23505",
    );
    await expectPostgresError(
      () =>
        pool.query(
          `update "wallet_ledger_entries" set "amount" = "amount"
           where "transaction_id" = $1`,
          [funded.id],
        ),
      "P0001",
    );
    await expectPostgresError(
      () =>
        pool.query(
          `delete from "wallet_ledger_entries" where "transaction_id" = $1`,
          [funded.id],
        ),
      "P0001",
    );
    expect((await walletById(wallet.id)).balance).toBe("12.00");
  });

  test("SQS deduplicates redelivery, retries transient failures, and dead-letters invalid and exhausted messages", async () => {
    const wallet = await createWallet("player-redelivery", "USD");
    const funding = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "fund-redelivery",
      idempotencyKey: "fund-redelivery-key",
      kind: WagerTransactionKind.WIN,
      amount: "20.00",
    });
    expect(funding.status).toBe(WagerTransactionStatus.PROCESSED);
    expect((await walletById(wallet.id)).balance).toBe("20.00");
    const payload = {
      providerId: "provider-it",
      playerId: wallet.playerId,
      walletId: wallet.id,
      externalTransactionId: "redelivered-bet",
      idempotencyKey: "redelivery-key",
      kind: WagerTransactionKind.BET,
      amount: "5.00",
      currency: "USD",
      roundId: "round-redelivery",
    };
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: wagerQueueUrl,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: randomUUID(),
      }),
    );
    const received = await waitForMessage(wagerQueueUrl);
    const message = received.Messages?.[0];
    expect(message?.MessageId).toBeDefined();
    expect(message?.ReceiptHandle).toBeDefined();
    const originalResult = await useCase.execute({
      ...payload,
      messageId: message!.MessageId!,
      consumerName: CONSUMER_NAME,
      rawMessageBody: message!.Body!,
    });
    await sqsClient.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: wagerQueueUrl,
        ReceiptHandle: message!.ReceiptHandle!,
        VisibilityTimeout: 0,
      }),
    );
    const heldLock = await pool.connect();
    await heldLock.query("begin");
    await heldLock.query(
      `select "id" from "wager_transactions" where "id" = $1 for update`,
      [originalResult.id],
    );
    const submitter = new FaultInjectingSubmitter(
      useCase,
      new Map([
        ["retry-after-transient", 1],
        ["over-receive-limit", Number.POSITIVE_INFINITY],
      ]),
    );
    const consumer = new WagerSqsConsumer(submitter);
    consumer.start();
    let lockOpen = true;
    try {
      await waitUntil(async () => {
        const { rows } = await pool.query(
          `select count(*)::int as count
           from pg_stat_activity
           where wait_event_type = 'Lock'
             and query ilike '%wager_transactions%'
             and query ilike '%for update%'`,
        );
        return rows[0]?.count > 0;
      }, 15_000, "consumer locking the previously committed wager");
      await heldLock.query("commit");
      heldLock.release();
      lockOpen = false;
      await waitUntil(async () => {
        const queue = await sqsClient.send(
          new GetQueueAttributesCommand({
            QueueUrl: wagerQueueUrl,
            AttributeNames: [
              "ApproximateNumberOfMessages",
              "ApproximateNumberOfMessagesNotVisible",
            ],
          }),
        );
        return (
          Number(queue.Attributes?.ApproximateNumberOfMessages ?? 0) === 0 &&
          Number(queue.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) === 0
        );
      }, 15_000, "redelivered SQS message acknowledged");

      const retryPayload = queuePayload(wallet, "retry-after-transient", "1.00");
      await enqueueWager(retryPayload);
      await waitUntil(
        async () =>
          submitter.resultStatus("retry-after-transient") !== undefined ||
          submitter.failure("retry-after-transient") !== undefined,
        45_000,
        "transient SQS message to receive its retry result",
      );
      expect(submitter.failure("retry-after-transient")).toBeUndefined();
      expect(submitter.resultStatus("retry-after-transient")).toBe(
        WagerTransactionStatus.PROCESSED,
      );
      expect(submitter.retryDelayMilliseconds("retry-after-transient")).toBeGreaterThanOrEqual(
        900,
      );
      await waitUntil(
        () => isQueueEmpty(wagerQueueUrl),
        15_000,
        "transient SQS message acknowledgement",
      );

      await enqueueRawMessage("{not-json");
      const malformed = await receiveDeadLetter("INVALID_MESSAGE", 45_000);
      expect(typeof malformed.originalMessageId).toBe("string");
      await waitUntil(
        () => isQueueEmpty(wagerQueueUrl),
        15_000,
        "malformed SQS message acknowledgement",
      );

      const openingSubmission = {
        providerId: "provider-it",
        playerId: wallet.playerId,
        walletId: wallet.id,
        externalTransactionId: "opening-must-be-internal",
        idempotencyKey: "opening-must-be-internal-key",
        kind: WagerTransactionKind.OPENING,
        amount: "1.00",
        currency: wallet.currency,
        roundId: "opening",
      };
      const apiResponse = await fetch(`${API_URLS[0]}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": openingSubmission.idempotencyKey,
        },
        body: JSON.stringify(openingSubmission),
      });
      expect(apiResponse.status).toBe(400);
      await enqueueWager(openingSubmission);
      const openingDeadLetter = await receiveDeadLetter("INVALID_PAYLOAD", 45_000);
      expect(typeof openingDeadLetter.originalMessageId).toBe("string");
      await waitUntil(
        () => isQueueEmpty(wagerQueueUrl),
        15_000,
        "internal OPENING wager message acknowledgement",
      );

      await enqueueWager({
        providerId: "provider-it",
        playerId: "player-over-limit",
        walletId: randomUUID(),
        externalTransactionId: "over-receive-limit",
        idempotencyKey: "over-receive-limit-key",
        kind: WagerTransactionKind.BET,
        amount: "1.00",
        currency: "USD",
        roundId: "round-over-limit",
      });
      const exhausted = await receiveDeadLetter("TRANSIENT_FAILURE", 90_000);
      expect(typeof exhausted.originalMessageId).toBe("string");
      expect(submitter.attemptsFor("over-receive-limit")).toBeGreaterThanOrEqual(4);
      expect(submitter.attemptsFor("over-receive-limit")).toBeLessThanOrEqual(5);
    } finally {
      if (lockOpen) {
        await heldLock.query("rollback");
        heldLock.release();
      }
      await consumer.stop();
    }
    const { rows: inboxRows } = await pool.query(
      `select count(*)::int as count from "inbox_messages"
       where "consumer_name" = $1 and "message_id" = $2`,
      [CONSUMER_NAME, message!.MessageId],
    );
    expect(inboxRows[0]?.count).toBe(1);
    const { rows: ledgerRows } = await pool.query(
      `select count(*)::int as count from "wallet_ledger_entries"
       where "wallet_id" = $1 and "transaction_id" = $2`,
      [wallet.id, originalResult.id],
    );
    expect(ledgerRows[0]?.count).toBe(1);
    const { rows } = await pool.query(
      `select count(*)::int as count from "wallet_ledger_entries"
       where "wallet_id" = $1 and "direction" = 'DEBIT'`,
      [wallet.id],
    );
    expect(rows[0]?.count).toBe(2);
    expect((await walletById(wallet.id)).balance).toBe("14.00");
    const { rows: retryLedgerRows } = await pool.query(
      `select count(*)::int as count
       from "wallet_ledger_entries"
       where "wallet_id" = $1
         and "transaction_id" = (
           select "id" from "wager_transactions"
           where "provider_id" = $2 and "external_transaction_id" = $3
         )`,
      [wallet.id, "provider-it", "retry-after-transient"],
    );
    expect(retryLedgerRows[0]?.count).toBe(1);
  });

  test("two concurrent publishers claim and publish an outbox event once", async () => {
    const wallet = await createWallet("player-outbox", "USD");
    await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "fund-outbox",
      kind: WagerTransactionKind.WIN,
      amount: "3.00",
    });
    const publishers = [
      new OutboxPublisher(orm.em.fork()),
      new OutboxPublisher(orm.em.fork()),
    ];
    publishers.forEach((publisher) => publisher.start());
    await waitUntil(async () => {
      const { rows } = await pool.query(
        `select count(*)::int as count from "outbox_messages" where "published_at" is null`,
      );
      return rows[0]?.count === 0;
    }, 15_000);
    await Promise.all(publishers.map((publisher) => publisher.stop()));
    const received = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    const matching = (received.Messages ?? []).filter((message) => {
      if (!message.Body) {
        return false;
      }
      try {
        return JSON.parse(message.Body).transactionId !== undefined;
      } catch {
        return false;
      }
    });
    expect(matching.length).toBe(1);
  });

  test("REFUND and ROLLBACK remain pending until their references are persisted", async () => {
    const wallet = await createWallet("player-ref-order", "USD");
    await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "fund-ref-order",
      kind: WagerTransactionKind.WIN,
      amount: "10.00",
    });
    const refund = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "refund-before-bet",
      kind: WagerTransactionKind.REFUND,
      amount: "2.00",
      referenceExternalTransactionId: "future-bet",
    });
    expect(refund.status).toBe("PENDING_REFERENCE");
    await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "future-bet",
      kind: WagerTransactionKind.BET,
      amount: "2.00",
    });
    await pool.query(
      `update "wager_transactions" set "next_reference_attempt_at" = now()
       where "id" = $1`,
      [refund.id],
    );
    await useCase.reconcilePendingReferences();
    expect((await transactionById(refund.id)).status).toBe("PROCESSED");

    const rollback = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "rollback-before-refund",
      kind: WagerTransactionKind.ROLLBACK,
      amount: "2.00",
      referenceExternalTransactionId: "future-refund",
    });
    expect(rollback.status).toBe("PENDING_REFERENCE");
    const secondBet = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "bet-for-second-refund",
      kind: WagerTransactionKind.BET,
      amount: "2.00",
    });
    expect(secondBet.status).toBe("PROCESSED");
    const secondRefund = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "future-refund",
      kind: WagerTransactionKind.REFUND,
      amount: "2.00",
      referenceExternalTransactionId: "bet-for-second-refund",
    });
    expect(secondRefund.status).toBe("PROCESSED");
    await pool.query(
      `update "wager_transactions" set "next_reference_attempt_at" = now()
       where "id" = $1`,
      [rollback.id],
    );
    await useCase.reconcilePendingReferences();
    expect((await transactionById(rollback.id)).status).toBe("PROCESSED");
  });

  test("pending REFUND and ROLLBACK are rejected with an outbox event after retry exhaustion", async () => {
    const wallet = await createWallet("player-ref-exhaustion", "USD");
    const refund = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "refund-reference-never-arrives",
      kind: WagerTransactionKind.REFUND,
      amount: "2.00",
      referenceExternalTransactionId: "missing-bet",
    });
    const rollback = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "rollback-reference-never-arrives",
      kind: WagerTransactionKind.ROLLBACK,
      amount: "2.00",
      referenceExternalTransactionId: "missing-refund",
    });
    expect(refund.status).toBe("PENDING_REFERENCE");
    expect(rollback.status).toBe("PENDING_REFERENCE");

    await pool.query(
      `update "wager_transactions"
       set "reference_attempts" = 11, "next_reference_attempt_at" = now()
       where "id" = any($1::text[])`,
      [[refund.id, rollback.id]],
    );
    const results = await useCase.reconcilePendingReferences();
    expect(results.map((result) => result.status)).toEqual([
      WagerTransactionStatus.REJECTED,
      WagerTransactionStatus.REJECTED,
    ]);
    for (const id of [refund.id, rollback.id]) {
      const transaction = await transactionById(id);
      expect(transaction.status).toBe("REJECTED");
      expect(transaction.failureCode).toBe("REFERENCED_TRANSACTION_NOT_FOUND");
    }
    const { rows } = await pool.query(
      `select count(*)::int as count
       from "outbox_messages"
       where "event_type" = 'WAGER_TRANSACTION_REJECTED'
         and "body"::jsonb->>'failureCode' = 'REFERENCED_TRANSACTION_NOT_FOUND'
         and "body"::jsonb->>'transactionId' = any($1::text[])`,
      [[refund.id, rollback.id]],
    );
    expect(rows[0]?.count).toBe(2);
  });

  test("three application processes share persisted state across a process restart", async () => {
    const wallet = await createWallet("player-restart", "USD");
    const saved = await submit({
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: "persist-across-restart",
      kind: WagerTransactionKind.WIN,
      amount: "1.00",
    });
    const old = children.shift();
    old?.kill("SIGTERM");
    if (old) {
      await new Promise<void>((resolve) => old.once("exit", () => resolve()));
    }
    const restarted = await startApi(API_PORTS[0]!);
    children.push(restarted);
    const response = await fetch(`${API_URLS[0]}/wagering/transactions/${saved.id}`);
    expect(response.status).toBe(200);
    const transaction = (await response.json()) as WagerResponse;
    expect(transaction.id).toBe(saved.id);
  });
});

async function startApi(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["run", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL,
      SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
      BACKGROUND_WORKERS: "false",
    },
    stdio: "ignore",
  });
  await waitUntil(async () => {
    if (child.exitCode !== null) {
      throw new Error(`API process on port ${port} exited with ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`);
      return response.ok;
    } catch {
      return false;
    }
  }, 30_000);
  return child;
}

async function stopApis(): Promise<void> {
  const running = [...children];
  children = [];
  for (const child of running) {
    child.kill("SIGTERM");
  }
  await Promise.all(
    running.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
          } else {
            child.once("exit", () => resolve());
          }
        }),
    ),
  );
}

async function createWallet(
  playerId: string,
  currency: string,
  initialBalance?: string,
): Promise<WalletResponse> {
  const response = await fetch(`${API_URLS[0]}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, currency, ...(initialBalance ? { initialBalance } : {}) }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as WalletResponse;
}

async function submit(
  overrides: Partial<{
    walletId: string;
    playerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    kind: WagerTransactionKind;
    amount: string;
    referenceExternalTransactionId: string;
  }>,
): Promise<WagerResponse> {
  const request = {
    providerId: "provider-it",
    playerId: "player-lock",
    walletId: "",
    externalTransactionId: "transaction",
    roundId: "round-it",
    kind: WagerTransactionKind.BET,
    amount: "1.00",
    currency: "USD",
    ...overrides,
  };
  const key = overrides.idempotencyKey ?? `${request.externalTransactionId}-key`;
  const api = API_URLS[Math.floor(Math.random() * API_URLS.length)]!;
  const response = await fetch(`${api}/wagering/transactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(request),
  });
  const body = (await response.json()) as WagerResponse;
  if (response.status !== 200 && response.status !== 202 && response.status !== 422) {
    throw new Error(`Unexpected submit HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function walletById(walletId: string): Promise<WalletResponse> {
  const response = await fetch(`${API_URLS[0]}/wallets/${walletId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as WalletResponse;
}

async function transactionById(id: string): Promise<WagerResponse> {
  const response = await fetch(`${API_URLS[0]}/wagering/transactions/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as WagerResponse;
}

function queuePayload(
  wallet: WalletResponse,
  externalTransactionId: string,
  amount: string,
): SubmitWagerRequest {
  return {
    providerId: "provider-it",
    playerId: wallet.playerId,
    walletId: wallet.id,
    externalTransactionId,
    idempotencyKey: `${externalTransactionId}-key`,
    kind: WagerTransactionKind.BET,
    amount,
    currency: wallet.currency,
    roundId: `round-${externalTransactionId}`,
  };
}

async function enqueueWager(payload: SubmitWagerRequest): Promise<void> {
  await enqueueRawMessage(JSON.stringify(payload), payload.walletId);
}

async function enqueueRawMessage(
  body: string,
  messageGroupId: string = randomUUID(),
): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: wagerQueueUrl,
      MessageBody: body,
      MessageGroupId: messageGroupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function receiveDeadLetter(
  expectedFailureCode: string,
  timeoutMilliseconds: number,
): Promise<Record<string, unknown>> {
  const observedFailureCodes: string[] = [];
  let matchingMessage: Record<string, unknown> | undefined;
  await waitUntil(
    async () => {
      const response = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: wagerDlqUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 30,
        }),
      );
      const message = response.Messages?.[0];
      if (!message?.ReceiptHandle || !message.Body) {
        return false;
      }

      let body: unknown;
      try {
        body = JSON.parse(message.Body);
      } catch {
        body = null;
      }
      const failureCode =
        body !== null &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        "failureCode" in body &&
        typeof body.failureCode === "string"
          ? body.failureCode
          : "MALFORMED_DLQ_MESSAGE";
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: wagerDlqUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
      if (failureCode !== expectedFailureCode) {
        observedFailureCodes.push(failureCode);
        return false;
      }
      matchingMessage = body as Record<string, unknown>;
      return true;
    },
    timeoutMilliseconds,
    `DLQ message with ${expectedFailureCode}; observed ${observedFailureCodes.join(", ") || "none"}`,
  );
  if (!matchingMessage) {
    throw new Error(`DLQ message with ${expectedFailureCode} was not received.`);
  }
  return matchingMessage;
}

async function isQueueEmpty(queueUrl: string): Promise<boolean> {
  const response = await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
      ],
    }),
  );
  return (
    Number(response.Attributes?.ApproximateNumberOfMessages ?? 0) === 0 &&
    Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) === 0
  );
}

async function expectPostgresError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

async function expectAllWalletsConsistent(): Promise<void> {
  const { rows } = await pool.query(
    `select wallet."id",
            wallet."balance"::numeric(19, 2)::text as "stored_balance",
            coalesce(
              sum(case when ledger."direction" = 'CREDIT'
                       then ledger."amount" else -ledger."amount" end),
              0
            )::numeric(19, 2)::text as "ledger_balance"
     from "wallets" wallet
     left join "wallet_ledger_entries" ledger on ledger."wallet_id" = wallet."id"
     group by wallet."id"`,
  );
  for (const row of rows as Array<{
    id: string;
    stored_balance: string;
    ledger_balance: string;
  }>) {
    expect(row.stored_balance).toBe(row.ledger_balance);
  }
}

async function waitForMessage(queueUrl: string) {
  return waitForMessageWithTimeout(queueUrl, 15_000);
}

async function waitForMessageWithTimeout(
  queueUrl: string,
  timeoutMilliseconds: number,
) {
  let last: ReceiveMessageCommandOutput | undefined;
  return waitUntil(
    async () => {
      const result = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 60,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
      if (result.Messages?.length) {
        last = result;
        return true;
      }
      return false;
    },
    timeoutMilliseconds,
  ).then(() => {
    if (!last) {
      throw new Error("SQS message wait completed without a message.");
    }
    return last;
  });
}

async function drainQueue(queueUrl: string): Promise<void> {
  for (let count = 0; count < 10; count += 1) {
    const result = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    const messages = result.Messages ?? [];
    if (messages.length === 0) {
      return;
    }
    await Promise.all(
      messages.flatMap((message) =>
        message.ReceiptHandle
          ? [
              sqsClient.send(
                new DeleteMessageCommand({
                  QueueUrl: queueUrl,
                  ReceiptHandle: message.ReceiptHandle,
                }),
              ),
            ]
          : [],
      ),
    );
  }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds: number,
  description = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${description} after ${timeoutMilliseconds}ms.`,
  );
}

class FaultInjectingSubmitter extends SubmitWagerTransaction {
  private readonly attemptsByTransaction = new Map<string, number>();
  private readonly firstFailureAt = new Map<string, number>();
  private readonly retryAttemptAt = new Map<string, number>();
  private readonly results = new Map<string, string>();
  private readonly failures = new Map<string, unknown>();

  constructor(
    private readonly delegate: SubmitWagerTransaction,
    private readonly failurePlan: ReadonlyMap<string, number>,
  ) {
    super(new MikroOrmWageringStore(orm.em.fork()));
  }

  attemptsFor(externalTransactionId: string): number {
    return this.attemptsByTransaction.get(externalTransactionId) ?? 0;
  }

  resultStatus(externalTransactionId: string): string | undefined {
    return this.results.get(externalTransactionId);
  }

  failure(externalTransactionId: string): unknown {
    return this.failures.get(externalTransactionId);
  }

  retryDelayMilliseconds(externalTransactionId: string): number {
    const first = this.firstFailureAt.get(externalTransactionId);
    const retry = this.retryAttemptAt.get(externalTransactionId);
    if (first === undefined || retry === undefined) {
      return 0;
    }
    return retry - first;
  }

  override async execute(request: SubmitWagerRequest) {
    const externalTransactionId = request.externalTransactionId;
    const attempt = this.attemptsFor(externalTransactionId) + 1;
    this.attemptsByTransaction.set(externalTransactionId, attempt);
    const failuresBeforeSuccess =
      this.failurePlan.get(externalTransactionId) ?? 0;
    if (attempt <= failuresBeforeSuccess) {
      if (!this.firstFailureAt.has(externalTransactionId)) {
        this.firstFailureAt.set(externalTransactionId, Date.now());
      }
      throw new SubmitWagerError("Injected transient database interruption.", 503, "TRANSIENT_FAILURE");
    }
    if (attempt === failuresBeforeSuccess + 1) {
      this.retryAttemptAt.set(externalTransactionId, Date.now());
    }
    try {
      const result = await this.delegate.execute(request);
      this.results.set(externalTransactionId, result.status);
      return result;
    } catch (error) {
      this.failures.set(externalTransactionId, error);
      throw error;
    }
  }
}
