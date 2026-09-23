export type PreparedSupplyOrderCancellationStatus = "PREPARADA";

export type PrepareSupplyOrderCancellationInput = {
  commandId: string;
  supplyOrderId: string;
  reason: string;
  preparedAt?: Date;
};

export type PrepareSupplyOrderCancellationCommand = {
  commandId: string;
  supplyOrderId: string;
  reason: string;
  preparedAt: Date;
};

export type PrepareSupplyOrderCancellationFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_REASON"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "SUPPLY_ORDER_NOT_FOUND"
  | "SUPPLY_ORDER_NOT_CANCELABLE"
  | "CANCELLATION_ALREADY_EXISTS";

export type PrepareSupplyOrderCancellationResult =
  | {
      ok: true;
      cancellationId: string;
      status: PreparedSupplyOrderCancellationStatus;
    }
  | {
      ok: false;
      reason: PrepareSupplyOrderCancellationFailureReason;
    };

export type SupplyOrderCancellationPreparer = {
  prepare(
    input: PrepareSupplyOrderCancellationCommand
  ): Promise<PrepareSupplyOrderCancellationResult>;
};

export class PrepareSupplyOrderCancellation {
  constructor(private readonly preparer: SupplyOrderCancellationPreparer) {}

  async execute(
    input: PrepareSupplyOrderCancellationInput
  ): Promise<PrepareSupplyOrderCancellationResult> {
    const commandId = input.commandId.trim();
    const reason = input.reason.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (reason.length === 0) {
      return { ok: false, reason: "INVALID_REASON" };
    }

    return this.preparer.prepare({
      commandId,
      supplyOrderId: input.supplyOrderId,
      reason,
      preparedAt: input.preparedAt ?? new Date()
    });
  }
}
