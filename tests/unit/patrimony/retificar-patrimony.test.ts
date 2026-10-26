import { describe, expect, it, vi } from "vitest";

import {
  RetificarPatrimony,
  type PatrimonyRetifier
} from "../../../src/modules/patrimony/application/retificar-patrimony";

describe("retificar patrimony", () => {
  it("rejects an incomplete command before reaching persistence", async () => {
    const retifier: PatrimonyRetifier = { retificar: vi.fn() };
    const useCase = new RetificarPatrimony(retifier);

    await expect(
      useCase.execute({
        commandId: " ",
        patrimonyId: "patrimony-1",
        correctedMaterialSingularId: "material-2",
        reason: "Corrigir cadastro",
        actorUserId: "user-1",
        teamContext: "Patrimônio"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    expect(retifier.retificar).not.toHaveBeenCalled();
  });

  it("normalizes the correction and supplies a correlation id", async () => {
    const result = {
      ok: true as const,
      patrimonyId: "patrimony-1",
      previousMaterialSingularId: "material-1",
      materialSingularId: "material-2",
      tombo: "011-01-000001"
    };
    const retifier: PatrimonyRetifier = {
      retificar: vi.fn().mockResolvedValue(result)
    };
    const useCase = new RetificarPatrimony(retifier);

    await expect(
      useCase.execute({
        commandId: " command-1 ",
        patrimonyId: " patrimony-1 ",
        correctedMaterialSingularId: " material-2 ",
        correctedAt: new Date("2026-10-26T16:00:00.000Z"),
        reason: " Corrigir cadastro do material ",
        actorUserId: " user-1 ",
        teamContext: " Patrimônio ",
        correlationId: " correlation-1 "
      })
    ).resolves.toEqual(result);

    expect(retifier.retificar).toHaveBeenCalledWith({
      commandId: "command-1",
      patrimonyId: "patrimony-1",
      correctedMaterialSingularId: "material-2",
      correctedAt: new Date("2026-10-26T16:00:00.000Z"),
      correctedAtWasProvided: true,
      reason: "Corrigir cadastro do material",
      actorUserId: "user-1",
      teamContext: "Patrimônio",
      correlationId: "correlation-1"
    });
  });
});
