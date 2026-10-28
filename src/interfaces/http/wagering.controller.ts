import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { WagerTransactionKind, WagerTransactionStatus } from "../../domain/wager-transaction";
import {
  SubmitWagerError,
  SubmitWagerRequest,
  SubmitWagerTransaction,
} from "../../application/submit-wager-transaction";
import { WageringQueriesRepository } from "../../infrastructure/persistence/repositories/wagering-queries.repository";
import { AuthGuard } from "./auth.guard";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toSubmitRequest(
  body: unknown,
  idempotencyKey: string | undefined,
): SubmitWagerRequest {
  if (!idempotencyKey?.trim()) {
    throw new HttpException(
      { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key header is required." },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (!isRecord(body)) {
    throw new HttpException(
      { code: "INVALID_PAYLOAD", message: "A JSON object body is required." },
      HttpStatus.BAD_REQUEST,
    );
  }
  const { kind } = body;
  if (
    typeof body.providerId !== "string" ||
    typeof body.playerId !== "string" ||
    typeof body.walletId !== "string" ||
    typeof body.externalTransactionId !== "string" ||
    typeof kind !== "string" ||
    !Object.values(WagerTransactionKind).includes(kind as WagerTransactionKind) ||
    typeof body.amount !== "string" ||
    typeof body.currency !== "string" ||
    typeof body.roundId !== "string" ||
    (body.referenceExternalTransactionId !== undefined &&
      typeof body.referenceExternalTransactionId !== "string")
  ) {
    throw new HttpException(
      { code: "INVALID_PAYLOAD", message: "Invalid wagering transaction payload." },
      HttpStatus.BAD_REQUEST,
    );
  }
  return {
    providerId: body.providerId,
    playerId: body.playerId,
    walletId: body.walletId,
    externalTransactionId: body.externalTransactionId,
    idempotencyKey,
    kind: kind as WagerTransactionKind,
    amount: body.amount,
    currency: body.currency,
    roundId: body.roundId,
    referenceExternalTransactionId: body.referenceExternalTransactionId as string | undefined,
  };
}

function mapSubmitError(error: unknown): never {
  if (error instanceof SubmitWagerError) {
    throw new HttpException(
      { code: error.code, message: error.message },
      error.httpStatus,
    );
  }
  throw error;
}

@Controller("wagering")
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly submitWager: SubmitWagerTransaction,
    private readonly queries: WageringQueriesRepository,
  ) {}

  @Post("transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    try {
      const request = toSubmitRequest(body, idempotencyKey);
      const result = await this.submitWager.execute({ ...request, correlationId });
      response.status(
        result.status === WagerTransactionStatus.PENDING_REFERENCE
          ? HttpStatus.ACCEPTED
          : result.status === WagerTransactionStatus.REJECTED
            ? HttpStatus.UNPROCESSABLE_ENTITY
            : HttpStatus.OK,
      );
      return result;
    } catch (error) {
      return mapSubmitError(error);
    }
  }
  @Get("transactions/:transactionId")
  async transaction(@Param("transactionId") transactionId: string) {
    const result = await this.queries.findTransaction(transactionId);
    if (!result) {
      throw new HttpException({ code: "NOT_FOUND" }, HttpStatus.NOT_FOUND);
    }
    return result;
  }
}
