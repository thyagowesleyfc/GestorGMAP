import type { EmailSender } from "../email/email-sender";
import type { OutboxEventHandler, OutboxEventRecord } from "./process-outbox-events";

type LogisticsDeliveryAcceptanceStatus = "TOTAL" | "PARCIAL" | "RECUSADO";

type LogisticsDeliveryRegisteredPayload = {
  deliveryId: string;
  shipmentId: string;
  acceptanceStatus: LogisticsDeliveryAcceptanceStatus;
  deliveredAt: string;
  correlationId: string;
};

export type LogisticsDeliveryRegisteredEmailHandlerOptions = {
  recipients: string[];
};

const LOGISTICS_DELIVERY_REGISTERED = "logistics.delivery_registered";
const LOGISTICS_DELIVERY = "logistics_delivery";
const ACCEPTANCE_STATUSES = new Set<LogisticsDeliveryAcceptanceStatus>([
  "TOTAL",
  "PARCIAL",
  "RECUSADO"
]);

export class LogisticsDeliveryRegisteredEmailHandler implements OutboxEventHandler {
  constructor(
    private readonly emailSender: EmailSender,
    private readonly options: LogisticsDeliveryRegisteredEmailHandlerOptions
  ) {}

  async handle(event: OutboxEventRecord): Promise<void> {
    if (event.eventType !== LOGISTICS_DELIVERY_REGISTERED) {
      throw new Error(`Evento de Outbox nao suportado: ${event.eventType}`);
    }

    if (event.aggregateType !== LOGISTICS_DELIVERY) {
      throw new Error(`Aggregate de Outbox invalido para entrega: ${event.aggregateType}`);
    }

    const recipients = normalizeRecipients(this.options.recipients);
    if (recipients.length === 0) {
      throw new Error("Destinatarios de e-mail da entrega nao configurados.");
    }

    const payload = parsePayload(event.payload);

    await this.emailSender.send({
      to: recipients,
      subject: `Entrega registrada no GESTOR GMAP: ${payload.acceptanceStatus}`,
      text: [
        "Uma entrega foi registrada no GESTOR GMAP.",
        `Entrega: ${payload.deliveryId}`,
        `Envio: ${payload.shipmentId}`,
        `Aceite: ${payload.acceptanceStatus}`,
        `Registrada em: ${payload.deliveredAt}`,
        `Correlacao: ${payload.correlationId}`
      ].join("\n"),
      metadata: {
        eventId: event.id,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        correlationId: payload.correlationId
      }
    });
  }
}

function normalizeRecipients(recipients: string[]): string[] {
  return recipients
    .map((recipient) => recipient.trim())
    .filter((recipient) => recipient.length > 0);
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
