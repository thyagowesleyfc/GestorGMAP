export type PatrimonyComponentEvidenceType =
  | "LAUDO"
  | "DOCUMENTO_ASSISTENCIA"
  | "COMPROVANTE_ORDEM_FORNECEDOR"
  | "EMAIL_FORMAL"
  | "DOCUMENTO_SEI"
  | "OUTRO";

export type PatrimonyComponentEvidenceInput = {
  type: PatrimonyComponentEvidenceType;
  reference: string;
};

export type ReplacePatrimonialComponentInput = {
  commandId: string;
  patrimonyId: string;
  maintenanceRequestId: string;
  compositionItemId: string;
  expectedRevision: number;
  replacementMaterialSingularId: string;
  replacementSerialNumber?: string;
  replacementTombo?: string;
  previousIdentification?: string;
  replacementIdentification?: string;
  serviceUnitReference?: string;
  supplierReference?: string;
  documentReference?: string;
  evidences?: PatrimonyComponentEvidenceInput[];
  justification: string;
  occurredAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type ReplacePatrimonialComponentCommand = {
  commandId: string;
  patrimonyId: string;
  maintenanceRequestId: string;
  compositionItemId: string;
  expectedRevision: number;
  replacementMaterialSingularId: string;
  replacementSerialNumber?: string;
  previousIdentification?: string;
  replacementIdentification?: string;
  serviceUnitReference?: string;
  supplierReference?: string;
  documentReference?: string;
  evidences: PatrimonyComponentEvidenceInput[];
  justification: string;
  occurredAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type ReplacePatrimonialComponentFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_PATRIMONY_ID"
  | "INVALID_MAINTENANCE_REQUEST_ID"
  | "INVALID_COMPOSITION_ITEM_ID"
  | "INVALID_EXPECTED_REVISION"
  | "INVALID_REPLACEMENT_MATERIAL_ID"
  | "INVALID_IDENTIFICATION"
  | "INVALID_SERIAL_NUMBER"
  | "REPLACEMENT_TOMBO_NOT_ALLOWED"
  | "INVALID_EVIDENCE"
  | "INVALID_JUSTIFICATION"
  | "INVALID_OCCURRED_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "ACTOR_NOT_AUTHORIZED"
  | "TEAM_CONTEXT_NOT_AUTHORIZED"
  | "MAINTENANCE_REQUEST_NOT_FOUND"
  | "MAINTENANCE_REQUEST_NOT_AUTHORIZED"
  | "MAINTENANCE_REQUEST_NOT_LINKED_TO_PATRIMONY"
  | "MAINTENANCE_STRATEGY_NOT_FOUND"
  | "MAINTENANCE_SERVICE_ORDER_REQUIRED"
  | "PATRIMONY_NOT_FOUND"
  | "PATRIMONY_CLOSED"
  | "PATRIMONY_WRITTEN_OFF"
  | "COMPOSITION_NOT_FOUND"
  | "COMPOSITION_VERSION_CONFLICT"
  | "COMPOSITION_ITEM_NOT_FOUND"
  | "COMPOSITION_ITEM_INCONSISTENT"
  | "COMPONENT_NOT_FOUND"
  | "COMPONENT_ALREADY_REMOVED"
  | "COMPONENT_MATERIAL_MISMATCH"
  | "COMPONENT_ENTITY_MISMATCH"
  | "COMPONENT_NOT_AVAILABLE"
  | "REPLACEMENT_MATERIAL_NOT_FOUND"
  | "REPLACEMENT_MATERIAL_NOT_ACTIVE"
  | "REPLACEMENT_MATERIAL_SAME_AS_PREVIOUS"
  | "REPLACEMENT_MATERIAL_ALREADY_PRESENT"
  | "REPLACEMENT_MATERIAL_CLASS_MISMATCH"
  | "REPLACEMENT_MATERIAL_GROUP_INVALID"
  | "TOMBABLE_COMPONENT_REQUIRES_PATRIMONY"
  | "NON_TOMBABLE_COMPONENT_HAS_PATRIMONY";

export type ReplacePatrimonialComponentResult =
  | {
      ok: true;
      replacementId: string;
      patrimonyId: string;
      previousCompositionId: string;
      replacementCompositionId: string;
      previousRevision: number;
      replacementRevision: number;
      previousComponentPatrimonyId: string | null;
      replacementComponentPatrimonyId: string | null;
      replacementTombo: string | null;
    }
  | {
      ok: false;
      reason: ReplacePatrimonialComponentFailureReason;
      patrimonyId?: string;
      maintenanceRequestId?: string;
      compositionItemId?: string;
    };

export type PatrimonialComponentReplacer = {
  replace(input: ReplacePatrimonialComponentCommand): Promise<ReplacePatrimonialComponentResult>;
};

const EVIDENCE_TYPES = new Set<PatrimonyComponentEvidenceType>([
  "LAUDO",
  "DOCUMENTO_ASSISTENCIA",
  "COMPROVANTE_ORDEM_FORNECEDOR",
  "EMAIL_FORMAL",
  "DOCUMENTO_SEI",
  "OUTRO"
]);

export class ReplacePatrimonialComponent {
  constructor(private readonly replacer: PatrimonialComponentReplacer) {}

  async execute(
    input: ReplacePatrimonialComponentInput
  ): Promise<ReplacePatrimonialComponentResult> {
    const commandId = input.commandId.trim();
    const patrimonyId = input.patrimonyId.trim();
    const maintenanceRequestId = input.maintenanceRequestId.trim();
    const compositionItemId = input.compositionItemId.trim();
    const replacementMaterialSingularId = input.replacementMaterialSingularId.trim();
    const replacementSerialNumber = normalizeOptional(input.replacementSerialNumber);
    const replacementTombo = normalizeOptional(input.replacementTombo);
    const previousIdentification = normalizeOptional(input.previousIdentification);
    const replacementIdentification = normalizeOptional(input.replacementIdentification);
    const serviceUnitReference = normalizeOptional(input.serviceUnitReference);
    const supplierReference = normalizeOptional(input.supplierReference);
    const documentReference = normalizeOptional(input.documentReference);
    const justification = input.justification.trim();
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

    if (compositionItemId.length === 0) {
      return { ok: false, reason: "INVALID_COMPOSITION_ITEM_ID" };
    }

    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return { ok: false, reason: "INVALID_EXPECTED_REVISION" };
    }

    if (replacementMaterialSingularId.length === 0) {
      return { ok: false, reason: "INVALID_REPLACEMENT_MATERIAL_ID" };
    }

    if (replacementSerialNumber !== undefined && replacementSerialNumber.length > 180) {
      return { ok: false, reason: "INVALID_SERIAL_NUMBER" };
    }

    if (replacementTombo !== undefined) {
      return { ok: false, reason: "REPLACEMENT_TOMBO_NOT_ALLOWED" };
    }

    if (
      (previousIdentification !== undefined && previousIdentification.length > 180) ||
      (replacementIdentification !== undefined && replacementIdentification.length > 180)
    ) {
      return { ok: false, reason: "INVALID_IDENTIFICATION" };
    }

    if (
      (serviceUnitReference !== undefined && serviceUnitReference.length > 180) ||
      (supplierReference !== undefined && supplierReference.length > 180) ||
      (documentReference !== undefined && documentReference.length > 500)
    ) {
      return { ok: false, reason: "INVALID_IDENTIFICATION" };
    }

    const evidences = input.evidences ?? [];
    if (
      !Array.isArray(evidences) ||
      evidences.some(
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
      compositionItemId,
      expectedRevision: input.expectedRevision,
      replacementMaterialSingularId,
      replacementSerialNumber,
      previousIdentification,
      replacementIdentification,
      serviceUnitReference,
      supplierReference,
      documentReference,
      evidences: evidences.map((evidence) => ({
        type: evidence.type,
        reference: evidence.reference.trim()
      })),
      justification,
      occurredAt: input.occurredAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
