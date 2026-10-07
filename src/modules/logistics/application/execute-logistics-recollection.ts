export type ExecutedLogisticsRecollectionStatus = "EXECUTADA";

export type ExecuteLogisticsRecollectionInput = {
  commandId: string;
  recollectionId: string;
  executedAt?: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type ExecuteLogisticsRecollectionCommand = {
  commandId: string;
  recollectionId: string;
  executedAt: Date;
  summary: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type ExecuteLogisticsRecollectionFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_RECOLLECTION_ID"
  | "INVALID_SUMMARY"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "RECOLLECTION_NOT_FOUND"
  | "RECOLLECTION_NOT_AUTHORIZED"
  | "EXECUTION_DATE_BEFORE_AUTHORIZATION";

export type ExecuteLogisticsRecollectionResult =
  | {
      ok: true;
      recollectionId: string;
      status: ExecutedLogisticsRecollectionStatus;
    }
  | {
      ok: false;
      reason: ExecuteLogisticsRecollectionFailureReason;
      recollectionId?: string;
    };

export type LogisticsRecollectionExecutor = {
  execute(input: ExecuteLogisticsRecollectionCommand): Promise<ExecuteLogisticsRecollectionResult>;
};

export class ExecuteLogisticsRecollection {
  constructor(private readonly executor: LogisticsRecollectionExecutor) {}

  async execute(
    input: ExecuteLogisticsRecollectionInput
  ): Promise<ExecuteLogisticsRecollectionResult> {
    const commandId = input.commandId.trim();
    const recollectionId = input.recollectionId.trim();
    const summary = input.summary.trim();

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (recollectionId.length === 0) {
      return { ok: false, reason: "INVALID_RECOLLECTION_ID" };
    }

    if (summary.length === 0) {
      return { ok: false, reason: "INVALID_SUMMARY" };
    }

    return this.executor.execute({
      commandId,
      recollectionId,
      executedAt: input.executedAt ?? new Date(),
      summary,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}
