export type PatrimonyWarrantyEvidenceType =
  | "LAUDO"
  | "DOCUMENTO_ASSISTENCIA"
  | "COMPROVANTE_ORDEM_FORNECEDOR"
  | "EMAIL_FORMAL"
  | "DOCUMENTO_SEI"
  | "OUTRO";

export type PatrimonyWarrantyEvidenceInput = {
  type: PatrimonyWarrantyEvidenceType;
  reference: string;
};

export type ReplacePatrimonyUnderWarrantyInput = {
  commandId: string;
  patrimonyId: string;
  maintenanceRequestId: string;
  replacementMaterialSingularId: string;
  warrantyReference: string;
  evidences: PatrimonyWarrantyEvidenceInput[];
  justification: string;
  serialNumber?: string;
  occurredAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type ReplacePatrimonyUnderWarrantyCommand = {
  commandId: string;
  patrimonyId: string;
  maintenanceRequestId: string;
  replacementMaterialSingularId: string;
  warrantyReference: string;
  evidences: PatrimonyWarrantyEvidenceInput[];
  justification: string;
  serialNumber?: string;
  occurredAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type ReplacePatrimonyUnderWarrantyFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_PATRIMONY_ID"
  | "INVALID_MAINTENANCE_REQUEST_ID"
  | "INVALID_REPLACEMENT_MATERIAL_ID"
  | "INVALID_WARRANTY_REFERENCE"
  | "INVALID_EVIDENCE"
  | "INVALID_JUSTIFICATION"
  | "INVALID_SERIAL_NUMBER"
  | "INVALID_OCCURRED_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "ACTOR_NOT_AUTHORIZED"
  | "MAINTENANCE_REQUEST_NOT_FOUND"
  | "MAINTENANCE_REQUEST_NOT_AUTHORIZED"
  | "MAINTENANCE_REQUEST_NOT_LINKED_TO_PATRIMONY"
  | "MAINTENANCE_STRATEGY_NOT_GARANTIA"
  | "PATRIMONY_NOT_FOUND"
  | "PATRIMONY_ALREADY_CLOSED"
  | "PATRIMONY_ALREADY_WRITTEN_OFF"
  | "REPLACEMENT_MATERIAL_NOT_FOUND"
  | "REPLACEMENT_MATERIAL_NOT_ACTIVE"
  | "REPLACEMENT_MATERIAL_GROUP_INVALID"
  | "PATRIMONY_WITHOUT_ACTIVE_TOMBO"
  | "PATRIMONY_ALREADY_REPLACED"
  | "OCCURRED_AT_BEFORE_TOMBO_ISSUANCE";

export type ReplacePatrimonyUnderWarrantyResult =
  | {
      ok: true;
      replacementId: string;
      previousPatrimonyId: string;
      replacementPatrimonyId: string;
      replacementTombo: string | null;
    }
  | {
      ok: false;
      reason: ReplacePatrimonyUnderWarrantyFailureReason;
      patrimonyId?: string;
      maintenanceRequestId?: string;
    };

export type PatrimonyWarrantyReplacer = {
  replace(
    input: ReplacePatrimonyUnderWarrantyCommand
  ): Promise<ReplacePatrimonyUnderWarrantyResult>;
};

const EVIDENCE_TYPES = new Set<PatrimonyWarrantyEvidenceType>([
  "LAUDO",
  "DOCUMENTO_ASSISTENCIA",
  "COMPROVANTE_ORDEM_FORNECEDOR",
  "EMAIL_FORMAL",
  "DOCUMENTO_SEI",
  "OUTRO"
]);

export class ReplacePatrimonyUnderWarranty {
  constructor(private readonly replacer: PatrimonyWarrantyReplacer) {}

  async execute(
    input: ReplacePatrimonyUnderWarrantyInput
  ): Promise<ReplacePatrimonyUnderWarrantyResult> {
    const commandId = input.commandId.trim();
    const patrimonyId = input.patrimonyId.trim();
    const maintenanceRequestId = input.maintenanceRequestId.trim();
    const replacementMaterialSingularId = input.replacementMaterialSingularId.trim();
    const warrantyReference = input.warrantyReference.trim();
    const justification = input.justification.trim();
    const serialNumber = input.serialNumber?.trim() || undefined;
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (patrimonyId.length === 0) {
      return { ok: false, reason: "INVALID_PATRIMONY_ID" };
    }

    if (maintenanceRequestId.length === 0) {
      return { ok: false, reason: "INVALID_MAINTENANCE_REQUEST_ID" };
    }

    if (replacementMaterialSingularId.length === 0) {
      return { ok: false, reason: "INVALID_REPLACEMENT_MATERIAL_ID" };
    }

    if (warrantyReference.length === 0 || warrantyReference.length > 500) {
      return { ok: false, reason: "INVALID_WARRANTY_REFERENCE" };
    }

    if (
      !Array.isArray(input.evidences) ||
      input.evidences.length === 0 ||
      input.evidences.some(
        (evidence) =>
          !EVIDENCE_TYPES.has(evidence.type) ||
          evidence.reference.trim().length === 0 ||
          evidence.reference.trim().length > 500
      )
    ) {
      return { ok: false, reason: "INVALID_EVIDENCE" };
    }

    if (justification.length === 0 || justification.length > 1000) {
      return { ok: false, reason: "INVALID_JUSTIFICATION" };
    }

    if (serialNumber !== undefined && serialNumber.length > 180) {
      return { ok: false, reason: "INVALID_SERIAL_NUMBER" };
    }

    if (input.occurredAt !== undefined && Number.isNaN(input.occurredAt.getTime())) {
      return { ok: false, reason: "INVALID_OCCURRED_AT" };
    }

    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID" };
    }

    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT" };
    }

    return this.replacer.replace({
      commandId,
      patrimonyId,
      maintenanceRequestId,
      replacementMaterialSingularId,
      warrantyReference,
      evidences: input.evidences.map((evidence) => ({
        type: evidence.type,
        reference: evidence.reference.trim()
      })),
      justification,
      serialNumber,
      occurredAt: input.occurredAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
