export type SendMaintenanceServiceOrderStatus = "ENVIADA_AO_PRESTADOR";

export type SendMaintenanceServiceOrderInput = {
  commandId: string;
  serviceOrderId: string;
  sentAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type SendMaintenanceServiceOrderCommand = {
  commandId: string;
  serviceOrderId: string;
  sentAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type SendMaintenanceServiceOrderFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_SERVICE_ORDER_ID"
  | "INVALID_SENT_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "SERVICE_ORDER_NOT_FOUND"
  | "SERVICE_ORDER_NOT_SENDABLE"
  | "ACTOR_NOT_AUTHORIZED";

export type SendMaintenanceServiceOrderResult =
  | {
      ok: true;
      serviceOrderId: string;
      status: SendMaintenanceServiceOrderStatus;
    }
  | {
      ok: false;
      reason: SendMaintenanceServiceOrderFailureReason;
      serviceOrderId?: string;
    };

export type MaintenanceServiceOrderSender = {
  send(input: SendMaintenanceServiceOrderCommand): Promise<SendMaintenanceServiceOrderResult>;
};

export class SendMaintenanceServiceOrder {
  constructor(private readonly sender: MaintenanceServiceOrderSender) {}

  async execute(
    input: SendMaintenanceServiceOrderInput
  ): Promise<SendMaintenanceServiceOrderResult> {
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
    if (input.sentAt !== undefined && Number.isNaN(input.sentAt.getTime())) {
      return { ok: false, reason: "INVALID_SENT_AT", serviceOrderId };
    }
    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID", serviceOrderId };
    }
    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT", serviceOrderId };
    }

    return this.sender.send({
      commandId,
      serviceOrderId,
      sentAt: input.sentAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
