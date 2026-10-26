import { describe, expect, it, vi } from "vitest";

import {
  RemanejarPatrimony,
  type PatrimonyRemanejador
} from "../../../src/modules/patrimony/application/remanejar-patrimony";

describe("remanejar patrimony", () => {
  it("rejects an incomplete command before reaching persistence", async () => {
    const remanejador: PatrimonyRemanejador = { remanejar: vi.fn() };
    const useCase = new RemanejarPatrimony(remanejador);

    await expect(
      useCase.execute({
        commandId: " ",
        patrimonyId: "patrimony-1",
        destinationEntityId: "entity-2",
        reason: "Remanejamento",
        actorUserId: "user-1",
        teamContext: "Patrimônio"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    expect(remanejador.remanejar).not.toHaveBeenCalled();
  });

  it("normalizes the command and supplies a correlation id", async () => {
    const result = {
      ok: true as const,
      movementId: "movement-1",
      patrimonyId: "patrimony-1",
      fromEntityId: "entity-1",
      toEntityId: "entity-2"
    };
    const remanejador: PatrimonyRemanejador = {
      remanejar: vi.fn().mockResolvedValue(result)
    };
    const useCase = new RemanejarPatrimony(remanejador);

    await expect(
      useCase.execute({
        commandId: " command-1 ",
        patrimonyId: " patrimony-1 ",
        destinationEntityId: " entity-2 ",
        occurredAt: new Date("2026-10-26T17:00:00.000Z"),
        reason: " Remanejamento para nova entidade ",
        actorUserId: " user-1 ",
        teamContext: " Patrimônio ",
        correlationId: " correlation-1 "
      })
    ).resolves.toEqual(result);

    expect(remanejador.remanejar).toHaveBeenCalledWith({
      commandId: "command-1",
      patrimonyId: "patrimony-1",
      destinationEntityId: "entity-2",
      occurredAt: new Date("2026-10-26T17:00:00.000Z"),
      occurredAtWasProvided: true,
      reason: "Remanejamento para nova entidade",
      actorUserId: "user-1",
      teamContext: "Patrimônio",
      correlationId: "correlation-1"
    });
  });
});
