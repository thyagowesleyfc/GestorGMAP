export type SeparateStockInput = {
  commandId: string;
  code: string;
  stockPositionId: string;
  stockReservationId: string;
  quantity: number;
  separatedAt?: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type SeparateStockCommand = {
  commandId: string;
  code: string;
  stockPositionId: string;
  stockReservationId: string;
  quantity: number;
  separatedAt: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type SeparateStockFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_SEPARATION_CODE"
  | "INVALID_QUANTITY"
  | "INVALID_SUMMARY"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "DUPLICATE_SEPARATION_CODE"
  | "STOCK_POSITION_NOT_FOUND"
  | "STOCK_RESERVATION_NOT_FOUND"
  | "INSUFFICIENT_RESERVED_STOCK";

export type SeparateStockResult =
  | {
      ok: true;
      separationId: string;
    }
  | {
      ok: false;
      reason: SeparateStockFailureReason;
      stockPositionId?: string;
      stockReservationId?: string;
    };

export type StockSeparator = {
  separate(input: SeparateStockCommand): Promise<SeparateStockResult>;
};

export class SeparateStock {
  constructor(private readonly separator: StockSeparator) {}

  async execute(input: SeparateStockInput): Promise<SeparateStockResult> {
    const commandId = input.commandId.trim();
    const code = input.code.trim();
    const summary = input.summary.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (code.length === 0 || code !== code.toUpperCase()) {
      return { ok: false, reason: "INVALID_SEPARATION_CODE" };
    }

    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      return { ok: false, reason: "INVALID_QUANTITY" };
    }

    if (summary.length === 0) {
      return { ok: false, reason: "INVALID_SUMMARY" };
    }

    return this.separator.separate({
      commandId,
      code,
      stockPositionId: input.stockPositionId,
      stockReservationId: input.stockReservationId,
      quantity: input.quantity,
      separatedAt: input.separatedAt ?? new Date(),
      summary,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
