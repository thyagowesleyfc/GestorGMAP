import { describe, expect, it } from "vitest";

import type { EmailMessage, EmailSender } from "../../../src/worker/email/email-sender";
import { LogisticsDeliveryRegisteredEmailHandler } from "../../../src/worker/outbox/logistics-delivery-registered-email-handler";
import type { OutboxEventRecord } from "../../../src/worker/outbox/process-outbox-events";

describe("logistics delivery registered email handler", () => {
  it("sends a delivery registered email through the EmailSender port", async () => {
    const sent: EmailMessage[] = [];
    const emailSender: EmailSender = {
      send: async (message) => {
        sent.push(message);
      }
    };
    const handler = new LogisticsDeliveryRegisteredEmailHandler(emailSender, {
      recipients: [" gmap-logistica@example.test ", ""]
    });

    await handler.handle(makeEvent());

    expect(sent).toEqual([
      {
        to: ["gmap-logistica@example.test"],
        subject: "Entrega registrada no GESTOR GMAP: TOTAL",
        text: [
          "Uma entrega foi registrada no GESTOR GMAP.",
          "Entrega: delivery-1",
          "Envio: shipment-1",
          "Aceite: TOTAL",
          "Registrada em: 2026-09-25T13:00:00.000Z",
          "Correlacao: corr-1"
        ].join("\n"),
        metadata: {
          eventId: "event-1",
          eventType: "logistics.delivery_registered",
          aggregateType: "logistics_delivery",
          aggregateId: "delivery-1",
          correlationId: "corr-1"
        }
      }
    ]);
  });

  it("fails fast for unsupported events and invalid payloads", async () => {
    const handler = new LogisticsDeliveryRegisteredEmailHandler(
      {
        send: async () => undefined
      },
      { recipients: ["gmap-logistica@example.test"] }
    );

    await expect(handler.handle({ ...makeEvent(), eventType: "other.event" })).rejects.toThrow(
      /nao suportado/
    );
    await expect(
      handler.handle({ ...makeEvent(), payload: { deliveryId: "delivery-1" } })
    ).rejects.toThrow(/incompleto/);
  });

  it("fails when delivery email recipients are not configured", async () => {
    const handler = new LogisticsDeliveryRegisteredEmailHandler(
      {
        send: async () => undefined
      },
      { recipients: [" "] }
    );

    await expect(handler.handle(makeEvent())).rejects.toThrow(/Destinatarios/);
  });
});

function makeEvent(): OutboxEventRecord {
  return {
    id: "event-1",
    eventType: "logistics.delivery_registered",
    aggregateType: "logistics_delivery",
    aggregateId: "delivery-1",
    attempts: 0,
    payload: {
      deliveryId: "delivery-1",
      shipmentId: "shipment-1",
      acceptanceStatus: "TOTAL",
      deliveredAt: "2026-09-25T13:00:00.000Z",
      correlationId: "corr-1"
    }
  };
}
