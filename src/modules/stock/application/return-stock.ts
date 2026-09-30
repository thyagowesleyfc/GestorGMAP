export type ReturnStockInput = {
  commandId: string;
  code: string;
  stockPositionId: string;
  stockSeparationId: string;
  quantity: number;
  returnedAt?: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type ReturnStockCommand = {
  commandId: string;
  code: string;
  stockPositionId: string;
  stockSeparationId: string;
  quantity: number;
  returnedAt: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type ReturnStockFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_RETURN_CODE"
  | "INVALID_QUANTITY"
  | "INVALID_SUMMARY"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "DUPLICATE_RETURN_CODE"
  | "STOCK_POSITION_NOT_FOUND"
  | "STOCK_SEPARATION_NOT_FOUND"
  | "INSUFFICIENT_SEPARATING_STOCK";

export type ReturnStockResult =
  | {
      ok: true;
      returnId: string;
    }
  | {
      ok: false;
      reason: ReturnStockFailureReason;
      stockPositionId?: string;
      stockSeparationId?: string;
    };

export type StockReturner = {
  return(input: ReturnStockCommand): Promise<ReturnStockResult>;
};

export class ReturnStock {
  constructor(private readonly returner: StockReturner) {}

  async execute(input: ReturnStockInput): Promise<ReturnStockResult> {
    const commandId = input.commandId.trim();
    const code = input.code.trim();
    const summary = input.summary.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (code.length === 0 || code !== code.toUpperCase()) {
      return { ok: false, reason: "INVALID_RETURN_CODE" };
    }

    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      return { ok: false, reason: "INVALID_QUANTITY" };
    }

    if (summary.length === 0) {
      return { ok: false, reason: "INVALID_SUMMARY" };
    }

    return this.returner.return({
      commandId,
      code,
      stockPositionId: input.stockPositionId,
      stockSeparationId: input.stockSeparationId,
      quantity: input.quantity,
      returnedAt: input.returnedAt ?? new Date(),
      summary,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
