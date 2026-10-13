import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { OutboxEventHandler, OutboxEventRecord } from "./process-outbox-events";

type MaterialRequestFinalizedPayload = {
  materialRequestId: string;
  status: "FINALIZADA";
  finalizedAt: string;
  shipmentCount: number;
  correlationId: string;
};

export type MaterialRequestFinalizedNotificationHandlerOptions = {
  targetTeamContext: string;
};

const MATERIAL_REQUEST_FINALIZED = "requests.material_request_finalized";
const MATERIAL_REQUEST = "material_request";

export class MaterialRequestFinalizedNotificationHandler implements OutboxEventHandler {
  constructor(
    private readonly pool: Pool,
    private readonly options: MaterialRequestFinalizedNotificationHandlerOptions
  ) {}

  async handle(event: OutboxEventRecord): Promise<void> {
    if (event.eventType !== MATERIAL_REQUEST_FINALIZED) {
      throw new Error(`Evento de Outbox nao suportado: ${event.eventType}`);
    }

    if (event.aggregateType !== MATERIAL_REQUEST) {
      throw new Error(`Aggregate de Outbox invalido para solicitacao: ${event.aggregateType}`);
    }

    const targetTeamContext = this.options.targetTeamContext.trim();
    if (targetTeamContext.length === 0) {
      throw new Error("Contexto de destino da Gerencia nao configurado.");
    }

    const payload = parsePayload(event.payload);
    if (event.aggregateId !== payload.materialRequestId) {
      throw new Error("Payload de solicitação finalizada diverge do aggregate da Outbox.");
    }

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
        "Solicitação finalizada",
        `A solicitação ${payload.materialRequestId} foi finalizada em ${payload.finalizedAt}.`,
        MATERIAL_REQUEST,
        payload.materialRequestId,
        payload.correlationId
      ]
    );
  }
}

function parsePayload(payload: unknown): MaterialRequestFinalizedPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Payload de solicitacao finalizada invalido.");
  }

  const record = payload as Partial<Record<keyof MaterialRequestFinalizedPayload, unknown>>;

  if (
    typeof record.materialRequestId !== "string" ||
    record.status !== "FINALIZADA" ||
    typeof record.finalizedAt !== "string" ||
    typeof record.shipmentCount !== "number" ||
    !Number.isSafeInteger(record.shipmentCount) ||
    record.shipmentCount <= 0 ||
    typeof record.correlationId !== "string"
  ) {
    throw new Error("Payload de solicitacao finalizada incompleto.");
  }

  return {
    materialRequestId: record.materialRequestId,
    status: record.status,
    finalizedAt: record.finalizedAt,
    shipmentCount: record.shipmentCount,
    correlationId: record.correlationId
  };
}
