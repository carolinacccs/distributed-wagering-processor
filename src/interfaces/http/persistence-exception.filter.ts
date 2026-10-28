import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
} from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import type { Response } from "express";

function isTransientPersistenceError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const code = String(error.code);
  return (
    code.startsWith("08") ||
    code.startsWith("40") ||
    code === "53300" ||
    code === "57P01" ||
    code === "55P03" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE"
  );
}

@Catch()
export class PersistenceExceptionFilter
  extends BaseExceptionFilter
  implements ExceptionFilter
{
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (isTransientPersistenceError(exception)) {
      const response = host.switchToHttp().getResponse<Response>();
      response.status(503).json({
        code: "TRANSIENT_FAILURE",
        message: "Temporary persistence failure.",
      });
      return;
    }
    super.catch(exception, host);
  }
}
