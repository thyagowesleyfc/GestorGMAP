export type ReserveStockInput = {
  commandId: string;
  code: string;
  stockPositionId: string;
  quantity: number;
  reservedAt?: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type ReserveStockCommand = {
  commandId: string;
  code: string;
  stockPositionId: string;
  quantity: number;
  reservedAt: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type ReserveStockFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_RESERVATION_CODE"
  | "INVALID_QUANTITY"
  | "INVALID_SUMMARY"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "DUPLICATE_RESERVATION_CODE"
  | "STOCK_POSITION_NOT_FOUND"
  | "INSUFFICIENT_STOCK_AVAILABLE";

export type ReserveStockResult =
  | {
      ok: true;
      reservationId: string;
    }
  | {
      ok: false;
      reason: ReserveStockFailureReason;
      stockPositionId?: string;
    };

export type StockReserver = {
  reserve(input: ReserveStockCommand): Promise<ReserveStockResult>;
};

export class ReserveStock {
  constructor(private readonly reserver: StockReserver) {}

  async execute(input: ReserveStockInput): Promise<ReserveStockResult> {
    const commandId = input.commandId.trim();
    const code = input.code.trim();
    const summary = input.summary.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (code.length === 0 || code !== code.toUpperCase()) {
      return { ok: false, reason: "INVALID_RESERVATION_CODE" };
    }

    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      return { ok: false, reason: "INVALID_QUANTITY" };
    }

    if (summary.length === 0) {
      return { ok: false, reason: "INVALID_SUMMARY" };
    }

    return this.reserver.reserve({
      commandId,
      code,
      stockPositionId: input.stockPositionId,
      quantity: input.quantity,
      reservedAt: input.reservedAt ?? new Date(),
      summary,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
