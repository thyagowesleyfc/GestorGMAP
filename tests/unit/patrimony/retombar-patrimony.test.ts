import { describe, expect, it, vi } from "vitest";

import {
  RetombarPatrimony,
  type PatrimonyRetomber
} from "../../../src/modules/patrimony/application/retombar-patrimony";

describe("retombar patrimony", () => {
  it("rejects an incomplete command before reaching persistence", async () => {
    const retomber: PatrimonyRetomber = { retombar: vi.fn() };
    const useCase = new RetombarPatrimony(retomber);

    await expect(
      useCase.execute({
        commandId: " ",
        patrimonyId: "patrimony-1",
        reason: "Retombamento",
        actorUserId: "user-1",
        teamContext: "Patrimônio"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    expect(retomber.retombar).not.toHaveBeenCalled();
  });

  it("normalizes the command and supplies a correlation id", async () => {
    const result = {
      ok: true as const,
      patrimonyId: "patrimony-1",
      previousTombo: "011-01-000001",
      tombo: "011-01-000002",
      patrimonialGroupCode: "01"
    };
    const retomber: PatrimonyRetomber = {
      retombar: vi.fn().mockResolvedValue(result)
    };
    const useCase = new RetombarPatrimony(retomber);

    await expect(
      useCase.execute({
        commandId: " command-1 ",
        patrimonyId: " patrimony-1 ",
        retombedAt: new Date("2026-10-26T15:00:00.000Z"),
        reason: " Retombamento por dano na identificação ",
        actorUserId: " user-1 ",
        teamContext: " Patrimônio ",
        correlationId: " correlation-1 "
      })
    ).resolves.toEqual(result);

    expect(retomber.retombar).toHaveBeenCalledWith({
      commandId: "command-1",
      patrimonyId: "patrimony-1",
      retombedAt: new Date("2026-10-26T15:00:00.000Z"),
      retombedAtWasProvided: true,
      reason: "Retombamento por dano na identificação",
      actorUserId: "user-1",
      teamContext: "Patrimônio",
      correlationId: "correlation-1"
    });
  });
});
