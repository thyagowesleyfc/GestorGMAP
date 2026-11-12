export type GlosaMaintenanceServiceOrderStatus =
  "CONCLUIDA_COM_GLOSA_PARCIAL" | "CONCLUIDA_COM_GLOSA_TOTAL";

export type GlosaMaintenanceServiceOrderLineInput = {
  serviceOrderServiceId: string;
  quantity: number;
};

export type GlosaMaintenanceServiceOrderInput = {
  commandId: string;
  serviceOrderId: string;
  lines: GlosaMaintenanceServiceOrderLineInput[];
  glosaAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type GlosaMaintenanceServiceOrderCommand = {
  commandId: string;
  serviceOrderId: string;
  lines: Array<GlosaMaintenanceServiceOrderLineInput>;
  glosaAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type GlosaMaintenanceServiceOrderFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_SERVICE_ORDER_ID"
  | "EMPTY_GLOSA_LINES"
  | "INVALID_SERVICE_ORDER_LINE_ID"
  | "DUPLICATE_SERVICE_ORDER_LINE"
  | "INVALID_GLOSA_QUANTITY"
  | "INVALID_GLOSA_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "SERVICE_ORDER_NOT_FOUND"
  | "SERVICE_ORDER_NOT_GLOSSABLE"
  | "SERVICE_ORDER_WITHOUT_PATRIMONY_TARGET"
  | "SERVICE_ORDER_LINE_NOT_FOUND"
  | "SERVICE_ORDER_LINE_ALREADY_GLOSSED"
  | "GLOSA_QUANTITY_EXCEEDS_COMMITTED"
  | "CONTRACT_ITEM_BALANCE_NOT_FOUND"
  | "CONTRACT_ITEM_CONTRACT_MISMATCH"
  | "INSUFFICIENT_COMMITTED_CONTRACT_BALANCE"
  | "ACTOR_NOT_AUTHORIZED";

export type GlosaMaintenanceServiceOrderResult =
  | {
      ok: true;
      serviceOrderId: string;
      status: GlosaMaintenanceServiceOrderStatus;
      totalGlosaAmount: string;
    }
  | {
      ok: false;
      reason: GlosaMaintenanceServiceOrderFailureReason;
      serviceOrderId?: string;
      serviceOrderServiceId?: string;
    };

export type MaintenanceServiceOrderGlosser = {
  glosa(input: GlosaMaintenanceServiceOrderCommand): Promise<GlosaMaintenanceServiceOrderResult>;
};

export class GlosaMaintenanceServiceOrder {
  constructor(private readonly glosser: MaintenanceServiceOrderGlosser) {}

  async execute(
    input: GlosaMaintenanceServiceOrderInput
  ): Promise<GlosaMaintenanceServiceOrderResult> {
    const commandId = input.commandId.trim();
    const serviceOrderId = input.serviceOrderId.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }
    if (serviceOrderId.length === 0) {
      return { ok: false, reason: "INVALID_SERVICE_ORDER_ID" };
    }
    if (input.lines.length === 0) {
      return { ok: false, reason: "EMPTY_GLOSA_LINES", serviceOrderId };
    }

    const lines = input.lines.map((line) => ({
      serviceOrderServiceId: line.serviceOrderServiceId.trim(),
      quantity: line.quantity
    }));
    if (lines.some((line) => line.serviceOrderServiceId.length === 0)) {
      return { ok: false, reason: "INVALID_SERVICE_ORDER_LINE_ID", serviceOrderId };
    }
    if (new Set(lines.map((line) => line.serviceOrderServiceId)).size !== lines.length) {
      return { ok: false, reason: "DUPLICATE_SERVICE_ORDER_LINE", serviceOrderId };
    }
    if (lines.some((line) => !Number.isInteger(line.quantity) || line.quantity <= 0)) {
      return { ok: false, reason: "INVALID_GLOSA_QUANTITY", serviceOrderId };
    }
    if (input.glosaAt !== undefined && Number.isNaN(input.glosaAt.getTime())) {
      return { ok: false, reason: "INVALID_GLOSA_AT", serviceOrderId };
    }
    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID", serviceOrderId };
    }
    if (teamContext !== "Patrimônio") {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT", serviceOrderId };
    }

    return this.glosser.glosa({
      commandId,
      serviceOrderId,
      lines,
      glosaAt: input.glosaAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
