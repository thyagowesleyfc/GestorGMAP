export type MaintenanceRequestPatrimonyStrategyType =
  "UTD" | "CERME" | "CONTRATO_SERVICO" | "GARANTIA" | "AVALIACAO_BAIXA";

export type DefineMaintenanceRequestPatrimonyStrategyInput = {
  commandId: string;
  maintenanceRequestId: string;
  targets: Array<{
    patrimonyId: string;
    strategyType: MaintenanceRequestPatrimonyStrategyType;
    contractId?: string;
    justification: string;
  }>;
  definedAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type DefineMaintenanceRequestPatrimonyStrategyCommand = {
  commandId: string;
  maintenanceRequestId: string;
  targets: Array<{
    patrimonyId: string;
    strategyType: MaintenanceRequestPatrimonyStrategyType;
    contractId?: string;
    justification: string;
  }>;
  definedAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type DefineMaintenanceRequestPatrimonyStrategyFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_MAINTENANCE_REQUEST_ID"
  | "EMPTY_STRATEGY_TARGETS"
  | "INVALID_PATRIMONY_ID"
  | "DUPLICATE_STRATEGY_TARGET"
  | "INVALID_STRATEGY"
  | "CONTRACT_REQUIRED_FOR_STRATEGY"
  | "INVALID_CONTRACT_ID"
  | "INVALID_JUSTIFICATION"
  | "INVALID_DEFINED_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "MAINTENANCE_REQUEST_NOT_FOUND"
  | "MAINTENANCE_REQUEST_NOT_AUTHORIZED"
  | "PATRIMONY_TARGET_NOT_LINKED"
  | "CONTRACT_NOT_ALLOWED_FOR_STRATEGY"
  | "CONTRACT_NOT_FOUND"
  | "CONTRACT_NOT_APPLICABLE"
  | "ACTOR_NOT_AUTHORIZED";

export type DefineMaintenanceRequestPatrimonyStrategyResult =
  | {
      ok: true;
      maintenanceRequestId: string;
      status: "EM_ANALISE";
      definedPatrimonyIds: string[];
      definedCount: number;
    }
  | {
      ok: false;
      reason: DefineMaintenanceRequestPatrimonyStrategyFailureReason;
      maintenanceRequestId?: string;
      patrimonyId?: string;
    };

export type MaintenanceRequestPatrimonyStrategyDefiner = {
  define(
    input: DefineMaintenanceRequestPatrimonyStrategyCommand
  ): Promise<DefineMaintenanceRequestPatrimonyStrategyResult>;
};

const STRATEGIES = new Set<MaintenanceRequestPatrimonyStrategyType>([
  "UTD",
  "CERME",
  "CONTRATO_SERVICO",
  "GARANTIA",
  "AVALIACAO_BAIXA"
]);

export class DefineMaintenanceRequestPatrimonyStrategy {
  constructor(private readonly definer: MaintenanceRequestPatrimonyStrategyDefiner) {}

  async execute(
    input: DefineMaintenanceRequestPatrimonyStrategyInput
  ): Promise<DefineMaintenanceRequestPatrimonyStrategyResult> {
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

    if (input.targets.length === 0) {
      return { ok: false, reason: "EMPTY_STRATEGY_TARGETS" };
    }

    const targets: DefineMaintenanceRequestPatrimonyStrategyCommand["targets"] = [];
    const seenPatrimonyIds = new Set<string>();
    for (const target of input.targets) {
      const patrimonyId = target.patrimonyId.trim();
      if (patrimonyId.length === 0) {
        return { ok: false, reason: "INVALID_PATRIMONY_ID" };
      }

      if (seenPatrimonyIds.has(patrimonyId)) {
        return { ok: false, reason: "DUPLICATE_STRATEGY_TARGET", patrimonyId };
      }
      seenPatrimonyIds.add(patrimonyId);

      if (!STRATEGIES.has(target.strategyType)) {
        return { ok: false, reason: "INVALID_STRATEGY", patrimonyId };
      }

      const contractId = target.contractId?.trim();
      if (target.strategyType === "CONTRATO_SERVICO" && !contractId) {
        return { ok: false, reason: "CONTRACT_REQUIRED_FOR_STRATEGY", patrimonyId };
      }
      if (contractId !== undefined && contractId.length === 0) {
        return { ok: false, reason: "INVALID_CONTRACT_ID", patrimonyId };
      }
      if (target.strategyType !== "CONTRATO_SERVICO" && contractId !== undefined) {
        return {
          ok: false,
          reason: "CONTRACT_NOT_ALLOWED_FOR_STRATEGY",
          patrimonyId
        };
      }

      const justification = target.justification.trim();
      if (justification.length === 0) {
        return { ok: false, reason: "INVALID_JUSTIFICATION", patrimonyId };
      }

      targets.push({
        patrimonyId,
        strategyType: target.strategyType,
        ...(contractId === undefined ? {} : { contractId }),
        justification
      });
    }

    if (input.definedAt !== undefined && Number.isNaN(input.definedAt.getTime())) {
      return { ok: false, reason: "INVALID_DEFINED_AT" };
    }

    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID" };
    }

    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT" };
    }

    return this.definer.define({
      commandId,
      maintenanceRequestId,
      targets,
      definedAt: input.definedAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
