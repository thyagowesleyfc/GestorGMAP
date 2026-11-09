export type BaixarPatrimonyInput = {
  commandId: string;
  patrimonyId: string;
  reason: string;
  occurredAt?: Date;
  justification: string;
  procedureOrReportReference?: string;
  authorizationReference?: string;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type PatrimonyWriteOffReason = "INSERVIBILIDADE" | "FURTO" | "PERDA";

export type BaixarPatrimonyCommand = {
  commandId: string;
  patrimonyId: string;
  reason: PatrimonyWriteOffReason;
  occurredAt: Date;
  occurredAtWasProvided: boolean;
  justification: string;
  procedureOrReportReference?: string;
  authorizationReference?: string;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type BaixarPatrimonyFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_PATRIMONY_ID"
  | "INVALID_REASON"
  | "INVALID_OCCURRED_AT"
  | "INVALID_JUSTIFICATION"
  | "INVALID_PROCEDURE_OR_REPORT_REFERENCE"
  | "INVALID_AUTHORIZATION_REFERENCE"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "ACTOR_NOT_AUTHORIZED"
  | "PATRIMONY_NOT_FOUND"
  | "PATRIMONY_ALREADY_WRITTEN_OFF"
  | "PATRIMONY_COMPOSITION_WRITE_OFF_NOT_SUPPORTED"
  | "TOMBO_NOT_ACTIVE"
  | "WRITEOFF_DATE_BEFORE_TOMBO_ISSUANCE";

export type BaixarPatrimonyResult =
  | {
      ok: true;
      writeOffId: string;
      patrimonyId: string;
      status: "BAIXADO";
      activeTomboRetired: boolean;
    }
  | {
      ok: false;
      reason: BaixarPatrimonyFailureReason;
      patrimonyId?: string;
    };

export type PatrimonyBaixador = {
  baixar(input: BaixarPatrimonyCommand): Promise<BaixarPatrimonyResult>;
};

const WRITE_OFF_REASONS = new Set<PatrimonyWriteOffReason>(["INSERVIBILIDADE", "FURTO", "PERDA"]);

export class BaixarPatrimony {
  constructor(private readonly baixador: PatrimonyBaixador) {}

  async execute(input: BaixarPatrimonyInput): Promise<BaixarPatrimonyResult> {
    const commandId = input.commandId.trim();
    const patrimonyId = input.patrimonyId.trim();
    const reason = input.reason.trim().toUpperCase();
    const justification = input.justification.trim();
    const procedureOrReportReference = input.procedureOrReportReference?.trim() || undefined;
    const authorizationReference = input.authorizationReference?.trim() || undefined;
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (patrimonyId.length === 0) {
      return { ok: false, reason: "INVALID_PATRIMONY_ID" };
    }

    if (!WRITE_OFF_REASONS.has(reason as PatrimonyWriteOffReason)) {
      return { ok: false, reason: "INVALID_REASON" };
    }

    if (input.occurredAt !== undefined && Number.isNaN(input.occurredAt.getTime())) {
      return { ok: false, reason: "INVALID_OCCURRED_AT" };
    }

    if (justification.length === 0) {
      return { ok: false, reason: "INVALID_JUSTIFICATION" };
    }

    if (justification.length > 500) {
      return { ok: false, reason: "INVALID_JUSTIFICATION" };
    }

    if (procedureOrReportReference !== undefined && procedureOrReportReference.length === 0) {
      return { ok: false, reason: "INVALID_PROCEDURE_OR_REPORT_REFERENCE" };
    }

    if (procedureOrReportReference !== undefined && procedureOrReportReference.length > 160) {
      return { ok: false, reason: "INVALID_PROCEDURE_OR_REPORT_REFERENCE" };
    }

    if (authorizationReference !== undefined && authorizationReference.length === 0) {
      return { ok: false, reason: "INVALID_AUTHORIZATION_REFERENCE" };
    }

    if (authorizationReference !== undefined && authorizationReference.length > 160) {
      return { ok: false, reason: "INVALID_AUTHORIZATION_REFERENCE" };
    }

    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID" };
    }

    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT" };
    }

    return this.baixador.baixar({
      commandId,
      patrimonyId,
      reason: reason as PatrimonyWriteOffReason,
      occurredAt: input.occurredAt ?? new Date(),
      occurredAtWasProvided: input.occurredAt !== undefined,
      justification,
      procedureOrReportReference,
      authorizationReference,
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
