export type FinalizeMaterialRequestInput = {
  commandId: string;
  materialRequestId: string;
  finalizedAt?: Date;
  reason: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type FinalizeMaterialRequestCommand = {
  commandId: string;
  materialRequestId: string;
  finalizedAt: Date;
  reason: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type FinalizedMaterialRequestStatus = "FINALIZADA";

export type FinalizeMaterialRequestFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_MATERIAL_REQUEST_ID"
  | "INVALID_FINALIZED_AT"
  | "INVALID_REASON"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "MATERIAL_REQUEST_NOT_FOUND"
  | "MATERIAL_REQUEST_NOT_DISPATCHED"
  | "MATERIAL_REQUEST_NOT_SHIPPED"
  | "SHIPMENT_NOT_DELIVERED"
  | "PATRIMONIAL_EFFECTS_PENDING";

export type FinalizeMaterialRequestResult =
  | {
      ok: true;
      materialRequestId: string;
      status: FinalizedMaterialRequestStatus;
    }
  | {
      ok: false;
      reason: FinalizeMaterialRequestFailureReason;
      shipmentId?: string;
    };

export type MaterialRequestFinalizer = {
  finalize(input: FinalizeMaterialRequestCommand): Promise<FinalizeMaterialRequestResult>;
};

export class FinalizeMaterialRequest {
  constructor(private readonly finalizer: MaterialRequestFinalizer) {}

  async execute(input: FinalizeMaterialRequestInput): Promise<FinalizeMaterialRequestResult> {
    const commandId = input.commandId.trim();
    const materialRequestId = input.materialRequestId.trim();
    const reason = input.reason.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (materialRequestId.length === 0) {
      return { ok: false, reason: "INVALID_MATERIAL_REQUEST_ID" };
    }

    if (input.finalizedAt !== undefined && Number.isNaN(input.finalizedAt.getTime())) {
      return { ok: false, reason: "INVALID_FINALIZED_AT" };
    }

    if (reason.length === 0) {
      return { ok: false, reason: "INVALID_REASON" };
    }

    return this.finalizer.finalize({
      commandId,
      materialRequestId,
      finalizedAt: input.finalizedAt ?? new Date(),
      reason,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
