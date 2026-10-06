export type RegisterLogisticsShipmentItemInput = {
  stockPositionId: string;
  stockSeparationId: string;
  quantity: number;
};

export type RegisterLogisticsShipmentInput = {
  commandId: string;
  code: string;
  materialRequestId: string;
  items: RegisterLogisticsShipmentItemInput[];
  shippedAt?: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type RegisterLogisticsShipmentItemCommand = {
  stockPositionId: string;
  stockSeparationId: string;
  quantity: number;
};

export type RegisterLogisticsShipmentCommand = {
  commandId: string;
  code: string;
  materialRequestId: string;
  items: RegisterLogisticsShipmentItemCommand[];
  shippedAt: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type RegisteredLogisticsShipmentStatus = "REGISTRADA";

export type RegisterLogisticsShipmentFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_SHIPMENT_CODE"
  | "INVALID_ITEMS"
  | "INVALID_QUANTITY"
  | "INVALID_SUMMARY"
  | "DUPLICATE_SHIPMENT_ITEM"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "DUPLICATE_SHIPMENT_CODE"
  | "MATERIAL_REQUEST_NOT_FOUND"
  | "MATERIAL_REQUEST_NOT_DISPATCHED"
  | "STOCK_SEPARATION_NOT_FOUND"
  | "SHIPMENT_QUANTITY_EXCEEDS_SEPARATION";

export type RegisterLogisticsShipmentResult =
  | {
      ok: true;
      shipmentId: string;
      materialRequestId: string;
      status: RegisteredLogisticsShipmentStatus;
      itemCount: number;
    }
  | {
      ok: false;
      reason: RegisterLogisticsShipmentFailureReason;
      stockPositionId?: string;
      stockSeparationId?: string;
    };

export type LogisticsShipmentRegistrar = {
  register(input: RegisterLogisticsShipmentCommand): Promise<RegisterLogisticsShipmentResult>;
};

export class RegisterLogisticsShipment {
  constructor(private readonly registrar: LogisticsShipmentRegistrar) {}

  async execute(input: RegisterLogisticsShipmentInput): Promise<RegisterLogisticsShipmentResult> {
    const commandId = input.commandId.trim();
    const code = input.code.trim();
    const summary = input.summary.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (code.length === 0 || code !== code.toUpperCase()) {
      return { ok: false, reason: "INVALID_SHIPMENT_CODE" };
    }

    if (input.items.length === 0) {
      return { ok: false, reason: "INVALID_ITEMS" };
    }

    const normalizedItems = input.items.map((item) => ({
      stockPositionId: item.stockPositionId,
      stockSeparationId: item.stockSeparationId,
      quantity: item.quantity
    }));

    if (normalizedItems.some((item) => !Number.isInteger(item.quantity) || item.quantity <= 0)) {
      return { ok: false, reason: "INVALID_QUANTITY" };
    }

    const separationKeys = new Set<string>();
    for (const item of normalizedItems) {
      const key = `${item.stockSeparationId}:${item.stockPositionId}`;
      if (separationKeys.has(key)) {
        return { ok: false, reason: "DUPLICATE_SHIPMENT_ITEM" };
      }
      separationKeys.add(key);
    }

    if (summary.length === 0) {
      return { ok: false, reason: "INVALID_SUMMARY" };
    }

    return this.registrar.register({
      commandId,
      code,
      materialRequestId: input.materialRequestId,
      items: normalizedItems,
      shippedAt: input.shippedAt ?? new Date(),
      summary,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
