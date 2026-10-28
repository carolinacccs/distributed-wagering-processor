import { Money } from "./money";

export abstract class IntegrationEvent {
  protected constructor(
    public readonly eventId: string,
    public readonly occurredAt: string,
    public readonly transactionId: string,
    public readonly walletId: string,
    public readonly amount: Money,
  ) {
    if (!eventId.trim() || !transactionId.trim() || !walletId.trim() || !occurredAt.trim()) {
      throw new TypeError("Integration event identifiers and timestamp cannot be empty.");
    }
  }

  abstract readonly type: string;
}

export class BetPlacedEvent extends IntegrationEvent {
  readonly type = "BET_PLACED";

  private constructor(
    eventId: string,
    occurredAt: string,
    transactionId: string,
    walletId: string,
    amount: Money,
  ) {
    super(eventId, occurredAt, transactionId, walletId, amount);
  }

  static create(
    eventId: string,
    transactionId: string,
    walletId: string,
    amount: Money,
    occurredAt = new Date().toISOString(),
  ): BetPlacedEvent {
    return new BetPlacedEvent(eventId, occurredAt, transactionId, walletId, amount);
  }
}

export class WagerWonEvent extends IntegrationEvent {
  readonly type = "WAGER_WON";

  private constructor(
    eventId: string,
    occurredAt: string,
    transactionId: string,
    walletId: string,
    amount: Money,
  ) {
    super(eventId, occurredAt, transactionId, walletId, amount);
  }

  static create(
    eventId: string,
    transactionId: string,
    walletId: string,
    amount: Money,
    occurredAt = new Date().toISOString(),
  ): WagerWonEvent {
    return new WagerWonEvent(eventId, occurredAt, transactionId, walletId, amount);
  }
}

export class WagerRefundedEvent extends IntegrationEvent {
  readonly type = "WAGER_REFUNDED";

  private constructor(
    eventId: string,
    occurredAt: string,
    transactionId: string,
    walletId: string,
    amount: Money,
  ) {
    super(eventId, occurredAt, transactionId, walletId, amount);
  }

  static create(
    eventId: string,
    transactionId: string,
    walletId: string,
    amount: Money,
    occurredAt = new Date().toISOString(),
  ): WagerRefundedEvent {
    return new WagerRefundedEvent(eventId, occurredAt, transactionId, walletId, amount);
  }
}

export class WagerReversedEvent extends IntegrationEvent {
  readonly type = "WAGER_REVERSED";

  private constructor(
    eventId: string,
    occurredAt: string,
    transactionId: string,
    walletId: string,
    amount: Money,
  ) {
    super(eventId, occurredAt, transactionId, walletId, amount);
  }

  static create(
    eventId: string,
    transactionId: string,
    walletId: string,
    amount: Money,
    occurredAt = new Date().toISOString(),
  ): WagerReversedEvent {
    return new WagerReversedEvent(eventId, occurredAt, transactionId, walletId, amount);
  }
}

export class WagerTransactionRejectedEvent extends IntegrationEvent {
  readonly type = "WAGER_TRANSACTION_REJECTED";

  private constructor(
    eventId: string,
    occurredAt: string,
    transactionId: string,
    walletId: string,
    amount: Money,
    public readonly failureCode: string,
  ) {
    super(eventId, occurredAt, transactionId, walletId, amount);
  }

  static create(
    eventId: string,
    transactionId: string,
    walletId: string,
    amount: Money,
    failureCode: string,
    occurredAt = new Date().toISOString(),
  ): WagerTransactionRejectedEvent {
    return new WagerTransactionRejectedEvent(
      eventId,
      occurredAt,
      transactionId,
      walletId,
      amount,
      failureCode,
    );
  }
}
