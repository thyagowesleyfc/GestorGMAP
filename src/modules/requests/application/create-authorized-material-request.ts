export type AuthorizedMaterialRequestReferenceSystem = "SEI" | "REDMINE";

export type CreateAuthorizedMaterialRequestItemInput = {
  materialSingularId?: string;
  materialConfigurationId?: string;
  requestedQuantity: number;
  authorizedQuantity: number;
};

export type CreateAuthorizedMaterialRequestReferenceInput = {
  system: AuthorizedMaterialRequestReferenceSystem;
  referenceType: string;
  identifier: string;
  url?: string;
};

export type CreateAuthorizedMaterialRequestInput = {
  commandId: string;
  code: string;
  requestingEntityId: string;
  items: CreateAuthorizedMaterialRequestItemInput[];
  references?: CreateAuthorizedMaterialRequestReferenceInput[];
  requestedAt?: Date;
  summary: string;
  reason: string;
  registeredByUserId?: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type CreateAuthorizedMaterialRequestItemCommand = {
  lineNumber: number;
  materialSingularId?: string;
  materialConfigurationId?: string;
  requestedQuantity: number;
  authorizedQuantity: number;
};

export type CreateAuthorizedMaterialRequestReferenceCommand = {
  system: AuthorizedMaterialRequestReferenceSystem;
  referenceType: string;
  identifier: string;
  url?: string;
};

export type CreateAuthorizedMaterialRequestCommand = {
  commandId: string;
  code: string;
  requestingEntityId: string;
  items: CreateAuthorizedMaterialRequestItemCommand[];
  references: CreateAuthorizedMaterialRequestReferenceCommand[];
  requestedAt: Date;
  summary: string;
  reason: string;
  registeredByUserId?: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type CreatedAuthorizedMaterialRequestStatus = "ANALISADA";

export type CreateAuthorizedMaterialRequestFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_REQUEST_CODE"
  | "INVALID_REQUESTING_ENTITY_ID"
  | "INVALID_REQUESTED_AT"
  | "INVALID_SUMMARY"
  | "INVALID_REASON"
  | "INVALID_ITEMS"
  | "INVALID_ITEM_CATALOG_REFERENCE"
  | "INVALID_REQUESTED_QUANTITY"
  | "INVALID_AUTHORIZED_QUANTITY"
  | "AUTHORIZED_QUANTITY_EXCEEDS_REQUESTED"
  | "INVALID_REFERENCE_SYSTEM"
  | "INVALID_REFERENCE_TYPE"
  | "INVALID_REFERENCE_IDENTIFIER"
  | "INVALID_REFERENCE_URL"
  | "DUPLICATE_REFERENCE"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "DUPLICATE_REQUEST_CODE"
  | "REQUESTING_ENTITY_NOT_FOUND"
  | "REGISTERED_BY_USER_NOT_FOUND"
  | "MATERIAL_NOT_FOUND";

export type CreateAuthorizedMaterialRequestResult =
  | {
      ok: true;
      materialRequestId: string;
      status: CreatedAuthorizedMaterialRequestStatus;
      itemCount: number;
      referenceCount: number;
    }
  | {
      ok: false;
      reason: CreateAuthorizedMaterialRequestFailureReason;
      itemLineNumber?: number;
      referenceIdentifier?: string;
    };

export type AuthorizedMaterialRequestCreator = {
  create(
    input: CreateAuthorizedMaterialRequestCommand
  ): Promise<CreateAuthorizedMaterialRequestResult>;
};

const REFERENCE_SYSTEMS = new Set<AuthorizedMaterialRequestReferenceSystem>(["SEI", "REDMINE"]);

export class CreateAuthorizedMaterialRequest {
  constructor(private readonly creator: AuthorizedMaterialRequestCreator) {}

  async execute(
    input: CreateAuthorizedMaterialRequestInput
  ): Promise<CreateAuthorizedMaterialRequestResult> {
    const commandId = input.commandId.trim();
    const code = input.code.trim();
    const requestingEntityId = input.requestingEntityId.trim();
    const summary = input.summary.trim();
    const reason = input.reason.trim();
    const registeredByUserId = normalizeOptionalString(input.registeredByUserId);
    const items = normalizeItems(input.items);
    const references = normalizeReferences(input.references ?? []);

    if (commandId.length === 0) return { ok: false, reason: "INVALID_COMMAND_ID" };
    if (code.length === 0 || code !== code.toUpperCase()) {
      return { ok: false, reason: "INVALID_REQUEST_CODE" };
    }
    if (requestingEntityId.length === 0)
      return { ok: false, reason: "INVALID_REQUESTING_ENTITY_ID" };
    if (input.requestedAt !== undefined && Number.isNaN(input.requestedAt.getTime())) {
      return { ok: false, reason: "INVALID_REQUESTED_AT" };
    }
    if (summary.length === 0) return { ok: false, reason: "INVALID_SUMMARY" };
    if (reason.length === 0) return { ok: false, reason: "INVALID_REASON" };
    if (items.length === 0) return { ok: false, reason: "INVALID_ITEMS" };

    const invalidItem = items.find((item) => item.result.ok === false);
    if (invalidItem !== undefined && invalidItem.result.ok === false) {
      return {
        ok: false,
        reason: invalidItem.result.reason,
        itemLineNumber: invalidItem.lineNumber
      };
    }

    const invalidReference = references.find((reference) => reference.result.ok === false);
    if (invalidReference !== undefined && invalidReference.result.ok === false) {
      return {
        ok: false,
        reason: invalidReference.result.reason,
        referenceIdentifier: invalidReference.identifier
      };
    }

    const normalizedReferences = references.map((reference) => {
      if (reference.result.ok === false) throw new Error("Invalid reference reached dispatch.");
      return reference.result.reference;
    });
    const duplicateReference = findDuplicateReference(normalizedReferences);
    if (duplicateReference !== undefined) {
      return { ok: false, reason: "DUPLICATE_REFERENCE", referenceIdentifier: duplicateReference };
    }

    return this.creator.create({
      commandId,
      code,
      requestingEntityId,
      items: items.map((item) => {
        if (item.result.ok === false) throw new Error("Invalid item reached dispatch.");
        return item.result.item;
      }),
      references: normalizedReferences,
      requestedAt: input.requestedAt ?? new Date(),
      summary,
      reason,
      registeredByUserId: registeredByUserId ?? undefined,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}

function normalizeItems(items: CreateAuthorizedMaterialRequestItemInput[]): Array<{
  lineNumber: number;
  result:
    | { ok: true; item: CreateAuthorizedMaterialRequestItemCommand }
    | {
        ok: false;
        reason:
          | "INVALID_ITEM_CATALOG_REFERENCE"
          | "INVALID_REQUESTED_QUANTITY"
          | "INVALID_AUTHORIZED_QUANTITY"
          | "AUTHORIZED_QUANTITY_EXCEEDS_REQUESTED";
      };
}> {
  return items.map((item, index) => {
    const lineNumber = index + 1;
    const materialSingularId = normalizeOptionalString(item.materialSingularId);
    const materialConfigurationId = normalizeOptionalString(item.materialConfigurationId);

    if (materialSingularId === null || materialConfigurationId === null) {
      return { lineNumber, result: { ok: false, reason: "INVALID_ITEM_CATALOG_REFERENCE" } };
    }
    if ((materialSingularId === undefined) === (materialConfigurationId === undefined)) {
      return { lineNumber, result: { ok: false, reason: "INVALID_ITEM_CATALOG_REFERENCE" } };
    }
    if (!Number.isInteger(item.requestedQuantity) || item.requestedQuantity <= 0) {
      return { lineNumber, result: { ok: false, reason: "INVALID_REQUESTED_QUANTITY" } };
    }
    if (!Number.isInteger(item.authorizedQuantity) || item.authorizedQuantity < 0) {
      return { lineNumber, result: { ok: false, reason: "INVALID_AUTHORIZED_QUANTITY" } };
    }
    if (item.authorizedQuantity > item.requestedQuantity) {
      return { lineNumber, result: { ok: false, reason: "AUTHORIZED_QUANTITY_EXCEEDS_REQUESTED" } };
    }

    return {
      lineNumber,
      result: {
        ok: true,
        item: {
          lineNumber,
          materialSingularId,
          materialConfigurationId,
          requestedQuantity: item.requestedQuantity,
          authorizedQuantity: item.authorizedQuantity
        }
      }
    };
  });
}

function normalizeReferences(references: CreateAuthorizedMaterialRequestReferenceInput[]): Array<{
  identifier?: string;
  result:
    | { ok: true; reference: CreateAuthorizedMaterialRequestReferenceCommand }
    | {
        ok: false;
        reason:
          | "INVALID_REFERENCE_SYSTEM"
          | "INVALID_REFERENCE_TYPE"
          | "INVALID_REFERENCE_IDENTIFIER"
          | "INVALID_REFERENCE_URL";
      };
}> {
  return references.map((reference) => {
    const referenceType = reference.referenceType.trim();
    const identifier = reference.identifier.trim();
    const url = normalizeOptionalString(reference.url);

    if (!REFERENCE_SYSTEMS.has(reference.system)) {
      return { identifier, result: { ok: false, reason: "INVALID_REFERENCE_SYSTEM" } };
    }
    if (referenceType.length === 0) {
      return { identifier, result: { ok: false, reason: "INVALID_REFERENCE_TYPE" } };
    }
    if (identifier.length === 0) {
      return { identifier, result: { ok: false, reason: "INVALID_REFERENCE_IDENTIFIER" } };
    }
    if (url === null) return { identifier, result: { ok: false, reason: "INVALID_REFERENCE_URL" } };

    return {
      identifier,
      result: {
        ok: true,
        reference: { system: reference.system, referenceType, identifier, url: url ?? undefined }
      }
    };
  });
}

function normalizeOptionalString(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function findDuplicateReference(
  references: CreateAuthorizedMaterialRequestReferenceCommand[]
): string | undefined {
  const seen = new Set<string>();
  for (const reference of references) {
    const key = `${reference.system}:${reference.identifier}`;
    if (seen.has(key)) return reference.identifier;
    seen.add(key);
  }
  return undefined;
}
