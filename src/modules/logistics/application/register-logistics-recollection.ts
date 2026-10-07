export type LogisticsRecollectionStatus = "SOLICITADA";

export type RegisterLogisticsRecollectionInput = {
  commandId: string;
  code: string;
  requestingEntityId: string;
  receivingEntityId: string;
  requestedByUserId?: string;
  requestedAt?: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type RegisterLogisticsRecollectionCommand = {
  commandId: string;
  code: string;
  requestingEntityId: string;
  receivingEntityId: string;
  requestedByUserId?: string;
  requestedAt: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type RegisterLogisticsRecollectionFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_RECOLLECTION_CODE"
  | "INVALID_ENTITY"
  | "INVALID_SUMMARY"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "DUPLICATE_RECOLLECTION_CODE"
  | "ENTITY_NOT_FOUND"
  | "REQUESTED_BY_USER_NOT_FOUND";

export type RegisterLogisticsRecollectionResult =
  | {
      ok: true;
      recollectionId: string;
      requestingEntityId: string;
      receivingEntityId: string;
      status: LogisticsRecollectionStatus;
    }
  | {
      ok: false;
      reason: RegisterLogisticsRecollectionFailureReason;
      entityId?: string;
      requestedByUserId?: string;
    };

export type LogisticsRecollectionRegistrar = {
  register(
    input: RegisterLogisticsRecollectionCommand
  ): Promise<RegisterLogisticsRecollectionResult>;
};

export class RegisterLogisticsRecollection {
  constructor(private readonly registrar: LogisticsRecollectionRegistrar) {}

  async execute(
    input: RegisterLogisticsRecollectionInput
  ): Promise<RegisterLogisticsRecollectionResult> {
    const commandId = input.commandId.trim();
    const code = input.code.trim();
    const requestingEntityId = input.requestingEntityId.trim();
    const receivingEntityId = input.receivingEntityId.trim();
    const requestedByUserId = input.requestedByUserId?.trim();
    const summary = input.summary.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (code.length === 0 || code !== code.toUpperCase()) {
      return { ok: false, reason: "INVALID_RECOLLECTION_CODE" };
    }

    if (
      requestingEntityId.length === 0 ||
      receivingEntityId.length === 0 ||
      requestingEntityId === receivingEntityId
    ) {
      return { ok: false, reason: "INVALID_ENTITY" };
    }

    if (summary.length === 0) {
      return { ok: false, reason: "INVALID_SUMMARY" };
    }

    return this.registrar.register({
      commandId,
      code,
      requestingEntityId,
      receivingEntityId,
      requestedByUserId: requestedByUserId || undefined,
      requestedAt: input.requestedAt ?? new Date(),
      summary,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
