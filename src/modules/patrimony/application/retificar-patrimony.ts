export type RetificarPatrimonyInput = {
  commandId: string;
  patrimonyId: string;
  correctedMaterialSingularId: string;
  correctedAt?: Date;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type RetificarPatrimonyCommand = {
  commandId: string;
  patrimonyId: string;
  correctedMaterialSingularId: string;
  correctedAt: Date;
  correctedAtWasProvided: boolean;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type RetificarPatrimonyFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_PATRIMONY_ID"
  | "INVALID_CORRECTED_MATERIAL_ID"
  | "INVALID_CORRECTED_AT"
  | "INVALID_REASON"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "ACTOR_NOT_AUTHORIZED"
  | "PATRIMONY_NOT_FOUND"
  | "MATERIAL_SINGULAR_NOT_FOUND"
  | "MATERIAL_SINGULAR_NOT_ACTIVE"
  | "NO_CHANGES"
  | "TOMBO_REQUIRED_FOR_TOMBABLE_MATERIAL"
  | "TOMBO_INCOMPATIBLE_WITH_MATERIAL"
  | "PATRIMONIAL_GROUP_MISMATCH";

export type RetificarPatrimonyResult =
  | {
      ok: true;
      patrimonyId: string;
      previousMaterialSingularId: string;
      materialSingularId: string;
      tombo: string | null;
    }
  | {
      ok: false;
      reason: RetificarPatrimonyFailureReason;
      patrimonyId?: string;
    };

export type PatrimonyRetifier = {
  retificar(input: RetificarPatrimonyCommand): Promise<RetificarPatrimonyResult>;
};

export class RetificarPatrimony {
  constructor(private readonly retifier: PatrimonyRetifier) {}

  async execute(input: RetificarPatrimonyInput): Promise<RetificarPatrimonyResult> {
    const commandId = input.commandId.trim();
    const patrimonyId = input.patrimonyId.trim();
    const correctedMaterialSingularId = input.correctedMaterialSingularId.trim();
    const reason = input.reason.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (patrimonyId.length === 0) {
      return { ok: false, reason: "INVALID_PATRIMONY_ID" };
    }

    if (correctedMaterialSingularId.length === 0) {
      return { ok: false, reason: "INVALID_CORRECTED_MATERIAL_ID" };
    }

    if (input.correctedAt !== undefined && Number.isNaN(input.correctedAt.getTime())) {
      return { ok: false, reason: "INVALID_CORRECTED_AT" };
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

    return this.retifier.retificar({
      commandId,
      patrimonyId,
      correctedMaterialSingularId,
      correctedAt: input.correctedAt ?? new Date(),
      correctedAtWasProvided: input.correctedAt !== undefined,
      reason,
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
