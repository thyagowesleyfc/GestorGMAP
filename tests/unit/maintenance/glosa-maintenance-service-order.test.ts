import { describe, expect, it, vi } from "vitest";

import {
  GlosaMaintenanceServiceOrder,
  type GlosaMaintenanceServiceOrderInput,
  type MaintenanceServiceOrderGlosser
} from "../../../src/modules/maintenance/application/glosa-maintenance-service-order";

const baseInput: GlosaMaintenanceServiceOrderInput = {
  commandId: " command-1 ",
  serviceOrderId: " service-order-1 ",
  lines: [
    { serviceOrderServiceId: " service-1 ", quantity: 1 },
    { serviceOrderServiceId: " service-2 ", quantity: 2 }
  ],
  actorUserId: " user-1 ",
  teamContext: " Patrimônio ",
  glosaAt: new Date("2026-11-12T12:00:00.000Z"),
  correlationId: " correlation-1 "
};

function createUseCase(result: Awaited<ReturnType<MaintenanceServiceOrderGlosser["glosa"]>>) {
  const glosser: MaintenanceServiceOrderGlosser = {
    glosa: vi.fn().mockResolvedValue(result)
  };

  return { glosser, useCase: new GlosaMaintenanceServiceOrder(glosser) };
}

describe("glosa maintenance service order", () => {
  it("normalizes multiple lines and propagates a partial glosa success", async () => {
    const glosserResult = {
      ok: true as const,
      serviceOrderId: "service-order-1",
      status: "CONCLUIDA_COM_GLOSA_PARCIAL" as const,
      totalGlosaAmount: "2500.00"
    };
    const { glosser, useCase } = createUseCase(glosserResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(glosserResult);

    expect(glosser.glosa).toHaveBeenCalledWith({
      commandId: "command-1",
      serviceOrderId: "service-order-1",
      lines: [
        { serviceOrderServiceId: "service-1", quantity: 1 },
        { serviceOrderServiceId: "service-2", quantity: 2 }
      ],
      actorUserId: "user-1",
      teamContext: "Patrimônio",
      glosaAt: baseInput.glosaAt,
      correlationId: "correlation-1"
    });
  });

  it("defaults glosaAt and correlationId before calling the port", async () => {
    const now = new Date("2026-11-12T13:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const { glosser, useCase } = createUseCase({
        ok: true,
        serviceOrderId: "service-order-1",
        status: "CONCLUIDA_COM_GLOSA_TOTAL",
        totalGlosaAmount: "3750.00"
      });

      await useCase.execute({ ...baseInput, glosaAt: undefined, correlationId: "   " });

      expect(glosser.glosa).toHaveBeenCalledWith(
        expect.objectContaining({ glosaAt: now, correlationId: "command-1" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["commandId", { commandId: " " }, "INVALID_COMMAND_ID"],
    ["service order id", { serviceOrderId: " " }, "INVALID_SERVICE_ORDER_ID"],
    ["lines", { lines: [] }, "EMPTY_GLOSA_LINES"],
    [
      "line service order service id",
      { lines: [{ serviceOrderServiceId: " ", quantity: 1 }] },
      "INVALID_SERVICE_ORDER_LINE_ID"
    ],
    [
      "duplicate line",
      {
        lines: [
          { serviceOrderServiceId: "service-1", quantity: 1 },
          { serviceOrderServiceId: "service-1", quantity: 2 }
        ]
      },
      "DUPLICATE_SERVICE_ORDER_LINE"
    ],
    [
      "non-integer quantity",
      { lines: [{ serviceOrderServiceId: "service-1", quantity: 1.5 }] },
      "INVALID_GLOSA_QUANTITY"
    ],
    [
      "non-positive quantity",
      { lines: [{ serviceOrderServiceId: "service-1", quantity: 0 }] },
      "INVALID_GLOSA_QUANTITY"
    ],
    ["date", { glosaAt: new Date("invalid") }, "INVALID_GLOSA_AT"],
    ["actor", { actorUserId: " " }, "INVALID_ACTOR_USER_ID"],
    ["blank team context", { teamContext: " " }, "INVALID_TEAM_CONTEXT"],
    ["wrong team context", { teamContext: "Manutenção" }, "INVALID_TEAM_CONTEXT"]
  ])("rejects an invalid %s before calling the port", async (_field, override, reason) => {
    const { glosser, useCase } = createUseCase({
      ok: true,
      serviceOrderId: "unused",
      status: "CONCLUIDA_COM_GLOSA_PARCIAL",
      totalGlosaAmount: "0.00"
    });

    await expect(useCase.execute({ ...baseInput, ...override })).resolves.toMatchObject({
      ok: false,
      reason
    });
    expect(glosser.glosa).not.toHaveBeenCalled();
  });

  it.each([
    [
      "service order not glossable",
      {
        ok: false as const,
        reason: "SERVICE_ORDER_NOT_GLOSSABLE" as const,
        serviceOrderId: "service-order-1"
      }
    ],
    [
      "actor not authorized",
      {
        ok: false as const,
        reason: "ACTOR_NOT_AUTHORIZED" as const,
        serviceOrderId: "service-order-1"
      }
    ]
  ])("propagates the port %s failure without masking it", async (_label, glosserResult) => {
    const { glosser, useCase } = createUseCase(glosserResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(glosserResult);
    expect(glosser.glosa).toHaveBeenCalledOnce();
  });
});
