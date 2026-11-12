export type RecordMaintenanceServiceOrderExecutionStatus = "EXECUTADA";

export type RecordMaintenanceServiceOrderExecutionInput = {
  commandId: string;
  serviceOrderId: string;
  executedAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type RecordMaintenanceServiceOrderExecutionCommand = {
  commandId: string;
  serviceOrderId: string;
  executedAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type RecordMaintenanceServiceOrderExecutionFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_SERVICE_ORDER_ID"
  | "INVALID_EXECUTED_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "SERVICE_ORDER_NOT_FOUND"
  | "SERVICE_ORDER_NOT_EXECUTABLE"
  | "ACTOR_NOT_AUTHORIZED";

export type RecordMaintenanceServiceOrderExecutionResult =
  | {
      ok: true;
      serviceOrderId: string;
      status: RecordMaintenanceServiceOrderExecutionStatus;
    }
  | {
      ok: false;
      reason: RecordMaintenanceServiceOrderExecutionFailureReason;
      serviceOrderId?: string;
    };

export type MaintenanceServiceOrderExecutionRecorder = {
  record(
    input: RecordMaintenanceServiceOrderExecutionCommand
  ): Promise<RecordMaintenanceServiceOrderExecutionResult>;
};

export class RecordMaintenanceServiceOrderExecution {
  constructor(private readonly recorder: MaintenanceServiceOrderExecutionRecorder) {}

  async execute(
    input: RecordMaintenanceServiceOrderExecutionInput
  ): Promise<RecordMaintenanceServiceOrderExecutionResult> {
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
    if (input.executedAt !== undefined && Number.isNaN(input.executedAt.getTime())) {
      return { ok: false, reason: "INVALID_EXECUTED_AT", serviceOrderId };
    }
    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID", serviceOrderId };
    }
    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT", serviceOrderId };
    }

    return this.recorder.record({
      commandId,
      serviceOrderId,
      executedAt: input.executedAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
