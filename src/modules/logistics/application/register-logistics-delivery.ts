export type LogisticsDeliveryAcceptanceStatus = "TOTAL" | "PARCIAL" | "RECUSADO";

export type RegisterLogisticsDeliveryInput = {
  commandId: string;
  code: string;
  shipmentId: string;
  acceptanceStatus: LogisticsDeliveryAcceptanceStatus;
  deliveredAt?: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type RegisterLogisticsDeliveryCommand = {
  commandId: string;
  code: string;
  shipmentId: string;
  acceptanceStatus: LogisticsDeliveryAcceptanceStatus;
  deliveredAt: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type RegisterLogisticsDeliveryFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_DELIVERY_CODE"
  | "INVALID_ACCEPTANCE_STATUS"
  | "INVALID_SUMMARY"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "DUPLICATE_DELIVERY_CODE"
  | "SHIPMENT_NOT_FOUND"
  | "DELIVERY_ALREADY_REGISTERED";

export type RegisterLogisticsDeliveryResult =
  | {
      ok: true;
      deliveryId: string;
      shipmentId: string;
      acceptanceStatus: LogisticsDeliveryAcceptanceStatus;
    }
  | {
      ok: false;
      reason: RegisterLogisticsDeliveryFailureReason;
      shipmentId?: string;
    };

export type LogisticsDeliveryRegistrar = {
  register(input: RegisterLogisticsDeliveryCommand): Promise<RegisterLogisticsDeliveryResult>;
};

const ACCEPTANCE_STATUSES = new Set<LogisticsDeliveryAcceptanceStatus>([
  "TOTAL",
  "PARCIAL",
  "RECUSADO"
]);

export class RegisterLogisticsDelivery {
  constructor(private readonly registrar: LogisticsDeliveryRegistrar) {}

  async execute(input: RegisterLogisticsDeliveryInput): Promise<RegisterLogisticsDeliveryResult> {
    const commandId = input.commandId.trim();
    const code = input.code.trim();
    const summary = input.summary.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (code.length === 0 || code !== code.toUpperCase()) {
      return { ok: false, reason: "INVALID_DELIVERY_CODE" };
    }

    if (!ACCEPTANCE_STATUSES.has(input.acceptanceStatus)) {
      return { ok: false, reason: "INVALID_ACCEPTANCE_STATUS" };
    }

    if (summary.length === 0) {
      return { ok: false, reason: "INVALID_SUMMARY" };
    }

    return this.registrar.register({
      commandId,
      code,
      shipmentId: input.shipmentId,
      acceptanceStatus: input.acceptanceStatus,
      deliveredAt: input.deliveredAt ?? new Date(),
      summary,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
