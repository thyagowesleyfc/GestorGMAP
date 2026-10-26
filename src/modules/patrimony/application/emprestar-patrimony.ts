export type EmprestarPatrimonyInput = {
  commandId: string;
  patrimonyId: string;
  destinationEntityId: string;
  occurredAt?: Date;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type EmprestarPatrimonyCommand = {
  commandId: string;
  patrimonyId: string;
  destinationEntityId: string;
  occurredAt: Date;
  occurredAtWasProvided: boolean;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type EmprestarPatrimonyFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_PATRIMONY_ID"
  | "INVALID_DESTINATION_ENTITY_ID"
  | "INVALID_OCCURRED_AT"
  | "INVALID_REASON"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "ACTOR_NOT_AUTHORIZED"
  | "PATRIMONY_NOT_FOUND"
  | "DESTINATION_ENTITY_NOT_FOUND"
  | "DESTINATION_ENTITY_NOT_ACTIVE"
  | "SAME_RESPONSIBLE_ENTITY"
  | "PATRIMONY_COMPOSITION_MOVEMENT_NOT_SUPPORTED";

export type EmprestarPatrimonyResult =
  | {
      ok: true;
      movementId: string;
      patrimonyId: string;
      fromEntityId: string;
      toEntityId: string;
    }
  | {
      ok: false;
      reason: EmprestarPatrimonyFailureReason;
      patrimonyId?: string;
    };

export type PatrimonyEmprestador = {
  emprestar(input: EmprestarPatrimonyCommand): Promise<EmprestarPatrimonyResult>;
};

export class EmprestarPatrimony {
  constructor(private readonly emprestador: PatrimonyEmprestador) {}

  async execute(input: EmprestarPatrimonyInput): Promise<EmprestarPatrimonyResult> {
    const commandId = input.commandId.trim();
    const patrimonyId = input.patrimonyId.trim();
    const destinationEntityId = input.destinationEntityId.trim();
    const reason = input.reason.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (patrimonyId.length === 0) {
      return { ok: false, reason: "INVALID_PATRIMONY_ID" };
    }

    if (destinationEntityId.length === 0) {
      return { ok: false, reason: "INVALID_DESTINATION_ENTITY_ID" };
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

    return this.emprestador.emprestar({
      commandId,
      patrimonyId,
      destinationEntityId,
      occurredAt: input.occurredAt ?? new Date(),
      occurredAtWasProvided: input.occurredAt !== undefined,
      reason,
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
