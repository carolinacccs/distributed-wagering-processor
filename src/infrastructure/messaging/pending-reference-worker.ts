import { SubmitWagerTransaction } from "../../application/submit-wager-transaction";
import { logger } from "../observability/logger";
import { retryCounter } from "../observability/metrics";

export class PendingReferenceWorker {
  private stopping = false;
  private loopPromise?: Promise<void>;

  constructor(private readonly submitWager: SubmitWagerTransaction) {}

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
        await this.submitWager.reconcilePendingReferences(100);
      } catch (error) {
        retryCounter.inc({ component: "pending_reference_worker" });
        logger.error(
          {
            event: "pending_reference_worker_failed",
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Pending-reference reconciliation failed",
        );
      }
      if (!this.stopping) {
        await delay(5000);
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
