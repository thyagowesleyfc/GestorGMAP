export type RecolherPatrimonyInput = {
  commandId: string;
  patrimonyId: string;
  logisticsRecollectionId: string;
  occurredAt?: Date;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type RecolherPatrimonyCommand = {
  commandId: string;
  patrimonyId: string;
  logisticsRecollectionId: string;
  occurredAt: Date;
  occurredAtWasProvided: boolean;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type RecolherPatrimonyFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_PATRIMONY_ID"
  | "INVALID_LOGISTICS_RECOLLECTION_ID"
  | "INVALID_OCCURRED_AT"
  | "INVALID_REASON"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "ACTOR_NOT_AUTHORIZED"
  | "PATRIMONY_NOT_FOUND"
  | "LOGISTICS_RECOLLECTION_NOT_FOUND"
  | "LOGISTICS_RECOLLECTION_NOT_EXECUTED"
  | "RECOLLECTION_SOURCE_MISMATCH"
  | "RECOLLECTION_DATE_BEFORE_EXECUTION"
  | "DESTINATION_ENTITY_NOT_FOUND"
  | "DESTINATION_ENTITY_NOT_ACTIVE"
  | "SAME_RESPONSIBLE_ENTITY"
  | "PATRIMONY_RECOLLECTION_ALREADY_REGISTERED"
  | "PATRIMONY_COMPOSITION_MOVEMENT_NOT_SUPPORTED";

export type RecolherPatrimonyResult =
  | {
      ok: true;
      movementId: string;
      patrimonyId: string;
      recollectionId: string;
      fromEntityId: string;
      toEntityId: string;
    }
  | {
      ok: false;
      reason: RecolherPatrimonyFailureReason;
      patrimonyId?: string;
      recollectionId?: string;
    };

export type PatrimonyRecolhedor = {
  recolher(input: RecolherPatrimonyCommand): Promise<RecolherPatrimonyResult>;
};

export class RecolherPatrimony {
  constructor(private readonly recolhedor: PatrimonyRecolhedor) {}

  async execute(input: RecolherPatrimonyInput): Promise<RecolherPatrimonyResult> {
    const commandId = input.commandId.trim();
    const patrimonyId = input.patrimonyId.trim();
    const logisticsRecollectionId = input.logisticsRecollectionId.trim();
    const reason = input.reason.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (patrimonyId.length === 0) {
      return { ok: false, reason: "INVALID_PATRIMONY_ID" };
    }

    if (logisticsRecollectionId.length === 0) {
      return { ok: false, reason: "INVALID_LOGISTICS_RECOLLECTION_ID" };
    }

    if (input.occurredAt !== undefined && Number.isNaN(input.occurredAt.getTime())) {
      return { ok: false, reason: "INVALID_OCCURRED_AT" };
    }

    if (reason.length === 0) {
      return { ok: false, reason: "INVALID_REASON" };
    }

    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID" };
    }

    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT" };
    }

    return this.recolhedor.recolher({
      commandId,
      patrimonyId,
      logisticsRecollectionId,
      occurredAt: input.occurredAt ?? new Date(),
      occurredAtWasProvided: input.occurredAt !== undefined,
      reason,
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
