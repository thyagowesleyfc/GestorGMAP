import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { OutboxEventHandler, OutboxEventRecord } from "./process-outbox-events";

type LogisticsRecollectionExecutedPayload = {
  recollectionId: string;
  status: "EXECUTADA";
  executedAt: string;
  correlationId: string;
};

export type LogisticsRecollectionExecutedNotificationHandlerOptions = {
  targetTeamContext: string;
};

const LOGISTICS_RECOLLECTION_EXECUTED = "logistics.recollection_executed";
const LOGISTICS_RECOLLECTION = "logistics_recollection";

export class LogisticsRecollectionExecutedNotificationHandler implements OutboxEventHandler {
  constructor(
    private readonly pool: Pool,
    private readonly options: LogisticsRecollectionExecutedNotificationHandlerOptions
  ) {}

  async handle(event: OutboxEventRecord): Promise<void> {
    if (event.eventType !== LOGISTICS_RECOLLECTION_EXECUTED) {
      throw new Error(`Evento de Outbox nao suportado: ${event.eventType}`);
    }

    if (event.aggregateType !== LOGISTICS_RECOLLECTION) {
      throw new Error(`Aggregate de Outbox invalido para recolha: ${event.aggregateType}`);
    }

    const targetTeamContext = this.options.targetTeamContext.trim();
    if (targetTeamContext.length === 0) {
      throw new Error("Contexto de destino da Gerencia nao configurado.");
    }

    const payload = parsePayload(event.payload);

    await this.pool.query(
      `insert into "internal_notification" (
        "id", "target_type", "target_team_context", "title", "body", "action_required",
        "related_type", "related_id", "correlation_id", "updated_at"
      )
      select $1::uuid,
             'GERENCIA'::"InternalNotificationTargetType",
             $2::varchar,
             $3::varchar,
             $4::varchar,
             false,
             $5::varchar,
             $6::varchar,
             $7::varchar,
             current_timestamp
      where not exists (
        select 1
          from "internal_notification"
         where "target_type" = 'GERENCIA'
           and "target_team_context" = $2
           and "related_type" = $5
           and "related_id" = $6
           and "correlation_id" = $7
      )`,
      [
        randomUUID(),
        targetTeamContext,
        "Recolha executada",
        `A recolha ${payload.recollectionId} foi executada em ${payload.executedAt}.`,
        LOGISTICS_RECOLLECTION,
        payload.recollectionId,
        payload.correlationId
      ]
    );
  }
}

function parsePayload(payload: unknown): LogisticsRecollectionExecutedPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Payload de recolha executada invalido.");
  }

  const record = payload as Partial<Record<keyof LogisticsRecollectionExecutedPayload, unknown>>;

  if (
    typeof record.recollectionId !== "string" ||
    record.status !== "EXECUTADA" ||
    typeof record.executedAt !== "string" ||
    typeof record.correlationId !== "string"
  ) {
    throw new Error("Payload de recolha executada incompleto.");
  }

  return {
    recollectionId: record.recollectionId,
    status: record.status,
    executedAt: record.executedAt,
    correlationId: record.correlationId
  };
}
