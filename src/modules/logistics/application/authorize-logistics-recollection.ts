export type AuthorizedLogisticsRecollectionStatus = "AUTORIZADA";

export type AuthorizeLogisticsRecollectionInput = {
  commandId: string;
  recollectionId: string;
  authorizedAt?: Date;
  reason: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type AuthorizeLogisticsRecollectionCommand = {
  commandId: string;
  recollectionId: string;
  authorizedAt: Date;
  reason: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type AuthorizeLogisticsRecollectionFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_RECOLLECTION_ID"
  | "INVALID_REASON"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "RECOLLECTION_NOT_FOUND"
  | "RECOLLECTION_NOT_REQUESTED"
  | "AUTHORIZATION_DATE_BEFORE_REQUEST";

export type AuthorizeLogisticsRecollectionResult =
  | {
      ok: true;
      recollectionId: string;
      status: AuthorizedLogisticsRecollectionStatus;
    }
  | {
      ok: false;
      reason: AuthorizeLogisticsRecollectionFailureReason;
      recollectionId?: string;
    };

export type LogisticsRecollectionAuthorizer = {
  authorize(
    input: AuthorizeLogisticsRecollectionCommand
  ): Promise<AuthorizeLogisticsRecollectionResult>;
};

export class AuthorizeLogisticsRecollection {
  constructor(private readonly authorizer: LogisticsRecollectionAuthorizer) {}

  async execute(
    input: AuthorizeLogisticsRecollectionInput
  ): Promise<AuthorizeLogisticsRecollectionResult> {
    const commandId = input.commandId.trim();
    const recollectionId = input.recollectionId.trim();
    const reason = input.reason.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (recollectionId.length === 0) {
      return { ok: false, reason: "INVALID_RECOLLECTION_ID" };
    }

    if (reason.length === 0) {
      return { ok: false, reason: "INVALID_REASON" };
    }

    return this.authorizer.authorize({
      commandId,
      recollectionId,
      authorizedAt: input.authorizedAt ?? new Date(),
      reason,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
