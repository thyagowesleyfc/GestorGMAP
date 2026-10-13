import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { EmailMessage, EmailSender } from "../../../src/worker/email/email-sender";
import { createLogisticsOutboxWorker } from "../../../src/worker/outbox/create-logistics-outbox-worker";
import type { OutboxEventRecord } from "../../../src/worker/outbox/process-outbox-events";

describe("create logistics outbox worker", () => {
  it("wires delivery emails, recollection and request notifications into the logistics outbox handler", async () => {
    const sent: EmailMessage[] = [];
    const notificationQueries: Array<{ text: string; values: unknown[] | undefined }> = [];
    const emailSender: EmailSender = {
      send: async (message) => {
        sent.push(message);
      }
    };
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        notificationQueries.push({ text, values });
        return { rows: [] };
      }
    } as unknown as Pool;
    const worker = createLogisticsOutboxWorker({
      pool,
      emailSender,
      deliveryEmailRecipients: ["gmap-logistica@example.test"],
      managementTargetTeamContext: "GERENCIA_MATERIAIS"
    });

    await worker.handler.handle(deliveryEvent());
    await worker.handler.handle(recollectionEvent());
    await worker.handler.handle(materialRequestFinalizedEvent());

    expect(worker.processor).toBeDefined();
    expect(sent).toEqual([
      expect.objectContaining({
        to: ["gmap-logistica@example.test"],
        subject: "Entrega registrada no GESTOR GMAP: TOTAL"
      })
    ]);
    expect(notificationQueries).toEqual([
      expect.objectContaining({
        values: expect.arrayContaining([
          "GERENCIA_MATERIAIS",
          "Entrega registrada",
          "logistics_delivery",
          "delivery-1",
          "corr-delivery-1"
        ])
      }),
      expect.objectContaining({
        values: expect.arrayContaining([
          "GERENCIA_MATERIAIS",
          "Recolha executada",
          "logistics_recollection",
          "recollection-1",
          "corr-recollection-1"
        ])
      }),
      expect.objectContaining({
        values: expect.arrayContaining([
          "GERENCIA_MATERIAIS",
          "Solicitação finalizada",
          "material_request",
          "solicitacao-1",
          "corr-solicitacao-1"
        ])
      })
    ]);
  });

  it("keeps unsupported logistics events visible to the outbox retry policy", async () => {
    const worker = createLogisticsOutboxWorker({
      pool: { query: async () => ({ rows: [] }) } as unknown as Pool,
      emailSender: { send: async () => undefined },
      deliveryEmailRecipients: ["gmap-logistica@example.test"],
      managementTargetTeamContext: "GERENCIA_MATERIAIS"
    });

    await expect(worker.handler.handle(unknownEvent())).rejects.toThrow(/sem handler configurado/);
  });
});

function deliveryEvent(): OutboxEventRecord {
  return {
    id: "event-delivery-1",
    eventType: "logistics.delivery_registered",
    aggregateType: "logistics_delivery",
    aggregateId: "delivery-1",
    attempts: 0,
    payload: {
      deliveryId: "delivery-1",
      shipmentId: "shipment-1",
      acceptanceStatus: "TOTAL",
      deliveredAt: "2026-09-25T13:00:00.000Z",
      correlationId: "corr-delivery-1"
    }
  };
}

function recollectionEvent(): OutboxEventRecord {
  return {
    id: "event-recollection-1",
    eventType: "logistics.recollection_executed",
    aggregateType: "logistics_recollection",
    aggregateId: "recollection-1",
    attempts: 0,
    payload: {
      recollectionId: "recollection-1",
      status: "EXECUTADA",
      executedAt: "2026-09-25T20:20:00.000Z",
      correlationId: "corr-recollection-1"
    }
  };
}

function materialRequestFinalizedEvent(): OutboxEventRecord {
  return {
    id: "event-solicitacao-1",
    eventType: "requests.material_request_finalized",
    aggregateType: "material_request",
    aggregateId: "solicitacao-1",
    attempts: 0,
    payload: {
      materialRequestId: "solicitacao-1",
      status: "FINALIZADA",
      finalizedAt: "2026-09-25T15:00:00.000Z",
      shipmentCount: 2,
      correlationId: "corr-solicitacao-1"
    }
  };
}

function unknownEvent(): OutboxEventRecord {
  return {
    id: "event-unknown-1",
    eventType: "logistics.unknown",
    aggregateType: "logistics_delivery",
    aggregateId: "unknown-1",
    attempts: 0,
    payload: {}
  };
}
