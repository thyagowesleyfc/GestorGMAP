export type MaintenanceRequestReferenceSystem = "SEI" | "REDMINE";

export type RegisterMaintenanceRequestReferenceInput = {
  system: MaintenanceRequestReferenceSystem;
  identifier: string;
  url?: string;
};

export type RegisterMaintenanceRequestInput = {
  commandId: string;
  requestingEntityId: string;
  summary: string;
  description: string;
  references?: RegisterMaintenanceRequestReferenceInput[];
  requestedAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type RegisterMaintenanceRequestReferenceCommand = {
  system: MaintenanceRequestReferenceSystem;
  identifier: string;
  url?: string;
};

export type RegisterMaintenanceRequestCommand = {
  commandId: string;
  requestingEntityId: string;
  summary: string;
  description: string;
  references: RegisterMaintenanceRequestReferenceCommand[];
  requestedAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type MaintenanceRequestStatus = "REGISTRADA";

export type RegisterMaintenanceRequestFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_REQUESTING_ENTITY_ID"
  | "INVALID_SUMMARY"
  | "INVALID_DESCRIPTION"
  | "INVALID_REQUESTED_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "INVALID_REFERENCE_SYSTEM"
  | "INVALID_REFERENCE_IDENTIFIER"
  | "INVALID_REFERENCE_URL"
  | "DUPLICATE_REFERENCE"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "ACTOR_NOT_AUTHORIZED"
  | "REQUESTING_ENTITY_NOT_FOUND";

export type RegisterMaintenanceRequestResult =
  | {
      ok: true;
      maintenanceRequestId: string;
      status: MaintenanceRequestStatus;
      referenceCount: number;
    }
  | {
      ok: false;
      reason: RegisterMaintenanceRequestFailureReason;
      referenceIdentifier?: string;
    };

export type MaintenanceRequestRegistrar = {
  register(input: RegisterMaintenanceRequestCommand): Promise<RegisterMaintenanceRequestResult>;
};

const REFERENCE_SYSTEMS = new Set<MaintenanceRequestReferenceSystem>(["SEI", "REDMINE"]);

export class RegisterMaintenanceRequest {
  constructor(private readonly registrar: MaintenanceRequestRegistrar) {}

  async execute(input: RegisterMaintenanceRequestInput): Promise<RegisterMaintenanceRequestResult> {
    const commandId = input.commandId.trim();
    const requestingEntityId = input.requestingEntityId.trim();
    const summary = input.summary.trim();
    const description = input.description.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();
    const references = normalizeReferences(input.references ?? []);

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (requestingEntityId.length === 0) {
      return { ok: false, reason: "INVALID_REQUESTING_ENTITY_ID" };
    }

    if (summary.length === 0) {
      return { ok: false, reason: "INVALID_SUMMARY" };
    }

    if (description.length === 0) {
      return { ok: false, reason: "INVALID_DESCRIPTION" };
    }

    if (input.requestedAt !== undefined && Number.isNaN(input.requestedAt.getTime())) {
      return { ok: false, reason: "INVALID_REQUESTED_AT" };
    }

    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID" };
    }

    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT" };
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
      if (reference.result.ok === false) {
        throw new Error("Invalid reference unexpectedly reached duplicate validation.");
      }

      return reference.result.reference;
    });

    const duplicateReference = findDuplicateReference(normalizedReferences);
    if (duplicateReference !== undefined) {
      return {
        ok: false,
        reason: "DUPLICATE_REFERENCE",
        referenceIdentifier: duplicateReference
      };
    }

    return this.registrar.register({
      commandId,
      requestingEntityId,
      summary,
      description,
      references: normalizedReferences,
      requestedAt: input.requestedAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}

function normalizeReferences(references: RegisterMaintenanceRequestReferenceInput[]): Array<{
  identifier: string;
  result:
    | { ok: true; reference: RegisterMaintenanceRequestReferenceCommand }
    | {
        ok: false;
        reason:
          "INVALID_REFERENCE_SYSTEM" | "INVALID_REFERENCE_IDENTIFIER" | "INVALID_REFERENCE_URL";
      };
}> {
  return references.map((reference) => {
    const identifier = reference.identifier.trim();
    const url = normalizeOptionalString(reference.url);

    if (!REFERENCE_SYSTEMS.has(reference.system)) {
      return { identifier, result: { ok: false, reason: "INVALID_REFERENCE_SYSTEM" } };
    }

    if (identifier.length === 0) {
      return { identifier, result: { ok: false, reason: "INVALID_REFERENCE_IDENTIFIER" } };
    }

    if (url !== undefined && !isHttpUrl(url)) {
      return { identifier, result: { ok: false, reason: "INVALID_REFERENCE_URL" } };
    }

    return {
      identifier,
      result: {
        ok: true,
        reference: {
          system: reference.system,
          identifier,
          url
        }
      }
    };
  });
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function findDuplicateReference(
  references: RegisterMaintenanceRequestReferenceCommand[]
): string | undefined {
  const seen = new Set<string>();

  for (const reference of references) {
    const key = `${reference.system}:${reference.identifier}`;
    if (seen.has(key)) {
      return reference.identifier;
    }
    seen.add(key);
  }

  return undefined;
}
