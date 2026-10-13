import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { OutboxEventHandler, OutboxEventRecord } from "./process-outbox-events";

type LogisticsDeliveryAcceptanceStatus = "TOTAL" | "PARCIAL" | "RECUSADO";

type LogisticsDeliveryRegisteredPayload = {
  deliveryId: string;
  shipmentId: string;
  acceptanceStatus: LogisticsDeliveryAcceptanceStatus;
  deliveredAt: string;
  correlationId: string;
};

export type LogisticsDeliveryRegisteredNotificationHandlerOptions = {
  targetTeamContext: string;
};

const LOGISTICS_DELIVERY_REGISTERED = "logistics.delivery_registered";
const LOGISTICS_DELIVERY = "logistics_delivery";
const ACCEPTANCE_STATUSES = new Set<LogisticsDeliveryAcceptanceStatus>([
  "TOTAL",
  "PARCIAL",
  "RECUSADO"
]);

export class LogisticsDeliveryRegisteredNotificationHandler implements OutboxEventHandler {
  constructor(
    private readonly pool: Pool,
    private readonly options: LogisticsDeliveryRegisteredNotificationHandlerOptions
  ) {}

  async handle(event: OutboxEventRecord): Promise<void> {
    if (event.eventType !== LOGISTICS_DELIVERY_REGISTERED) {
      throw new Error(`Evento de Outbox nao suportado: ${event.eventType}`);
    }

    if (event.aggregateType !== LOGISTICS_DELIVERY) {
      throw new Error(`Aggregate de Outbox invalido para entrega: ${event.aggregateType}`);
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
        "Entrega registrada",
        `A entrega ${payload.deliveryId} foi registrada com aceite ${payload.acceptanceStatus} em ${payload.deliveredAt}.`,
        LOGISTICS_DELIVERY,
        payload.deliveryId,
        payload.correlationId
      ]
    );
  }
}

function parsePayload(payload: unknown): LogisticsDeliveryRegisteredPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Payload de entrega registrada invalido.");
  }

  const record = payload as Partial<Record<keyof LogisticsDeliveryRegisteredPayload, unknown>>;

  if (
    typeof record.deliveryId !== "string" ||
    typeof record.shipmentId !== "string" ||
    typeof record.deliveredAt !== "string" ||
    typeof record.correlationId !== "string" ||
    !isAcceptanceStatus(record.acceptanceStatus)
  ) {
    throw new Error("Payload de entrega registrada incompleto.");
  }

  return {
    deliveryId: record.deliveryId,
    shipmentId: record.shipmentId,
    acceptanceStatus: record.acceptanceStatus,
    deliveredAt: record.deliveredAt,
    correlationId: record.correlationId
  };
}

function isAcceptanceStatus(value: unknown): value is LogisticsDeliveryAcceptanceStatus {
  return (
    typeof value === "string" && ACCEPTANCE_STATUSES.has(value as LogisticsDeliveryAcceptanceStatus)
  );
}
