export type AuthorizedSupplyOrderCancellationStatus = "AUTORIZADA";

export type AuthorizeSupplyOrderCancellationInput = {
  commandId: string;
  cancellationId: string;
  authorizedAt?: Date;
};

export type AuthorizeSupplyOrderCancellationCommand = {
  commandId: string;
  cancellationId: string;
  authorizedAt: Date;
};

export type AuthorizeSupplyOrderCancellationFailureReason =
  | "INVALID_COMMAND_ID"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "CANCELLATION_NOT_FOUND"
  | "CANCELLATION_NOT_PREPARED";

export type AuthorizeSupplyOrderCancellationResult =
  | {
      ok: true;
      cancellationId: string;
      status: AuthorizedSupplyOrderCancellationStatus;
    }
  | {
      ok: false;
      reason: AuthorizeSupplyOrderCancellationFailureReason;
    };

export type SupplyOrderCancellationAuthorizer = {
  authorize(
    input: AuthorizeSupplyOrderCancellationCommand
  ): Promise<AuthorizeSupplyOrderCancellationResult>;
};

export class AuthorizeSupplyOrderCancellation {
  constructor(private readonly authorizer: SupplyOrderCancellationAuthorizer) {}

  async execute(
    input: AuthorizeSupplyOrderCancellationInput
  ): Promise<AuthorizeSupplyOrderCancellationResult> {
    const commandId = input.commandId.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    return this.authorizer.authorize({
      commandId,
      cancellationId: input.cancellationId,
      authorizedAt: input.authorizedAt ?? new Date()
    });
  }
}
