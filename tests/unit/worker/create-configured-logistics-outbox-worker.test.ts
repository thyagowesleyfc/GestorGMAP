import type { Pool, PoolConfig } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { SmtpMail } from "../../../src/worker/email/smtp-email-sender";
import { createConfiguredLogisticsOutboxWorker } from "../../../src/worker/outbox/create-configured-logistics-outbox-worker";
import type { OutboxEventRecord } from "../../../src/worker/outbox/process-outbox-events";

const DATABASE_URL = "postgresql://gestor_gmap:secret@127.0.0.1:55432/gestor_gmap?schema=public";

describe("create configured logistics outbox worker", () => {
  it("wires env config, PostgreSQL pool and SMTP sender into the logistics worker", async () => {
    const poolConfigs: PoolConfig[] = [];
    const notificationQueries: Array<{ text: string; values: unknown[] | undefined }> = [];
    const sent: SmtpMail[] = [];
    const end = vi.fn(async () => undefined);
    const poolFactory = vi.fn((config: PoolConfig) => {
      poolConfigs.push(config);
      return {
        query: async (text: string, values?: unknown[]) => {
          notificationQueries.push({ text, values });
          return { rows: [] };
        },
        end
      } as unknown as Pool;
    });
    const smtpTransportFactory = vi.fn(() => ({
      sendMail: async (message: SmtpMail) => {
        sent.push(message);
      }
    }));

    const worker = createConfiguredLogisticsOutboxWorker({
      env: {
        DATABASE_URL,
        GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS: "gmap-logistica@example.test",
        GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT: "GERENCIA_MATERIAIS",
        GMAP_OUTBOX_BATCH_SIZE: "15",
        GMAP_SMTP_HOST: "smtp.example.test",
        GMAP_SMTP_PORT: "587",
        GMAP_SMTP_SECURE: "false",
        GMAP_SMTP_FROM: "GMAP <gmap@example.test>",
        GMAP_SMTP_USERNAME: "user",
        GMAP_SMTP_PASSWORD: "secret"
      },
      poolFactory,
      smtpTransportFactory
    });

    await worker.handler.handle(deliveryEvent());
    await worker.close();

    expect(poolFactory).toHaveBeenCalledTimes(1);
    expect(poolConfigs).toEqual([{ connectionString: DATABASE_URL }]);
    expect(smtpTransportFactory).toHaveBeenCalledWith({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      auth: {
        user: "user",
        pass: "secret"
      }
    });
    expect(worker.config.batchSize).toBe(15);
    expect(notificationQueries).toEqual([
      expect.objectContaining({
        values: expect.arrayContaining([
          "GERENCIA_MATERIAIS",
          "Entrega registrada",
          "logistics_delivery",
          "delivery-1",
          "corr-delivery-1"
        ])
      })
    ]);
    expect(sent).toEqual([
      expect.objectContaining({
        from: "GMAP <gmap@example.test>",
        to: ["gmap-logistica@example.test"],
        subject: "Entrega registrada no GESTOR GMAP: TOTAL"
      })
    ]);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("fails before opening a pool when env config is incomplete", () => {
    const poolFactory = vi.fn();

    expect(() =>
      createConfiguredLogisticsOutboxWorker({
        env: {
          DATABASE_URL
        },
        poolFactory
      })
    ).toThrow(/GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS/);
    expect(poolFactory).not.toHaveBeenCalled();
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
