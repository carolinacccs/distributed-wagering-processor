import { Controller, Get, HttpException, HttpStatus, Param, UseGuards } from "@nestjs/common";
import { WageringQueriesRepository } from "../../infrastructure/persistence/repositories/wagering-queries.repository";
import { AuthGuard } from "./auth.guard";

@Controller("providers")
@UseGuards(AuthGuard)
export class ProviderWageringController {
  constructor(private readonly queries: WageringQueriesRepository) {}

  @Get(":providerId/wagering/transactions/:externalTransactionId")
  async transaction(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const result = await this.queries.findProviderTransaction(providerId, externalTransactionId);
    if (!result) {
      throw new HttpException({ code: "NOT_FOUND" }, HttpStatus.NOT_FOUND);
    }
    return result;
  }
}
