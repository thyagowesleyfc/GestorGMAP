export type EffectedSupplyOrderCancellationStatus = "EFETIVADA";

export type EffectSupplyOrderCancellationInput = {
  commandId: string;
  cancellationId: string;
  effectiveAt?: Date;
};

export type EffectSupplyOrderCancellationCommand = {
  commandId: string;
  cancellationId: string;
  effectiveAt: Date;
};

export type EffectSupplyOrderCancellationFailureReason =
  | "INVALID_COMMAND_ID"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "CANCELLATION_NOT_FOUND"
  | "CANCELLATION_NOT_AUTHORIZED"
  | "SUPPLY_ORDER_ALREADY_CANCELLED"
  | "SUPPLY_ORDER_HAS_NO_ITEMS"
  | "BALANCE_POSITION_NOT_FOUND";

export type EffectSupplyOrderCancellationResult =
  | {
      ok: true;
      cancellationId: string;
      supplyOrderId: string;
      status: EffectedSupplyOrderCancellationStatus;
    }
  | {
      ok: false;
      reason: EffectSupplyOrderCancellationFailureReason;
      contractItemId?: string;
    };

export type SupplyOrderCancellationEffecter = {
  effect(input: EffectSupplyOrderCancellationCommand): Promise<EffectSupplyOrderCancellationResult>;
};

export class EffectSupplyOrderCancellation {
  constructor(private readonly effecter: SupplyOrderCancellationEffecter) {}

  async execute(
    input: EffectSupplyOrderCancellationInput
  ): Promise<EffectSupplyOrderCancellationResult> {
    const commandId = input.commandId.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    return this.effecter.effect({
      commandId,
      cancellationId: input.cancellationId,
      effectiveAt: input.effectiveAt ?? new Date()
    });
  }
}
