import { FailureCode } from "./failure-code";

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: FailureCode,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor() {
    super("Currencies do not match.", FailureCode.CURRENCY_MISMATCH);
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor(code: FailureCode = FailureCode.INSUFFICIENT_BALANCE) {
    super("Wallet balance is insufficient.", code);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(status: string) {
    super(
      `A transaction in state ${status} cannot be transitioned.`,
      FailureCode.INVALID_TRANSACTION_STATE,
    );
  }
}

export class ReferencedTransactionNotFoundError extends DomainError {
  constructor(referenceId: string) {
    super(
      `Referenced transaction ${referenceId} was not found.`,
      FailureCode.REFERENCED_TRANSACTION_NOT_FOUND,
    );
  }
}

export class InvalidReversalReferenceError extends DomainError {
  constructor() {
    super(
      "A reversal must reference a BET, WIN, or REFUND transaction.",
      FailureCode.INVALID_REVERSAL_REFERENCE,
    );
  }
}

export class IdempotencyKeyPayloadMismatchError extends DomainError {
  constructor() {
    super(
      "The idempotency key was already used with a different payload.",
      FailureCode.IDEMPOTENCY_KEY_PAYLOAD_MISMATCH,
    );
  }
}
