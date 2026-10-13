import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { MaterialRequestFinalizedNotificationHandler } from "../../../src/worker/outbox/material-request-finalized-notification-handler";
import type { OutboxEventRecord } from "../../../src/worker/outbox/process-outbox-events";

describe("material request finalized notification handler", () => {
  it("creates an idempotent management notification", async () => {
    const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
    const handler = new MaterialRequestFinalizedNotificationHandler(
      {
        query: async (text: string, values?: unknown[]) => {
          queries.push({ text, values });
          return { rows: [] };
        }
      } as unknown as Pool,
      { targetTeamContext: " GERENCIA_MATERIAIS " }
    );

    await handler.handle(makeEvent());

    expect(queries).toEqual([
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
    expect(queries[0].text).toContain("where not exists");
  });

  it("rejects unsupported event shape and incomplete payload", async () => {
    const handler = new MaterialRequestFinalizedNotificationHandler(
      { query: async () => ({ rows: [] }) } as unknown as Pool,
      { targetTeamContext: "GERENCIA_MATERIAIS" }
    );

    await expect(
      handler.handle({ ...makeEvent(), eventType: "requests.material_request_created" })
    ).rejects.toThrow(/Evento de Outbox nao suportado/);
    await expect(
      handler.handle({ ...makeEvent(), aggregateType: "logistics_delivery" })
    ).rejects.toThrow(/Aggregate de Outbox invalido/);
    await expect(
      handler.handle({
        ...makeEvent(),
        payload: { materialRequestId: "solicitacao-1", status: "DESPACHADA" }
      })
    ).rejects.toThrow(/Payload de solicitacao finalizada incompleto/);
    await expect(
      handler.handle({
        ...makeEvent(),
        aggregateId: "solicitacao-divergente"
      })
    ).rejects.toThrow(/diverge do aggregate/);
  });

  it("requires a management target team context", async () => {
    const handler = new MaterialRequestFinalizedNotificationHandler(
      { query: async () => ({ rows: [] }) } as unknown as Pool,
      { targetTeamContext: " " }
    );

    await expect(handler.handle(makeEvent())).rejects.toThrow(/Gerencia nao configurado/);
  });
});

function makeEvent(): OutboxEventRecord {
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
