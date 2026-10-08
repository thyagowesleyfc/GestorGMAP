import { describe, expect, it } from "vitest";

import { resolveLogisticsOutboxWorkerConfig } from "../../../src/worker/outbox/logistics-outbox-worker-config";

const DATABASE_URL = "postgresql://gestor_gmap:secret@127.0.0.1:55432/gestor_gmap?schema=public";

describe("logistics outbox worker config", () => {
  it("resolves required logistics outbox settings from env", () => {
    expect(
      resolveLogisticsOutboxWorkerConfig({
        DATABASE_URL,
        GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS:
          " gmap-logistica@example.test, gerencia@example.test , ",
        GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT: " GERENCIA_MATERIAIS ",
        GMAP_OUTBOX_BATCH_SIZE: "25"
      })
    ).toEqual({
      databaseUrl: DATABASE_URL,
      deliveryEmailRecipients: ["gmap-logistica@example.test", "gerencia@example.test"],
      managementTargetTeamContext: "GERENCIA_MATERIAIS",
      batchSize: 25
    });
  });

  it("uses the default batch size when it is omitted", () => {
    expect(
      resolveLogisticsOutboxWorkerConfig({
        DATABASE_URL,
        GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS: "gmap-logistica@example.test",
        GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT: "GERENCIA_MATERIAIS"
      }).batchSize
    ).toBe(10);
  });

  it("fails fast when required settings are missing", () => {
    expect(() => resolveLogisticsOutboxWorkerConfig({})).toThrow(/DATABASE_URL/);
    expect(() =>
      resolveLogisticsOutboxWorkerConfig({
        DATABASE_URL,
        GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT: "GERENCIA_MATERIAIS"
      })
    ).toThrow(/GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS/);
    expect(() =>
      resolveLogisticsOutboxWorkerConfig({
        DATABASE_URL,
        GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS: "gmap-logistica@example.test"
      })
    ).toThrow(/GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT/);
  });

  it("rejects invalid batch sizes", () => {
    for (const batchSize of ["0", "101", "1.5", "abc"]) {
      expect(() =>
        resolveLogisticsOutboxWorkerConfig({
          DATABASE_URL,
          GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS: "gmap-logistica@example.test",
          GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT: "GERENCIA_MATERIAIS",
          GMAP_OUTBOX_BATCH_SIZE: batchSize
        })
      ).toThrow(/GMAP_OUTBOX_BATCH_SIZE/);
    }
  });
});
