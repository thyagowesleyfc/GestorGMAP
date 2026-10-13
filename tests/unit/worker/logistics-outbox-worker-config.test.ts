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
        GMAP_OUTBOX_BATCH_SIZE: "25",
        ...smtpEnv()
      })
    ).toEqual({
      databaseUrl: DATABASE_URL,
      deliveryEmailRecipients: ["gmap-logistica@example.test", "gerencia@example.test"],
      managementTargetTeamContext: "GERENCIA_MATERIAIS",
      batchSize: 25,
      smtpEmail: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        from: "GMAP <gmap@example.test>",
        username: "user",
        password: "secret"
      }
    });
  });

  it("uses the default batch size when it is omitted", () => {
    expect(
      resolveLogisticsOutboxWorkerConfig({
        DATABASE_URL,
        GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS: "gmap-logistica@example.test",
        GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT: "GERENCIA_MATERIAIS",
        ...smtpEnv()
      }).batchSize
    ).toBe(10);
  });

  it("fails fast when required settings are missing", () => {
    expect(() => resolveLogisticsOutboxWorkerConfig({})).toThrow(/DATABASE_URL/);
    expect(() =>
      resolveLogisticsOutboxWorkerConfig({
        DATABASE_URL,
        GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT: "GERENCIA_MATERIAIS",
        ...smtpEnv()
      })
    ).toThrow(/GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS/);
    expect(() =>
      resolveLogisticsOutboxWorkerConfig({
        DATABASE_URL,
        GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS: "gmap-logistica@example.test",
        ...smtpEnv()
      })
    ).toThrow(/GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT/);
    expect(() =>
      resolveLogisticsOutboxWorkerConfig({
        DATABASE_URL,
        GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS: "gmap-logistica@example.test",
        GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT: "GERENCIA_MATERIAIS"
      })
    ).toThrow(/GMAP_SMTP_HOST/);
  });

  it("rejects invalid batch sizes", () => {
    for (const batchSize of ["0", "101", "1.5", "abc"]) {
      expect(() =>
        resolveLogisticsOutboxWorkerConfig({
          DATABASE_URL,
          GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS: "gmap-logistica@example.test",
          GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT: "GERENCIA_MATERIAIS",
          GMAP_OUTBOX_BATCH_SIZE: batchSize,
          ...smtpEnv()
        })
      ).toThrow(/GMAP_OUTBOX_BATCH_SIZE/);
    }
  });
});

function smtpEnv(): Record<string, string> {
  return {
    GMAP_SMTP_HOST: "smtp.example.test",
    GMAP_SMTP_PORT: "587",
    GMAP_SMTP_SECURE: "false",
    GMAP_SMTP_FROM: "GMAP <gmap@example.test>",
    GMAP_SMTP_USERNAME: "user",
    GMAP_SMTP_PASSWORD: "secret"
  };
}
