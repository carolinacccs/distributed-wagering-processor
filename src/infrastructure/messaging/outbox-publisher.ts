import { randomUUID } from "node:crypto";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { EntityManager } from "@mikro-orm/postgresql";
import { logger } from "../observability/logger";
import {
  operationLatency,
  outboxLagGauge,
  retryCounter,
} from "../observability/metrics";
import { eventsQueueUrl, sqsClient } from "./sqs-client";

interface OutboxRow {
  id: string;
  message_id: string;
  event_type: string;
  body: string;
  attempts: number;
}

export class OutboxPublisher {
  private stopping = false;
  private loopPromise?: Promise<void>;

  constructor(private readonly entityManager: EntityManager) {}

  start(): void {
    if (!this.loopPromise) {
      this.loopPromise = this.run();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loopPromise;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.publishBatch();
      } catch (error) {
        logger.error(
          {
            event: "outbox_publisher_failed",
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Outbox publisher iteration failed",
        );
        retryCounter.inc({ component: "outbox" });
      }
      if (!this.stopping) {
        await delay(500);
      }
    }
  }

  private async publishBatch(): Promise<void> {
    const leaseToken = randomUUID();
    const rows = await this.entityManager.transactional(async (em) => {
      const connection = em.getConnection();
      const context = em.getTransactionContext();
      const result = await connection.execute<OutboxRow[]>(
        `with candidates as (
           select "id"
           from "outbox_messages"
           where "published_at" is null
             and "next_attempt_at" <= now()
             and ("leased_until" is null or "leased_until" < now())
           order by "created_at", "id"
           for update skip locked
           limit 10
         )
         update "outbox_messages" as outbox
         set "lease_token" = ?,
             "leased_until" = now() + interval '60 seconds',
             "attempts" = outbox."attempts" + 1
         from candidates
         where outbox."id" = candidates."id"
         returning outbox."id", outbox."message_id", outbox."event_type",
                   outbox."body", outbox."attempts"`,
        [leaseToken],
        "all",
        context,
      );
      return result as OutboxRow[];
    });

    for (const row of rows) {
      const end = operationLatency.startTimer({ operation: "outbox_publish" });
      try {
        const body: unknown = JSON.parse(row.body);
        const groupId =
          body !== null &&
          typeof body === "object" &&
          "walletId" in body &&
          typeof body.walletId === "string"
            ? body.walletId
            : "wager-events";
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: eventsQueueUrl,
            MessageBody: row.body,
            MessageGroupId: groupId,
            MessageDeduplicationId: row.message_id,
            MessageAttributes: {
              eventType: { DataType: "String", StringValue: row.event_type },
            },
          }),
        );
        await this.entityManager.getConnection().execute(
          `update "outbox_messages"
           set "published_at" = now(), "lease_token" = null,
               "leased_until" = null, "last_error" = null
           where "id" = ? and "lease_token" = ?`,
          [row.id, leaseToken],
          "run",
        );
        logger.info(
          { event: "outbox_event_published", messageId: row.message_id },
          "Committed outbox event published",
        );
      } catch (error) {
        const delaySeconds = Math.min(900, 2 ** Math.min(row.attempts, 9));
        await this.entityManager.getConnection().execute(
          `update "outbox_messages"
           set "next_attempt_at" = now() + make_interval(secs => ?),
               "lease_token" = null, "leased_until" = null, "last_error" = ?
           where "id" = ? and "lease_token" = ?`,
          [
            delaySeconds,
            error instanceof Error ? error.name.slice(0, 100) : "UnknownError",
            row.id,
            leaseToken,
          ],
          "run",
        );
        retryCounter.inc({ component: "outbox" });
        logger.error(
          {
            event: "outbox_event_retry_scheduled",
            messageId: row.message_id,
            attempts: row.attempts,
            delaySeconds,
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorCode:
              error !== null && typeof error === "object" && "code" in error
                ? String(error.code)
                : undefined,
          },
          "Outbox event publication failed",
        );
      } finally {
        end();
      }
    }
    await this.updateLagGauge();
  }

  private async updateLagGauge(): Promise<void> {
    const rows = await this.entityManager.getConnection().execute<
      Array<{ lag_seconds: number | string | null }>
    >(
      `select extract(epoch from (now() - min("created_at"))) as "lag_seconds"
       from "outbox_messages" where "published_at" is null`,
      [],
      "all",
    ) as Array<{ lag_seconds: number | string | null }>;
    const lag = rows[0]?.lag_seconds;
    outboxLagGauge.set(lag === null || lag === undefined ? 0 : Number(lag));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
