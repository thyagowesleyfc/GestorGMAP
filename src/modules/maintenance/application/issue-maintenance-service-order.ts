export type MaintenanceServiceOrderStatus = "EMITIDA";

export type IssueMaintenanceServiceOrderServiceInput = {
  description: string;
};

export type IssueMaintenanceServiceOrderInput = {
  commandId: string;
  code: string;
  maintenanceRequestId: string;
  contractId: string;
  entityId: string;
  patrimonyIds: string[];
  services: IssueMaintenanceServiceOrderServiceInput[];
  issuedAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type IssueMaintenanceServiceOrderCommand = {
  commandId: string;
  code: string;
  maintenanceRequestId: string;
  contractId: string;
  entityId: string;
  patrimonyIds: string[];
  services: Array<{ description: string }>;
  issuedAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type IssueMaintenanceServiceOrderFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_CODE"
  | "INVALID_MAINTENANCE_REQUEST_ID"
  | "INVALID_CONTRACT_ID"
  | "INVALID_ENTITY_ID"
  | "INVALID_PATRIMONY_ID"
  | "EMPTY_PATRIMONY_TARGETS"
  | "DUPLICATE_PATRIMONY_TARGET"
  | "EMPTY_SERVICES"
  | "INVALID_SERVICE_DESCRIPTION"
  | "INVALID_ISSUED_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "SERVICE_ORDER_CODE_CONFLICT"
  | "MAINTENANCE_REQUEST_NOT_FOUND"
  | "MAINTENANCE_REQUEST_NOT_AUTHORIZED"
  | "ENTITY_NOT_REQUESTING_ENTITY"
  | "CONTRACT_NOT_FOUND"
  | "CONTRACT_NOT_APPLICABLE"
  | "PATRIMONY_TARGET_NOT_LINKED"
  | "PATRIMONY_STRATEGY_NOT_DEFINED"
  | "PATRIMONY_STRATEGY_CONTRACT_MISMATCH"
  | "ACTOR_NOT_AUTHORIZED";

export type IssueMaintenanceServiceOrderResult =
  | {
      ok: true;
      serviceOrderId: string;
      code: string;
      maintenanceRequestId: string;
      contractId: string;
      entityId: string;
      patrimonyIds: string[];
      serviceCount: number;
      status: MaintenanceServiceOrderStatus;
    }
  | {
      ok: false;
      reason: IssueMaintenanceServiceOrderFailureReason;
      maintenanceRequestId?: string;
      contractId?: string;
      entityId?: string;
      patrimonyId?: string;
    };

export type MaintenanceServiceOrderIssuer = {
  issue(input: IssueMaintenanceServiceOrderCommand): Promise<IssueMaintenanceServiceOrderResult>;
};

export class IssueMaintenanceServiceOrder {
  constructor(private readonly issuer: MaintenanceServiceOrderIssuer) {}

  async execute(
    input: IssueMaintenanceServiceOrderInput
  ): Promise<IssueMaintenanceServiceOrderResult> {
    const commandId = input.commandId.trim();
    const code = input.code.trim().toUpperCase();
    const maintenanceRequestId = input.maintenanceRequestId.trim();
    const contractId = input.contractId.trim();
    const entityId = input.entityId.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }
    if (code.length === 0) {
      return { ok: false, reason: "INVALID_CODE" };
    }
    if (maintenanceRequestId.length === 0) {
      return { ok: false, reason: "INVALID_MAINTENANCE_REQUEST_ID" };
    }
    if (contractId.length === 0) {
      return { ok: false, reason: "INVALID_CONTRACT_ID" };
    }
    if (entityId.length === 0) {
      return { ok: false, reason: "INVALID_ENTITY_ID" };
    }
    if (input.patrimonyIds.length === 0) {
      return { ok: false, reason: "EMPTY_PATRIMONY_TARGETS" };
    }

    const patrimonyIds = input.patrimonyIds.map((patrimonyId) => patrimonyId.trim());
    if (patrimonyIds.some((patrimonyId) => patrimonyId.length === 0)) {
      return { ok: false, reason: "INVALID_PATRIMONY_ID" };
    }
    if (new Set(patrimonyIds).size !== patrimonyIds.length) {
      return { ok: false, reason: "DUPLICATE_PATRIMONY_TARGET" };
    }

    if (input.services.length === 0) {
      return { ok: false, reason: "EMPTY_SERVICES" };
    }
    const services = input.services.map((service) => ({
      description: service.description.trim()
    }));
    if (
      services.some(
        (service) => service.description.length === 0 || service.description.length > 500
      )
    ) {
      return { ok: false, reason: "INVALID_SERVICE_DESCRIPTION" };
    }

    if (input.issuedAt !== undefined && Number.isNaN(input.issuedAt.getTime())) {
      return { ok: false, reason: "INVALID_ISSUED_AT" };
    }
    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID" };
    }
    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT" };
    }

    return this.issuer.issue({
      commandId,
      code,
      maintenanceRequestId,
      contractId,
      entityId,
      patrimonyIds,
      services,
      issuedAt: input.issuedAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
