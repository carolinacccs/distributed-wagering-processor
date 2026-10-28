import { SQSClient } from "@aws-sdk/client-sqs";

export const sqsClient = new SQSClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
});

const endpoint =
  process.env.SQS_ENDPOINT ?? "http://localhost:4566";
const localQueueUrl = (name: string) =>
  `${endpoint.replace(/\/$/, "")}/000000000000/${name}`;

export const wagerQueueUrl =
  process.env.WAGER_QUEUE_URL ??
  localQueueUrl("wager-transactions.fifo");
export const wagerDlqUrl =
  process.env.WAGER_DLQ_URL ??
  localQueueUrl("wager-transactions-dlq.fifo");
export const eventsQueueUrl =
  process.env.EVENTS_QUEUE_URL ??
  localQueueUrl("wager-events.fifo");
