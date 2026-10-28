import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { WageringQueriesRepository } from "../../infrastructure/persistence/repositories/wagering-queries.repository";
import { AuthGuard } from "./auth.guard";

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(private readonly queries: WageringQueriesRepository) {}

  @Post()
  async create(@Body() body: unknown) {
    if (
      body === null ||
      typeof body !== "object" ||
      typeof (body as Record<string, unknown>).playerId !== "string" ||
      typeof (body as Record<string, unknown>).currency !== "string" ||
      ((body as Record<string, unknown>).initialBalance !== undefined &&
        typeof (body as Record<string, unknown>).initialBalance !== "string")
    ) {
      throw new HttpException(
        {
          code: "INVALID_PAYLOAD",
          message: "playerId, currency, and an optional string initialBalance are required.",
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const request = body as {
      playerId: string;
      currency: string;
      initialBalance?: string;
    };
    try {
      return await this.queries.createWallet(
        request.playerId,
        request.currency,
        request.initialBalance,
      );
    } catch (error) {
      if (error instanceof TypeError) {
        throw new HttpException(
          { code: "INVALID_PAYLOAD", message: error.message },
          HttpStatus.BAD_REQUEST,
        );
      }
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new HttpException(
          { code: "WALLET_ALREADY_EXISTS" },
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") rawLimit: string | undefined,
  ) {
    const limit = parseLedgerLimit(rawLimit);
    const wallet = await this.queries.findWallet(walletId);
    if (!wallet) {
      throw new HttpException({ code: "NOT_FOUND" }, HttpStatus.NOT_FOUND);
    }
    try {
      return await this.queries.listWalletLedger(walletId, cursor, limit);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new HttpException(
          { code: "INVALID_QUERY", message: error.message },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw error;
    }
  }

  @Post(":walletId/reconciliation")
  async reconcile(@Param("walletId") walletId: string) {
    const result = await this.queries.reconcileWallet(walletId);
    if (!result) {
      throw new HttpException({ code: "NOT_FOUND" }, HttpStatus.NOT_FOUND);
    }
    return result;
  }

  @Get(":walletId")
  async find(@Param("walletId") walletId: string) {
    const wallet = await this.queries.findWallet(walletId);
    if (!wallet) {
      throw new HttpException({ code: "NOT_FOUND" }, HttpStatus.NOT_FOUND);
    }
    return wallet;
  }
}

function parseLedgerLimit(rawLimit: string | undefined): number {
  if (rawLimit === undefined) {
    return 50;
  }
  if (!/^[0-9]+$/.test(rawLimit)) {
    throw invalidLedgerQuery("Ledger limit must be an integer between 1 and 100.");
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw invalidLedgerQuery("Ledger limit must be an integer between 1 and 100.");
  }
  return limit;
}

function invalidLedgerQuery(message: string): HttpException {
  return new HttpException(
    { code: "INVALID_QUERY", message },
    HttpStatus.BAD_REQUEST,
  );
}
