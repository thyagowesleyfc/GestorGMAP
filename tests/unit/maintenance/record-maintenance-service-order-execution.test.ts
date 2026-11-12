import { describe, expect, it, vi } from "vitest";

import {
  RecordMaintenanceServiceOrderExecution,
  type MaintenanceServiceOrderExecutionRecorder,
  type RecordMaintenanceServiceOrderExecutionInput
} from "../../../src/modules/maintenance/application/record-maintenance-service-order-execution";

const baseInput: RecordMaintenanceServiceOrderExecutionInput = {
  commandId: " command-1 ",
  serviceOrderId: " service-order-1 ",
  executedAt: new Date("2026-11-12T12:00:00.000Z"),
  actorUserId: " user-1 ",
  teamContext: " maintenance ",
  correlationId: " correlation-1 "
};

function createUseCase(
  result: Awaited<ReturnType<MaintenanceServiceOrderExecutionRecorder["record"]>>
) {
  const recorder: MaintenanceServiceOrderExecutionRecorder = {
    record: vi.fn().mockResolvedValue(result)
  };

  return { recorder, useCase: new RecordMaintenanceServiceOrderExecution(recorder) };
}

describe("record maintenance service order execution", () => {
  it("normalizes the command and propagates the recorder result", async () => {
    const recorderResult = {
      ok: true as const,
      serviceOrderId: "service-order-1",
      status: "EXECUTADA" as const
    };
    const { recorder, useCase } = createUseCase(recorderResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(recorderResult);

    expect(recorder.record).toHaveBeenCalledWith({
      commandId: "command-1",
      serviceOrderId: "service-order-1",
      executedAt: baseInput.executedAt,
      actorUserId: "user-1",
      teamContext: "maintenance",
      correlationId: "correlation-1"
    });
  });

  it("defaults executedAt to the current date and correlationId to commandId", async () => {
    const now = new Date("2026-11-12T13:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const { recorder, useCase } = createUseCase({
        ok: true,
        serviceOrderId: "service-order-1",
        status: "EXECUTADA"
      });

      await useCase.execute({ ...baseInput, executedAt: undefined, correlationId: "   " });

      expect(recorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          executedAt: now,
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
    ["date", { executedAt: new Date("invalid") }, "INVALID_EXECUTED_AT"],
    ["actor", { actorUserId: " " }, "INVALID_ACTOR_USER_ID"],
    ["team context", { teamContext: " " }, "INVALID_TEAM_CONTEXT"]
  ])("rejects an invalid %s before recording", async (_field, override, reason) => {
    const { recorder, useCase } = createUseCase({
      ok: true,
      serviceOrderId: "unused",
      status: "EXECUTADA"
    });

    await expect(useCase.execute({ ...baseInput, ...override })).resolves.toMatchObject({
      ok: false,
      reason
    });
    expect(recorder.record).not.toHaveBeenCalled();
  });
});
