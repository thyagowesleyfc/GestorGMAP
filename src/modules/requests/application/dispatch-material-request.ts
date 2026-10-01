export type DispatchMaterialRequestInput = {
  commandId: string;
  materialRequestId: string;
  dispatchedAt?: Date;
  reason: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type DispatchMaterialRequestCommand = {
  commandId: string;
  materialRequestId: string;
  dispatchedAt: Date;
  reason: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type DispatchedMaterialRequestStatus = "DESPACHADA";

export type DispatchMaterialRequestFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_REASON"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "MATERIAL_REQUEST_NOT_FOUND"
  | "MATERIAL_REQUEST_NOT_ANALYZED"
  | "AUTHORIZATION_SET_INCOMPLETE";

export type DispatchMaterialRequestResult =
  | {
      ok: true;
      materialRequestId: string;
      status: DispatchedMaterialRequestStatus;
    }
  | {
      ok: false;
      reason: DispatchMaterialRequestFailureReason;
    };

export type MaterialRequestDispatcher = {
  dispatch(input: DispatchMaterialRequestCommand): Promise<DispatchMaterialRequestResult>;
};

export class DispatchMaterialRequest {
  constructor(private readonly dispatcher: MaterialRequestDispatcher) {}

  async execute(input: DispatchMaterialRequestInput): Promise<DispatchMaterialRequestResult> {
    const commandId = input.commandId.trim();
    const reason = input.reason.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (reason.length === 0) {
      return { ok: false, reason: "INVALID_REASON" };
    }

    return this.dispatcher.dispatch({
      commandId,
      materialRequestId: input.materialRequestId,
      dispatchedAt: input.dispatchedAt ?? new Date(),
      reason,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
