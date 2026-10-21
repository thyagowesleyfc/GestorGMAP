export type IncorporatePatrimonyFromDeliveryInput = {
  commandId: string;
  deliveryId: string;
  incorporatedAt?: Date;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type IncorporatePatrimonyFromDeliveryCommand = {
  commandId: string;
  deliveryId: string;
  incorporatedAt: Date;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type IncorporatePatrimonyFromDeliveryFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_DELIVERY_ID"
  | "INVALID_INCORPORATED_AT"
  | "INVALID_REASON"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "ACTOR_NOT_AUTHORIZED"
  | "DELIVERY_NOT_FOUND"
  | "DELIVERY_NOT_ACCEPTED"
  | "PARTIAL_ACCEPTANCE_NOT_SUPPORTED"
  | "SHIPMENT_WITHOUT_ITEMS"
  | "MATERIAL_CONFIGURATION_UNSUPPORTED"
  | "MATERIAL_NOT_RESOLVED"
  | "INVALID_SHIPMENT_ITEM_QUANTITY"
  | "MATERIAL_PATRIMONIAL_GROUP_INVALID"
  | "NO_TOMBABLE_ITEMS"
  | "PATRIMONY_ALREADY_INCORPORATED";

export type IncorporatePatrimonyFromDeliveryResult =
  | {
      ok: true;
      deliveryId: string;
      patrimonyIds: string[];
      tombos: string[];
    }
  | {
      ok: false;
      reason: IncorporatePatrimonyFromDeliveryFailureReason;
      deliveryId?: string;
      shipmentItemId?: string;
    };

export type PatrimonyIncorporator = {
  incorporate(
    input: IncorporatePatrimonyFromDeliveryCommand
  ): Promise<IncorporatePatrimonyFromDeliveryResult>;
};

export class IncorporatePatrimonyFromAcceptedDelivery {
  constructor(private readonly incorporator: PatrimonyIncorporator) {}

  async execute(
    input: IncorporatePatrimonyFromDeliveryInput
  ): Promise<IncorporatePatrimonyFromDeliveryResult> {
    const commandId = input.commandId.trim();
    const deliveryId = input.deliveryId.trim();
    const reason = input.reason.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (deliveryId.length === 0) {
      return { ok: false, reason: "INVALID_DELIVERY_ID" };
    }

    if (input.incorporatedAt !== undefined && Number.isNaN(input.incorporatedAt.getTime())) {
      return { ok: false, reason: "INVALID_INCORPORATED_AT" };
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

    return this.incorporator.incorporate({
      commandId,
      deliveryId,
      incorporatedAt: input.incorporatedAt ?? new Date(),
      reason,
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
