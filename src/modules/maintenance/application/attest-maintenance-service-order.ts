export type AttestMaintenanceServiceOrderStatus = "ATESTADA";

export type AttestMaintenanceServiceOrderInput = {
  commandId: string;
  serviceOrderId: string;
  attestedAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type AttestMaintenanceServiceOrderCommand = {
  commandId: string;
  serviceOrderId: string;
  attestedAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type AttestMaintenanceServiceOrderFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_SERVICE_ORDER_ID"
  | "INVALID_ATTESTED_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "SERVICE_ORDER_NOT_FOUND"
  | "SERVICE_ORDER_NOT_ATTESTABLE"
  | "ACTOR_NOT_AUTHORIZED";

export type AttestMaintenanceServiceOrderResult =
  | {
      ok: true;
      serviceOrderId: string;
      status: AttestMaintenanceServiceOrderStatus;
    }
  | {
      ok: false;
      reason: AttestMaintenanceServiceOrderFailureReason;
      serviceOrderId?: string;
    };

export type MaintenanceServiceOrderAttester = {
  attest(input: AttestMaintenanceServiceOrderCommand): Promise<AttestMaintenanceServiceOrderResult>;
};

export class AttestMaintenanceServiceOrder {
  constructor(private readonly attester: MaintenanceServiceOrderAttester) {}

  async execute(
    input: AttestMaintenanceServiceOrderInput
  ): Promise<AttestMaintenanceServiceOrderResult> {
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
    if (input.attestedAt !== undefined && Number.isNaN(input.attestedAt.getTime())) {
      return { ok: false, reason: "INVALID_ATTESTED_AT", serviceOrderId };
    }
    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID", serviceOrderId };
    }
    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT", serviceOrderId };
    }

    return this.attester.attest({
      commandId,
      serviceOrderId,
      attestedAt: input.attestedAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
