import { describe, expect, it, vi } from "vitest";

import {
  LinkMaintenanceRequestPatrimonyTargets,
  type LinkMaintenanceRequestPatrimonyTargetsInput,
  type MaintenanceRequestPatrimonyTargetLinker
} from "../../../src/modules/maintenance/application/link-maintenance-request-patrimony-targets";

const baseInput: LinkMaintenanceRequestPatrimonyTargetsInput = {
  commandId: " command-1 ",
  maintenanceRequestId: " maintenance-request-1 ",
  patrimonyIds: [" patrimony-1 ", "patrimony-2"],
  linkedAt: new Date("2026-11-10T12:00:00.000Z"),
  actorUserId: " user-1 ",
  teamContext: " Patrimônio ",
  correlationId: " correlation-1 "
};

function createUseCase(
  result: Awaited<ReturnType<MaintenanceRequestPatrimonyTargetLinker["link"]>>
) {
  const linker: MaintenanceRequestPatrimonyTargetLinker = {
    link: vi.fn().mockResolvedValue(result)
  };

  return { linker, useCase: new LinkMaintenanceRequestPatrimonyTargets(linker) };
}

describe("link maintenance request patrimony targets", () => {
  it("normalizes IDs and correlationId before propagating the linker result", async () => {
    const linkerResult = {
      ok: true as const,
      maintenanceRequestId: "maintenance-request-1",
      status: "EM_ANALISE" as const,
      linkedPatrimonyIds: ["patrimony-1", "patrimony-2"],
      linkedCount: 2
    };
    const { linker, useCase } = createUseCase(linkerResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(linkerResult);

    expect(linker.link).toHaveBeenCalledWith({
      commandId: "command-1",
      maintenanceRequestId: "maintenance-request-1",
      patrimonyIds: ["patrimony-1", "patrimony-2"],
      linkedAt: baseInput.linkedAt,
      actorUserId: "user-1",
      teamContext: "Patrimônio",
      correlationId: "correlation-1"
    });
  });

  it("defaults linkedAt and correlationId", async () => {
    const now = new Date("2026-11-10T13:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const { linker, useCase } = createUseCase({
        ok: true,
        maintenanceRequestId: "maintenance-request-1",
        status: "EM_ANALISE",
        linkedPatrimonyIds: ["patrimony-1"],
        linkedCount: 1
      });

      await useCase.execute({ ...baseInput, linkedAt: undefined, correlationId: "   " });

      expect(linker.link).toHaveBeenCalledWith(
        expect.objectContaining({ linkedAt: now, correlationId: "command-1" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["commandId", { commandId: " " }, "INVALID_COMMAND_ID"],
    ["maintenance request id", { maintenanceRequestId: " " }, "INVALID_MAINTENANCE_REQUEST_ID"],
    ["actor", { actorUserId: " " }, "INVALID_ACTOR_USER_ID"],
    ["team context", { teamContext: " " }, "INVALID_TEAM_CONTEXT"],
    ["date", { linkedAt: new Date("invalid") }, "INVALID_LINKED_AT"]
  ])("rejects an invalid %s before linking", async (_field, override, reason) => {
    const { linker, useCase } = createUseCase({
      ok: true,
      maintenanceRequestId: "unused",
      status: "EM_ANALISE",
      linkedPatrimonyIds: [],
      linkedCount: 0
    });

    await expect(useCase.execute({ ...baseInput, ...override })).resolves.toEqual({
      ok: false,
      reason
    });
    expect(linker.link).not.toHaveBeenCalled();
  });

  it.each([
    ["empty list", [], "EMPTY_PATRIMONY_TARGETS"],
    ["empty ID", ["patrimony-1", " "], "INVALID_PATRIMONY_ID"],
    ["duplicate ID", ["patrimony-1", " patrimony-1 "], "DUPLICATE_PATRIMONY_TARGET"]
  ])("rejects %s before linking", async (_case, patrimonyIds, reason) => {
    const { linker, useCase } = createUseCase({
      ok: true,
      maintenanceRequestId: "unused",
      status: "EM_ANALISE",
      linkedPatrimonyIds: [],
      linkedCount: 0
    });

    await expect(useCase.execute({ ...baseInput, patrimonyIds })).resolves.toMatchObject({
      ok: false,
      reason
    });
    expect(linker.link).not.toHaveBeenCalled();
  });
});
