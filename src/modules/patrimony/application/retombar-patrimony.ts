export type RetombarPatrimonyInput = {
  commandId: string;
  patrimonyId: string;
  retombedAt?: Date;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type RetombarPatrimonyCommand = {
  commandId: string;
  patrimonyId: string;
  retombedAt: Date;
  retombedAtWasProvided: boolean;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type RetombarPatrimonyFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_PATRIMONY_ID"
  | "INVALID_RETOMBED_AT"
  | "INVALID_REASON"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "ACTOR_NOT_AUTHORIZED"
  | "PATRIMONY_NOT_FOUND"
  | "PATRIMONY_NOT_TOMBABLE"
  | "ACTIVE_TOMBO_NOT_FOUND"
  | "PATRIMONIAL_GROUP_INVALID"
  | "RETOMBED_AT_BEFORE_ISSUED_AT";

export type RetombarPatrimonyResult =
  | {
      ok: true;
      patrimonyId: string;
      previousTombo: string;
      tombo: string;
      patrimonialGroupCode: string;
    }
  | {
      ok: false;
      reason: RetombarPatrimonyFailureReason;
      patrimonyId?: string;
    };

export type PatrimonyRetomber = {
  retombar(input: RetombarPatrimonyCommand): Promise<RetombarPatrimonyResult>;
};

export class RetombarPatrimony {
  constructor(private readonly retomber: PatrimonyRetomber) {}

  async execute(input: RetombarPatrimonyInput): Promise<RetombarPatrimonyResult> {
    const commandId = input.commandId.trim();
    const patrimonyId = input.patrimonyId.trim();
    const reason = input.reason.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (patrimonyId.length === 0) {
      return { ok: false, reason: "INVALID_PATRIMONY_ID" };
    }

    if (input.retombedAt !== undefined && Number.isNaN(input.retombedAt.getTime())) {
      return { ok: false, reason: "INVALID_RETOMBED_AT" };
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

    return this.retomber.retombar({
      commandId,
      patrimonyId,
      retombedAt: input.retombedAt ?? new Date(),
      retombedAtWasProvided: input.retombedAt !== undefined,
      reason,
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
