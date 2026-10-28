import { randomUUID } from "node:crypto";
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const header = request.header("x-correlation-id");
    const correlationId =
      header && /^[A-Za-z0-9._:-]{1,128}$/.test(header) ? header : randomUUID();
    request.headers["x-correlation-id"] = correlationId;
    response.setHeader("x-correlation-id", correlationId);
    next();
  }
}
