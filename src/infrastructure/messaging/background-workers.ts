import { Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { SubmitWagerTransaction } from "../../application/submit-wager-transaction";
import { OutboxPublisher } from "./outbox-publisher";
import { PendingReferenceWorker } from "./pending-reference-worker";
import { WagerSqsConsumer } from "./wager-sqs-consumer";

@Injectable()
export class BackgroundWorkers implements OnModuleInit, OnApplicationShutdown {
  private readonly consumer: WagerSqsConsumer;
  private readonly outbox: OutboxPublisher;
  private readonly pendingReferences: PendingReferenceWorker;

  constructor(
    entityManager: EntityManager,
    submitWager: SubmitWagerTransaction,
  ) {
    this.consumer = new WagerSqsConsumer(submitWager);
    this.outbox = new OutboxPublisher(entityManager);
    this.pendingReferences = new PendingReferenceWorker(submitWager);
  }

  onModuleInit(): void {
    if (process.env.BACKGROUND_WORKERS === "false") {
      return;
    }
    this.consumer.start();
    this.outbox.start();
    this.pendingReferences.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.consumer.stop(),
      this.outbox.stop(),
      this.pendingReferences.stop(),
    ]);
  }
}
