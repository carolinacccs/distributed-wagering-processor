export interface MessagePayload {
  readonly id: string;
  readonly messageId: string;
  readonly body: string;
  readonly createdAt: string;
}

function assertMessageValues(
  id: string,
  messageId: string,
  body: string,
  timestamp: string,
): void {
  if (!id.trim() || !messageId.trim() || !timestamp.trim()) {
    throw new TypeError("Message identifiers and timestamp cannot be empty.");
  }
  if (typeof body !== "string") {
    throw new TypeError("Message body must be a string.");
  }
}

export class InboxMessage {
  private constructor(
    public readonly id: string,
    public readonly messageId: string,
    public readonly body: string,
    public readonly receivedAt: string,
  ) {}

  static create(id: string, messageId: string, body: string, receivedAt: string): InboxMessage {
    assertMessageValues(id, messageId, body, receivedAt);
    return new InboxMessage(id, messageId, body, receivedAt);
  }

  static from(payload: MessagePayload): InboxMessage {
    return InboxMessage.create(payload.id, payload.messageId, payload.body, payload.createdAt);
  }
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly messageId: string,
    public readonly body: string,
    public readonly createdAt: string,
  ) {}

  static create(id: string, messageId: string, body: string, createdAt: string): OutboxMessage {
    assertMessageValues(id, messageId, body, createdAt);
    return new OutboxMessage(id, messageId, body, createdAt);
  }

  static rehydrate(payload: MessagePayload): OutboxMessage {
    return OutboxMessage.create(payload.id, payload.messageId, payload.body, payload.createdAt);
  }
}
