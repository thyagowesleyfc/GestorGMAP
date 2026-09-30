export type ReceivingEntryItemOriginType = "CONTRATUAL" | "INDENIZATORIO" | "PENDENTE";

export type RegularizeReceivingStockInput = {
  commandId: string;
  movementCode: string;
  receivingEntryItemId: string;
  originType: ReceivingEntryItemOriginType;
  regularizedAt?: Date;
  summary: string;
  contractId?: string;
  contractItemId?: string;
  supplyOrderId?: string;
  supplyOrderItemId?: string;
  regularizedByUserId?: string;
  notes?: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type RegularizeReceivingStockCommand = {
  commandId: string;
  movementCode: string;
  receivingEntryItemId: string;
  originType: ReceivingEntryItemOriginType;
  regularizedAt: Date;
  summary: string;
  contractId?: string;
  contractItemId?: string;
  supplyOrderId?: string;
  supplyOrderItemId?: string;
  regularizedByUserId?: string;
  notes?: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type RegularizeReceivingStockFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_MOVEMENT_CODE"
  | "INVALID_ORIGIN_TYPE"
  | "INVALID_SUMMARY"
  | "INVALID_NOTES"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "DUPLICATE_REGULARIZATION"
  | "DUPLICATE_MOVEMENT_CODE"
  | "RECEIVING_ENTRY_ITEM_NOT_FOUND";

export type RegularizeReceivingStockResult =
  | {
      ok: true;
      regularizationId: string;
      movementId: string;
      stockPositionId: string;
    }
  | {
      ok: false;
      reason: RegularizeReceivingStockFailureReason;
      receivingEntryItemId?: string;
    };

export type ReceivingStockRegularizer = {
  regularize(input: RegularizeReceivingStockCommand): Promise<RegularizeReceivingStockResult>;
};

const ORIGIN_TYPES: readonly ReceivingEntryItemOriginType[] = [
  "CONTRATUAL",
  "INDENIZATORIO",
  "PENDENTE"
];

export class RegularizeReceivingStock {
  constructor(private readonly regularizer: ReceivingStockRegularizer) {}

  async execute(input: RegularizeReceivingStockInput): Promise<RegularizeReceivingStockResult> {
    const commandId = input.commandId.trim();
    const movementCode = input.movementCode.trim();
    const summary = input.summary.trim();
    const notes = input.notes?.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (movementCode.length === 0 || movementCode !== movementCode.toUpperCase()) {
      return { ok: false, reason: "INVALID_MOVEMENT_CODE" };
    }

    if (!ORIGIN_TYPES.includes(input.originType)) {
      return { ok: false, reason: "INVALID_ORIGIN_TYPE" };
    }

    if (summary.length === 0) {
      return { ok: false, reason: "INVALID_SUMMARY" };
    }

    if (input.notes !== undefined && notes?.length === 0) {
      return { ok: false, reason: "INVALID_NOTES" };
    }

    return this.regularizer.regularize({
      commandId,
      movementCode,
      receivingEntryItemId: input.receivingEntryItemId,
      originType: input.originType,
      regularizedAt: input.regularizedAt ?? new Date(),
      summary,
      contractId: input.contractId,
      contractItemId: input.contractItemId,
      supplyOrderId: input.supplyOrderId,
      supplyOrderItemId: input.supplyOrderItemId,
      regularizedByUserId: input.regularizedByUserId,
      notes,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
