import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Res,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import type { Response } from "express";
import { sqsClient, wagerQueueUrl } from "../../infrastructure/messaging/sqs-client";
import { logger } from "../../infrastructure/observability/logger";

@Controller("health")
export class HealthController {
  constructor(private readonly orm: MikroORM) {}

  @Get("live")
  live() {
    return { status: "live" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) response: Response) {
    const checks: Record<string, "ok" | "failed"> = {
      postgres: "failed",
      sqs: "failed",
    };
    try {
      await this.orm.em.getConnection().execute("select 1");
      checks.postgres = "ok";
    } catch {
      checks.postgres = "failed";
      logger.warn({ event: "readiness_check_failed", dependency: "postgres" }, "PostgreSQL readiness check failed");
    }
    try {
      await sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: wagerQueueUrl,
          AttributeNames: ["QueueArn"],
        }),
      );
      checks.sqs = "ok";
    } catch {
      checks.sqs = "failed";
      logger.warn({ event: "readiness_check_failed", dependency: "sqs" }, "SQS readiness check failed");
    }
    const ready = Object.values(checks).every((check) => check === "ok");
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    if (!ready) {
      throw new HttpException(
        { status: "not_ready", checks },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: "ready", checks };
  }
}
