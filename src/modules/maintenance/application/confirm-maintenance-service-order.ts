export type ConfirmMaintenanceServiceOrderStatus = "EXECUTADA";

export type ConfirmMaintenanceServiceOrderInput = {
  commandId: string;
  serviceOrderId: string;
  evidenceReference: string;
  confirmedAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type ConfirmMaintenanceServiceOrderCommand = {
  commandId: string;
  serviceOrderId: string;
  evidenceReference: string;
  confirmedAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type ConfirmMaintenanceServiceOrderFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_SERVICE_ORDER_ID"
  | "INVALID_EVIDENCE_REFERENCE"
  | "INVALID_CONFIRMED_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "SERVICE_ORDER_NOT_FOUND"
  | "SERVICE_ORDER_NOT_CONFIRMABLE"
  | "SERVICE_ORDER_ALREADY_CONFIRMED"
  | "ACTOR_NOT_AUTHORIZED";

export type ConfirmMaintenanceServiceOrderResult =
  | {
      ok: true;
      serviceOrderId: string;
      confirmationId: string;
      status: ConfirmMaintenanceServiceOrderStatus;
    }
  | {
      ok: false;
      reason: ConfirmMaintenanceServiceOrderFailureReason;
      serviceOrderId?: string;
    };

export type MaintenanceServiceOrderConfirmer = {
  confirm(
    input: ConfirmMaintenanceServiceOrderCommand
  ): Promise<ConfirmMaintenanceServiceOrderResult>;
};

export class ConfirmMaintenanceServiceOrder {
  constructor(private readonly confirmer: MaintenanceServiceOrderConfirmer) {}

  async execute(
    input: ConfirmMaintenanceServiceOrderInput
  ): Promise<ConfirmMaintenanceServiceOrderResult> {
    const commandId = input.commandId.trim();
    const serviceOrderId = input.serviceOrderId.trim();
    const evidenceReference = input.evidenceReference.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }
    if (serviceOrderId.length === 0) {
      return { ok: false, reason: "INVALID_SERVICE_ORDER_ID" };
    }
    if (evidenceReference.length === 0 || evidenceReference.length > 500) {
      return { ok: false, reason: "INVALID_EVIDENCE_REFERENCE", serviceOrderId };
    }
    if (input.confirmedAt !== undefined && Number.isNaN(input.confirmedAt.getTime())) {
      return { ok: false, reason: "INVALID_CONFIRMED_AT", serviceOrderId };
    }
    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID", serviceOrderId };
    }
    if (teamContext !== "Patrimônio") {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT", serviceOrderId };
    }

    return this.confirmer.confirm({
      commandId,
      serviceOrderId,
      evidenceReference,
      confirmedAt: input.confirmedAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
