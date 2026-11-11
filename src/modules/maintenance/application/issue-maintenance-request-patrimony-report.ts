export type MaintenanceRequestPatrimonyReportConclusion =
  "RECONDICIONAVEL" | "IRRECUPERAVEL" | "INDEFINIDO";

export type IssueMaintenanceRequestPatrimonyReportInput = {
  commandId: string;
  maintenanceRequestId: string;
  patrimonyId: string;
  conclusion: string;
  justification: string;
  issuedAt?: Date;
  actorUserId: string;
  teamContext: string;
  correlationId?: string;
};

export type IssueMaintenanceRequestPatrimonyReportCommand = {
  commandId: string;
  maintenanceRequestId: string;
  patrimonyId: string;
  conclusion: MaintenanceRequestPatrimonyReportConclusion;
  justification: string;
  issuedAt: Date;
  actorUserId: string;
  teamContext: string;
  correlationId: string;
};

export type IssueMaintenanceRequestPatrimonyReportFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_MAINTENANCE_REQUEST_ID"
  | "INVALID_PATRIMONY_ID"
  | "INVALID_CONCLUSION"
  | "INVALID_JUSTIFICATION"
  | "INVALID_ISSUED_AT"
  | "INVALID_ACTOR_USER_ID"
  | "INVALID_TEAM_CONTEXT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "MAINTENANCE_REQUEST_NOT_FOUND"
  | "MAINTENANCE_REQUEST_NOT_AUTHORIZED"
  | "PATRIMONY_TARGET_NOT_LINKED"
  | "PATRIMONY_STRATEGY_NOT_DEFINED"
  | "ACTOR_NOT_AUTHORIZED";

export type IssueMaintenanceRequestPatrimonyReportResult =
  | {
      ok: true;
      reportId: string;
      maintenanceRequestId: string;
      patrimonyId: string;
      version: number;
      conclusion: MaintenanceRequestPatrimonyReportConclusion;
      status: "EM_ANALISE";
    }
  | {
      ok: false;
      reason: IssueMaintenanceRequestPatrimonyReportFailureReason;
      maintenanceRequestId?: string;
      patrimonyId?: string;
    };

export type MaintenanceRequestPatrimonyReportIssuer = {
  issue(
    input: IssueMaintenanceRequestPatrimonyReportCommand
  ): Promise<IssueMaintenanceRequestPatrimonyReportResult>;
};

const CONCLUSIONS = new Set<MaintenanceRequestPatrimonyReportConclusion>([
  "RECONDICIONAVEL",
  "IRRECUPERAVEL",
  "INDEFINIDO"
]);

export class IssueMaintenanceRequestPatrimonyReport {
  constructor(private readonly issuer: MaintenanceRequestPatrimonyReportIssuer) {}

  async execute(
    input: IssueMaintenanceRequestPatrimonyReportInput
  ): Promise<IssueMaintenanceRequestPatrimonyReportResult> {
    const commandId = input.commandId.trim();
    const maintenanceRequestId = input.maintenanceRequestId.trim();
    const patrimonyId = input.patrimonyId.trim();
    const conclusion = input.conclusion.trim().toUpperCase();
    const justification = input.justification.trim();
    const actorUserId = input.actorUserId.trim();
    const teamContext = input.teamContext.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (maintenanceRequestId.length === 0) {
      return { ok: false, reason: "INVALID_MAINTENANCE_REQUEST_ID" };
    }

    if (patrimonyId.length === 0) {
      return { ok: false, reason: "INVALID_PATRIMONY_ID" };
    }

    if (!CONCLUSIONS.has(conclusion as MaintenanceRequestPatrimonyReportConclusion)) {
      return { ok: false, reason: "INVALID_CONCLUSION", patrimonyId };
    }

    if (justification.length === 0 || justification.length > 1000) {
      return { ok: false, reason: "INVALID_JUSTIFICATION", patrimonyId };
    }

    if (input.issuedAt !== undefined && Number.isNaN(input.issuedAt.getTime())) {
      return { ok: false, reason: "INVALID_ISSUED_AT", patrimonyId };
    }

    if (actorUserId.length === 0) {
      return { ok: false, reason: "INVALID_ACTOR_USER_ID" };
    }

    if (teamContext.length === 0) {
      return { ok: false, reason: "INVALID_TEAM_CONTEXT" };
    }

    return this.issuer.issue({
      commandId,
      maintenanceRequestId,
      patrimonyId,
      conclusion: conclusion as MaintenanceRequestPatrimonyReportConclusion,
      justification,
      issuedAt: input.issuedAt ?? new Date(),
      actorUserId,
      teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
