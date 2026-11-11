import { describe, expect, it, vi } from "vitest";

import {
  SendMaintenanceServiceOrder,
  type MaintenanceServiceOrderSender,
  type SendMaintenanceServiceOrderInput
} from "../../../src/modules/maintenance/application/send-maintenance-service-order";

const baseInput: SendMaintenanceServiceOrderInput = {
  commandId: " command-1 ",
  serviceOrderId: " service-order-1 ",
  sentAt: new Date("2026-11-11T12:00:00.000Z"),
  actorUserId: " user-1 ",
  teamContext: " Manutenção ",
  correlationId: " correlation-1 "
};

function createUseCase(result: Awaited<ReturnType<MaintenanceServiceOrderSender["send"]>>) {
  const sender: MaintenanceServiceOrderSender = {
    send: vi.fn().mockResolvedValue(result)
  };

  return { sender, useCase: new SendMaintenanceServiceOrder(sender) };
}

describe("send maintenance service order", () => {
  it("normalizes the command and propagates the sender result", async () => {
    const senderResult = {
      ok: true as const,
      serviceOrderId: "service-order-1",
      status: "ENVIADA_AO_PRESTADOR" as const
    };
    const { sender, useCase } = createUseCase(senderResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(senderResult);

    expect(sender.send).toHaveBeenCalledWith({
      commandId: "command-1",
      serviceOrderId: "service-order-1",
      sentAt: baseInput.sentAt,
      actorUserId: "user-1",
      teamContext: "Manutenção",
      correlationId: "correlation-1"
    });
  });

  it("defaults sentAt to the current date and correlationId to commandId", async () => {
    const now = new Date("2026-11-11T13:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const { sender, useCase } = createUseCase({
        ok: true,
        serviceOrderId: "service-order-1",
        status: "ENVIADA_AO_PRESTADOR"
      });

      await useCase.execute({ ...baseInput, sentAt: undefined, correlationId: "   " });

      expect(sender.send).toHaveBeenCalledWith(
        expect.objectContaining({
          sentAt: now,
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
    ["date", { sentAt: new Date("invalid") }, "INVALID_SENT_AT"],
    ["actor", { actorUserId: " " }, "INVALID_ACTOR_USER_ID"],
    ["team context", { teamContext: " " }, "INVALID_TEAM_CONTEXT"]
  ])("rejects an invalid %s before sending", async (_field, override, reason) => {
    const { sender, useCase } = createUseCase({
      ok: true,
      serviceOrderId: "unused",
      status: "ENVIADA_AO_PRESTADOR"
    });

    await expect(useCase.execute({ ...baseInput, ...override })).resolves.toMatchObject({
      ok: false,
      reason
    });
    expect(sender.send).not.toHaveBeenCalled();
  });
});
