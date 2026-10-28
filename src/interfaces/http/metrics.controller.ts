import { Controller, Get, Header, Res } from "@nestjs/common";
import type { Response } from "express";
import { metricsRegistry } from "../../infrastructure/observability/metrics";

@Controller()
export class MetricsController {
  @Get("metrics")
  @Header("content-type", metricsRegistry.contentType)
  async metrics(@Res() response: Response): Promise<void> {
    response.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
  }
}
