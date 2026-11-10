export type LinkMaintenanceRequestPatrimonyTargetsInput = {
  commandId: string;
  maintenanceRequestId: string;
  patrimonyIds: string[];
  linkedAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type LinkMaintenanceRequestPatrimonyTargetsCommand = {
  commandId: string;
  maintenanceRequestId: string;
  patrimonyIds: string[];
  linkedAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type LinkMaintenanceRequestPatrimonyTargetsResult =
  | {
      ok: true;
      maintenanceRequestId: string;
      status: "EM_ANALISE";
      linkedPatrimonyIds: string[];
      linkedCount: number;
    }
  | {
      ok: false;
      reason: LinkMaintenanceRequestPatrimonyTargetsFailureReason;
      maintenanceRequestId?: string;
      patrimonyId?: string;
    };

export type LinkMaintenanceRequestPatrimonyTargetsFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_MAINTENANCE_REQUEST_ID"
  | "EMPTY_PATRIMONY_TARGETS"
  | "INVALID_PATRIMONY_ID"
  | "DUPLICATE_PATRIMONY_TARGET"
  | "INVALID_LINKED_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "MAINTENANCE_REQUEST_NOT_FOUND"
  | "MAINTENANCE_REQUEST_NOT_AUTHORIZED"
  | "PATRIMONY_NOT_FOUND"
  | "PATRIMONY_ALREADY_LINKED"
  | "ACTOR_NOT_AUTHORIZED";

export type MaintenanceRequestPatrimonyTargetLinker = {
  link(
    input: LinkMaintenanceRequestPatrimonyTargetsCommand
  ): Promise<LinkMaintenanceRequestPatrimonyTargetsResult>;
};

export class LinkMaintenanceRequestPatrimonyTargets {
  constructor(private readonly linker: MaintenanceRequestPatrimonyTargetLinker) {}

  async execute(
    input: LinkMaintenanceRequestPatrimonyTargetsInput
  ): Promise<LinkMaintenanceRequestPatrimonyTargetsResult> {
    const commandId = input.commandId.trim();
    const maintenanceRequestId = input.maintenanceRequestId.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (maintenanceRequestId.length === 0) {
      return { ok: false, reason: "INVALID_MAINTENANCE_REQUEST_ID" };
    }

    if (input.patrimonyIds.length === 0) {
      return { ok: false, reason: "EMPTY_PATRIMONY_TARGETS" };
    }

    const patrimonyIds: string[] = [];
    const seenPatrimonyIds = new Set<string>();
    for (const value of input.patrimonyIds) {
      const patrimonyId = value.trim();
      if (patrimonyId.length === 0) {
        return { ok: false, reason: "INVALID_PATRIMONY_ID" };
      }

      if (seenPatrimonyIds.has(patrimonyId)) {
        return { ok: false, reason: "DUPLICATE_PATRIMONY_TARGET", patrimonyId };
      }

      seenPatrimonyIds.add(patrimonyId);
      patrimonyIds.push(patrimonyId);
    }

    if (input.linkedAt !== undefined && Number.isNaN(input.linkedAt.getTime())) {
      return { ok: false, reason: "INVALID_LINKED_AT" };
    }

    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID" };
    }

    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT" };
    }

    return this.linker.link({
      commandId,
      maintenanceRequestId,
      patrimonyIds,
      linkedAt: input.linkedAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
