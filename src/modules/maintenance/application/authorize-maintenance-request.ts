export type AuthorizeMaintenanceRequestInput = {
  commandId: string;
  maintenanceRequestId: string;
  authorizedAt?: Date;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type AuthorizeMaintenanceRequestCommand = {
  commandId: string;
  maintenanceRequestId: string;
  authorizedAt: Date;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type AuthorizedMaintenanceRequestStatus = "EM_ANALISE";

export type AuthorizeMaintenanceRequestFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_MAINTENANCE_REQUEST_ID"
  | "INVALID_REASON"
  | "INVALID_AUTHORIZED_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "MAINTENANCE_REQUEST_NOT_FOUND"
  | "MAINTENANCE_REQUEST_NOT_REGISTRADA"
  | "AUTHORIZATION_DATE_BEFORE_REQUEST"
  | "ACTOR_NOT_AUTHORIZED";

export type AuthorizeMaintenanceRequestResult =
  | {
      ok: true;
      maintenanceRequestId: string;
      status: AuthorizedMaintenanceRequestStatus;
    }
  | {
      ok: false;
      reason: AuthorizeMaintenanceRequestFailureReason;
      maintenanceRequestId?: string;
    };

export type MaintenanceRequestAuthorizer = {
  authorize(input: AuthorizeMaintenanceRequestCommand): Promise<AuthorizeMaintenanceRequestResult>;
};

export class AuthorizeMaintenanceRequest {
  constructor(private readonly authorizer: MaintenanceRequestAuthorizer) {}

  async execute(
    input: AuthorizeMaintenanceRequestInput
  ): Promise<AuthorizeMaintenanceRequestResult> {
    const commandId = input.commandId.trim();
    const maintenanceRequestId = input.maintenanceRequestId.trim();
    const reason = input.reason.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (maintenanceRequestId.length === 0) {
      return { ok: false, reason: "INVALID_MAINTENANCE_REQUEST_ID" };
    }

    if (reason.length === 0) {
      return { ok: false, reason: "INVALID_REASON" };
    }

    if (input.authorizedAt !== undefined && Number.isNaN(input.authorizedAt.getTime())) {
      return { ok: false, reason: "INVALID_AUTHORIZED_AT" };
    }

    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID" };
    }

    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT" };
    }

    return this.authorizer.authorize({
      commandId,
      maintenanceRequestId,
      authorizedAt: input.authorizedAt ?? new Date(),
      reason,
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
