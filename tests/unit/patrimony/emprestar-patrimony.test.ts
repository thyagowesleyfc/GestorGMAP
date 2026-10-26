import { describe, expect, it, vi } from "vitest";

import {
  EmprestarPatrimony,
  type PatrimonyEmprestador
} from "../../../src/modules/patrimony/application/emprestar-patrimony";

describe("EmprestarPatrimony", () => {
  it("rejeita comando sem identificador", async () => {
    const emprestador: PatrimonyEmprestador = { emprestar: vi.fn() };
    const useCase = new EmprestarPatrimony(emprestador);

    await expect(
      useCase.execute({
        commandId: " ",
        patrimonyId: "patrimony-1",
        destinationEntityId: "entity-2",
        reason: "Uso temporário",
        actorUserId: "user-1",
        teamContext: "Patrimônio"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });
    expect(emprestador.emprestar).not.toHaveBeenCalled();
  });

  it("normaliza a entrada e usa o command id como correlation id padrão", async () => {
    const emprestador: PatrimonyEmprestador = {
      emprestar: vi.fn().mockResolvedValue({
        ok: true,
        movementId: "movement-1",
        patrimonyId: "patrimony-1",
        fromEntityId: "entity-1",
        toEntityId: "entity-2"
      })
    };
    const useCase = new EmprestarPatrimony(emprestador);
    const occurredAt = new Date("2026-10-26T18:00:00.000Z");

    await expect(
      useCase.execute({
        commandId: " command-1 ",
        patrimonyId: " patrimony-1 ",
        destinationEntityId: " entity-2 ",
        occurredAt,
        reason: " Uso temporário ",
        actorUserId: " user-1 ",
        teamContext: " Patrimônio "
      })
    ).resolves.toEqual({
      ok: true,
      movementId: "movement-1",
      patrimonyId: "patrimony-1",
      fromEntityId: "entity-1",
      toEntityId: "entity-2"
    });

    expect(emprestador.emprestar).toHaveBeenCalledWith({
      commandId: "command-1",
      patrimonyId: "patrimony-1",
      destinationEntityId: "entity-2",
      occurredAt,
      occurredAtWasProvided: true,
      reason: "Uso temporário",
      actorUserId: "user-1",
      teamContext: "Patrimônio",
      correlationId: "command-1"
    });
  });
});
