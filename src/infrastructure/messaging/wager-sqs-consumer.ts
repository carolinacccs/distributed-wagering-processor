import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  SubmitWagerError,
  SubmitWagerRequest,
  SubmitWagerTransaction,
} from "../../application/submit-wager-transaction";
import { WagerTransactionKind } from "../../domain/wager-transaction";
import { logger } from "../observability/logger";
import { deadLetterCounter, retryCounter } from "../observability/metrics";
import { sqsClient, wagerDlqUrl, wagerQueueUrl } from "./sqs-client";

const CONSUMER_NAME = "wager-transactions-v1";
const MAX_RECEIVES = 5;

interface QueueWagerMessage extends Omit<SubmitWagerRequest,
  "idempotencyKey" | "messageId" | "consumerName" | "rawMessageBody" | "correlationId"> {
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export class WagerSqsConsumer {
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();
  private loopPromise?: Promise<void>;
  private receiveAbortController?: AbortController;

  constructor(private readonly submitWager: SubmitWagerTransaction) {}

  start(): void {
    if (!this.loopPromise) {
      this.loopPromise = this.poll();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.receiveAbortController?.abort();
    await this.loopPromise;
    await Promise.allSettled([...this.inFlight]);
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      const abortController = new AbortController();
      this.receiveAbortController = abortController;
      try {
        const response = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: wagerQueueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 10,
            VisibilityTimeout: 60,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
            MessageAttributeNames: ["All"],
          }),
          { abortSignal: abortController.signal },
        );
        const message = response.Messages?.[0];
        const receiptHandle = message?.ReceiptHandle;
        const messageId = message?.MessageId;
        const body = message?.Body;
        if (!message || !receiptHandle || !messageId || body === undefined) {
          continue;
        }
        const task = this.process({
          MessageId: messageId,
          ReceiptHandle: receiptHandle,
          Body: body,
          Attributes: message.Attributes,
        }).finally(() => this.inFlight.delete(task));
        this.inFlight.add(task);
        await task;
      } catch (error) {
        if (this.stopping) {
          return;
        }
        logger.error(
          {
            event: "sqs_receive_failed",
            component: "consumer",
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "SQS receive failed",
        );
        retryCounter.inc({ component: "sqs_receive" });
        await delay(1000);
      } finally {
        if (this.receiveAbortController === abortController) {
          this.receiveAbortController = undefined;
        }
      }
    }
  }

  private async process(message: {
    MessageId: string;
    ReceiptHandle: string;
    Body: string;
    Attributes?: Record<string, string>;
  }): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    let payload: QueueWagerMessage;
    try {
      const parsed: unknown = JSON.parse(message.Body);
      if (!isQueueWagerMessage(parsed)) {
        throw new TypeError("Invalid SQS wager payload.");
      }
      payload = parsed;
    } catch (error) {
      await this.moveToDlq(message, "INVALID_MESSAGE");
      logger.warn(
        { event: "sqs_message_dead_lettered", messageId: message.MessageId, failureCode: "INVALID_MESSAGE" },
        "Malformed wager message moved to DLQ",
      );
      return;
    }

    let result: Awaited<ReturnType<SubmitWagerTransaction["execute"]>>;
    try {
      result = await this.submitWager.execute({
        ...payload,
        messageId: message.MessageId,
        consumerName: CONSUMER_NAME,
        rawMessageBody: message.Body,
        correlationId: payload.correlationId ?? message.MessageId,
      });
    } catch (error) {
      if (error instanceof SubmitWagerError && error.httpStatus === 422) {
        await this.ackCommittedOrLog(message, payload, null, "business_rejection");
        return;
      }
      const transient = error instanceof SubmitWagerError && error.httpStatus === 503;
      if (!transient || receiveCount >= MAX_RECEIVES) {
        await this.moveToDlq(
          message,
          error instanceof SubmitWagerError ? error.code : "PERMANENT_FAILURE",
        );
        deadLetterCounter.inc({ component: "sqs_consumer" });
        logger.error(
          {
            event: "sqs_message_dead_lettered",
            correlationId: payload.correlationId ?? message.MessageId,
            messageId: message.MessageId,
            transactionId: null,
            walletId: payload.walletId,
            providerId: payload.providerId,
            failureCode: error instanceof SubmitWagerError ? error.code : "PERMANENT_FAILURE",
          },
          "Wager message moved to DLQ",
        );
        return;
      }
      const visibility = Math.min(900, 2 ** Math.max(0, receiveCount - 1));
      try {
        await sqsClient.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: wagerQueueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: visibility,
          }),
        );
        retryCounter.inc({ component: "sqs_consumer" });
        logger.warn(
          {
            event: "sqs_message_retry_scheduled",
            correlationId: payload.correlationId ?? message.MessageId,
            messageId: message.MessageId,
            transactionId: null,
            walletId: payload.walletId,
            providerId: payload.providerId,
            receiveCount,
            visibilitySeconds: visibility,
          },
          "Transient wager processing failure; message will retry",
        );
      } catch (visibilityError) {
        logger.error(
          {
            event: "sqs_visibility_update_failed",
            messageId: message.MessageId,
            errorName: visibilityError instanceof Error ? visibilityError.name : "UnknownError",
          },
          "Failed to update SQS message visibility; queue timeout will retry",
        );
      }
      return;
    }
    await this.ackCommittedOrLog(message, payload, result.id, result.status);
  }

  private async ackCommittedOrLog(
    message: { MessageId: string; ReceiptHandle: string },
    payload: QueueWagerMessage,
    transactionId: string | null,
    status: string,
  ): Promise<void> {
    try {
      await this.ack(message.ReceiptHandle);
      logger.info(
        {
          event: "sqs_message_acknowledged",
          correlationId: payload.correlationId ?? message.MessageId,
          messageId: message.MessageId,
          transactionId,
          walletId: payload.walletId,
          providerId: payload.providerId,
          status,
        },
        "Committed wager message acknowledged",
      );
    } catch (error) {
      logger.error(
        {
          event: "sqs_ack_failed_after_commit",
          correlationId: payload.correlationId ?? message.MessageId,
          messageId: message.MessageId,
          transactionId,
          walletId: payload.walletId,
          providerId: payload.providerId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Message committed but acknowledgement failed; redelivery is safe",
      );
    }
  }

  private async ack(receiptHandle: string): Promise<void> {
    await sqsClient.send(
      new DeleteMessageCommand({ QueueUrl: wagerQueueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  private async moveToDlq(
    message: { MessageId: string; ReceiptHandle: string; Body: string },
    failureCode: string,
  ): Promise<void> {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: wagerDlqUrl,
        MessageBody: JSON.stringify({
          originalMessageId: message.MessageId,
          failureCode,
          body: message.Body,
          deadLetteredAt: new Date().toISOString(),
        }),
        MessageGroupId: "dead-letter",
        MessageDeduplicationId: message.MessageId,
      }),
    );
    await this.ack(message.ReceiptHandle);
  }
}

function isQueueWagerMessage(value: unknown): value is QueueWagerMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.providerId === "string" &&
    typeof record.playerId === "string" &&
    typeof record.walletId === "string" &&
    typeof record.externalTransactionId === "string" &&
    typeof record.idempotencyKey === "string" &&
    typeof record.kind === "string" &&
    Object.values(WagerTransactionKind).includes(record.kind as WagerTransactionKind) &&
    typeof record.amount === "string" &&
    typeof record.currency === "string" &&
    typeof record.roundId === "string"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
