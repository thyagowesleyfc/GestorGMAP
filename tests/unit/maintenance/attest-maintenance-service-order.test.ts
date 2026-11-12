import { describe, expect, it, vi } from "vitest";

import {
  AttestMaintenanceServiceOrder,
  type AttestMaintenanceServiceOrderInput,
  type MaintenanceServiceOrderAttester
} from "../../../src/modules/maintenance/application/attest-maintenance-service-order";

const baseInput: AttestMaintenanceServiceOrderInput = {
  commandId: " command-1 ",
  serviceOrderId: " service-order-1 ",
  attestedAt: new Date("2026-11-12T12:00:00.000Z"),
  actorUserId: " user-1 ",
  teamContext: " maintenance ",
  correlationId: " correlation-1 "
};

function createUseCase(result: Awaited<ReturnType<MaintenanceServiceOrderAttester["attest"]>>) {
  const attester: MaintenanceServiceOrderAttester = {
    attest: vi.fn().mockResolvedValue(result)
  };

  return { attester, useCase: new AttestMaintenanceServiceOrder(attester) };
}

describe("attest maintenance service order", () => {
  it("normalizes the command, forwards the idempotency key and returns ATESTADA", async () => {
    const attesterResult = {
      ok: true as const,
      serviceOrderId: "service-order-1",
      status: "ATESTADA" as const
    };
    const { attester, useCase } = createUseCase(attesterResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(attesterResult);

    expect(attester.attest).toHaveBeenCalledWith({
      commandId: "command-1",
      serviceOrderId: "service-order-1",
      attestedAt: baseInput.attestedAt,
      actorUserId: "user-1",
      teamContext: "maintenance",
      correlationId: "correlation-1"
    });
  });

  it("defaults attestedAt to the current date and correlationId to commandId", async () => {
    const now = new Date("2026-11-12T13:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const { attester, useCase } = createUseCase({
        ok: true,
        serviceOrderId: "service-order-1",
        status: "ATESTADA"
      });

      await useCase.execute({ ...baseInput, attestedAt: undefined, correlationId: "   " });

      expect(attester.attest).toHaveBeenCalledWith(
        expect.objectContaining({
          attestedAt: now,
          correlationId: "command-1"
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["commandId", { commandId: " " }, "INVALID_COMMAND_ID"],
    ["service order id", { serviceOrderId: " " }, "INVALID_SERVICE_ORDER_ID"],
    ["date", { attestedAt: new Date("invalid") }, "INVALID_ATTESTED_AT"],
    ["actor", { actorUserId: " " }, "INVALID_ACTOR_USER_ID"],
    ["team context", { teamContext: " " }, "INVALID_TEAM_CONTEXT"]
  ])("rejects an invalid %s before attesting", async (_field, override, reason) => {
    const { attester, useCase } = createUseCase({
      ok: true,
      serviceOrderId: "unused",
      status: "ATESTADA"
    });

    await expect(useCase.execute({ ...baseInput, ...override })).resolves.toMatchObject({
      ok: false,
      reason
    });
    expect(attester.attest).not.toHaveBeenCalled();
  });

  it.each([
    [
      "idempotency conflict",
      {
        ok: false as const,
        reason: "IDEMPOTENCY_KEY_CONFLICT" as const,
        serviceOrderId: "service-order-1"
      }
    ],
    [
      "service order not attestable",
      {
        ok: false as const,
        reason: "SERVICE_ORDER_NOT_ATTESTABLE" as const,
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
  ])("propagates the attester %s failure without masking it", async (_label, attesterResult) => {
    const { useCase } = createUseCase(attesterResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(attesterResult);
  });
});
