export type MaterialRequestAuthorizationDecisionInput = {
  itemId: string;
  authorizedQuantity: number;
};

export type AuthorizeMaterialRequestInput = {
  commandId: string;
  materialRequestId: string;
  authorizations: MaterialRequestAuthorizationDecisionInput[];
  analyzedAt?: Date;
  reason: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type MaterialRequestAuthorizationDecision = {
  itemId: string;
  authorizedQuantity: number;
};

export type AuthorizeMaterialRequestCommand = {
  commandId: string;
  materialRequestId: string;
  authorizations: MaterialRequestAuthorizationDecision[];
  analyzedAt: Date;
  reason: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type AuthorizedMaterialRequestStatus = "ANALISADA";

export type AuthorizeMaterialRequestFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_REASON"
  | "EMPTY_AUTHORIZATIONS"
  | "DUPLICATE_ITEM_AUTHORIZATION"
  | "INVALID_AUTHORIZED_QUANTITY"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "MATERIAL_REQUEST_NOT_FOUND"
  | "MATERIAL_REQUEST_NOT_IN_TRIAGEM"
  | "MATERIAL_REQUEST_ITEM_NOT_FOUND"
  | "AUTHORIZATION_SET_INCOMPLETE"
  | "AUTHORIZED_QUANTITY_EXCEEDS_REQUESTED";

export type AuthorizeMaterialRequestResult =
  | {
      ok: true;
      materialRequestId: string;
      status: AuthorizedMaterialRequestStatus;
    }
  | {
      ok: false;
      reason: AuthorizeMaterialRequestFailureReason;
      itemId?: string;
    };

export type MaterialRequestAuthorizer = {
  authorize(input: AuthorizeMaterialRequestCommand): Promise<AuthorizeMaterialRequestResult>;
};

export class AuthorizeMaterialRequest {
  constructor(private readonly authorizer: MaterialRequestAuthorizer) {}

  async execute(input: AuthorizeMaterialRequestInput): Promise<AuthorizeMaterialRequestResult> {
    const commandId = input.commandId.trim();
    const reason = input.reason.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (reason.length === 0) {
      return { ok: false, reason: "INVALID_REASON" };
    }

    if (input.authorizations.length === 0) {
      return { ok: false, reason: "EMPTY_AUTHORIZATIONS" };
    }

    const seenItemIds = new Set<string>();
    const authorizations: MaterialRequestAuthorizationDecision[] = [];

    for (const authorization of input.authorizations) {
      const itemId = authorization.itemId.trim();

      if (seenItemIds.has(itemId)) {
        return { ok: false, reason: "DUPLICATE_ITEM_AUTHORIZATION", itemId };
      }

      if (
        !Number.isInteger(authorization.authorizedQuantity) ||
        authorization.authorizedQuantity < 0
      ) {
        return { ok: false, reason: "INVALID_AUTHORIZED_QUANTITY", itemId };
      }

      seenItemIds.add(itemId);
      authorizations.push({ itemId, authorizedQuantity: authorization.authorizedQuantity });
    }

    return this.authorizer.authorize({
      commandId,
      materialRequestId: input.materialRequestId,
      authorizations,
      analyzedAt: input.analyzedAt ?? new Date(),
      reason,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
