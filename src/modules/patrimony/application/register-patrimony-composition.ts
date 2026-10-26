export type PatrimonyCompositionComponentInput = {
  materialSingularId: string;
  componentPatrimonyId?: string;
};

export type RegisterPatrimonyCompositionInput = {
  commandId: string;
  patrimonyId: string;
  materialConfigurationId: string;
  components: PatrimonyCompositionComponentInput[];
  recordedAt?: Date;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type RegisterPatrimonyCompositionCommand = {
  commandId: string;
  patrimonyId: string;
  materialConfigurationId: string;
  components: PatrimonyCompositionComponentInput[];
  recordedAt: Date;
  reason: string;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type RegisterPatrimonyCompositionFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_PATRIMONY_ID"
  | "INVALID_MATERIAL_CONFIGURATION_ID"
  | "INVALID_RECORDED_AT"
  | "INVALID_REASON"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "EMPTY_COMPONENTS"
  | "INVALID_COMPONENT_MATERIAL_ID"
  | "DUPLICATE_COMPONENT_MATERIAL"
  | "INVALID_COMPONENT_PATRIMONY_ID"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "ACTOR_NOT_AUTHORIZED"
  | "PATRIMONY_NOT_FOUND"
  | "MATERIAL_CONFIGURATION_NOT_FOUND"
  | "MATERIAL_CONFIGURATION_NOT_ACTIVE"
  | "MATERIAL_CONFIGURATION_WITHOUT_COMPONENTS"
  | "COMPONENT_SET_MISMATCH"
  | "TOMBABLE_COMPONENT_REQUIRES_PATRIMONY"
  | "NON_TOMBABLE_COMPONENT_CANNOT_HAVE_PATRIMONY"
  | "TOMBABLE_COMPONENT_QUANTITY_UNSUPPORTED"
  | "COMPONENT_PATRIMONY_NOT_FOUND"
  | "COMPONENT_PATRIMONY_MATERIAL_MISMATCH"
  | "COMPONENT_PATRIMONY_ENTITY_MISMATCH"
  | "COMPONENT_PATRIMONY_WITHOUT_ACTIVE_TOMBO"
  | "COMPONENT_PATRIMONY_SELF_REFERENCE"
  | "COMPONENT_PATRIMONY_ALREADY_ATTACHED"
  | "NESTED_COMPONENT_COMPOSITION_NOT_SUPPORTED";

export type RegisterPatrimonyCompositionResult =
  | {
      ok: true;
      compositionId: string;
      patrimonyId: string;
      revision: number;
      itemCount: number;
    }
  | {
      ok: false;
      reason: RegisterPatrimonyCompositionFailureReason;
      patrimonyId?: string;
      materialSingularId?: string;
    };

export type PatrimonyCompositionRegisterer = {
  register(input: RegisterPatrimonyCompositionCommand): Promise<RegisterPatrimonyCompositionResult>;
};

export class RegisterPatrimonyComposition {
  constructor(private readonly registerer: PatrimonyCompositionRegisterer) {}

  async execute(
    input: RegisterPatrimonyCompositionInput
  ): Promise<RegisterPatrimonyCompositionResult> {
    const commandId = input.commandId.trim();
    const patrimonyId = input.patrimonyId.trim();
    const materialConfigurationId = input.materialConfigurationId.trim();
    const reason = input.reason.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (patrimonyId.length === 0) {
      return { ok: false, reason: "INVALID_PATRIMONY_ID" };
    }

    if (materialConfigurationId.length === 0) {
      return { ok: false, reason: "INVALID_MATERIAL_CONFIGURATION_ID" };
    }

    if (input.recordedAt !== undefined && Number.isNaN(input.recordedAt.getTime())) {
      return { ok: false, reason: "INVALID_RECORDED_AT" };
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

    if (!Array.isArray(input.components) || input.components.length === 0) {
      return { ok: false, reason: "EMPTY_COMPONENTS" };
    }

    const seenMaterialIds = new Set<string>();
    const components: PatrimonyCompositionComponentInput[] = [];

    for (const component of input.components) {
      const materialSingularId = component.materialSingularId.trim();
      const componentPatrimonyId = component.componentPatrimonyId?.trim() || undefined;

      if (materialSingularId.length === 0) {
        return { ok: false, reason: "INVALID_COMPONENT_MATERIAL_ID" };
      }

      if (seenMaterialIds.has(materialSingularId)) {
        return {
          ok: false,
          reason: "DUPLICATE_COMPONENT_MATERIAL",
          materialSingularId
        };
      }

      if (component.componentPatrimonyId !== undefined && componentPatrimonyId === undefined) {
        return { ok: false, reason: "INVALID_COMPONENT_PATRIMONY_ID", materialSingularId };
      }

      seenMaterialIds.add(materialSingularId);
      components.push({ materialSingularId, componentPatrimonyId });
    }

    components.sort((left, right) =>
      left.materialSingularId.localeCompare(right.materialSingularId)
    );

    return this.registerer.register({
      commandId,
      patrimonyId,
      materialConfigurationId,
      components,
      recordedAt: input.recordedAt ?? new Date(),
      reason,
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
