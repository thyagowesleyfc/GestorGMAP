import { describe, expect, it, vi } from "vitest";

import {
  RecolherPatrimony,
  type PatrimonyRecolhedor
} from "../../../src/modules/patrimony/application/recolher-patrimony";

describe("RecolherPatrimony", () => {
  it("rejeita comando sem identificador da recolha logística", async () => {
    const recolhedor: PatrimonyRecolhedor = { recolher: vi.fn() };
    const useCase = new RecolherPatrimony(recolhedor);

    await expect(
      useCase.execute({
        commandId: "command-1",
        patrimonyId: "patrimony-1",
        logisticsRecollectionId: " ",
        reason: "Recolha executada",
        actorUserId: "user-1",
        teamContext: "Patrimônio"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_LOGISTICS_RECOLLECTION_ID" });
    expect(recolhedor.recolher).not.toHaveBeenCalled();
  });

  it("normaliza a entrada e usa o command id como correlation id padrão", async () => {
    const recolhedor: PatrimonyRecolhedor = {
      recolher: vi.fn().mockResolvedValue({
        ok: true,
        movementId: "movement-1",
        patrimonyId: "patrimony-1",
        recollectionId: "recollection-1",
        fromEntityId: "entity-1",
        toEntityId: "entity-2"
      })
    };
    const useCase = new RecolherPatrimony(recolhedor);
    const occurredAt = new Date("2026-10-26T19:00:00.000Z");

    await expect(
      useCase.execute({
        commandId: " command-1 ",
        patrimonyId: " patrimony-1 ",
        logisticsRecollectionId: " recollection-1 ",
        occurredAt,
        reason: " Recolha executada ",
        actorUserId: " user-1 ",
        teamContext: " Patrimônio "
      })
    ).resolves.toEqual({
      ok: true,
      movementId: "movement-1",
      patrimonyId: "patrimony-1",
      recollectionId: "recollection-1",
      fromEntityId: "entity-1",
      toEntityId: "entity-2"
    });

    expect(recolhedor.recolher).toHaveBeenCalledWith({
      commandId: "command-1",
      patrimonyId: "patrimony-1",
      logisticsRecollectionId: "recollection-1",
      occurredAt,
      occurredAtWasProvided: true,
      reason: "Recolha executada",
      actorUserId: "user-1",
      teamContext: "Patrimônio",
      correlationId: "command-1"
    });
  });
});
