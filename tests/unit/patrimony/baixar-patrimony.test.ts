import { describe, expect, it, vi } from "vitest";

import {
  BaixarPatrimony,
  type PatrimonyBaixador
} from "../../../src/modules/patrimony/application/baixar-patrimony";

describe("BaixarPatrimony", () => {
  it("encaminha inservibilidade sem referência para validação condicional", async () => {
    const baixador: PatrimonyBaixador = {
      baixar: vi.fn().mockResolvedValue({
        ok: false,
        reason: "INVALID_PROCEDURE_OR_REPORT_REFERENCE",
        patrimonyId: "patrimony-1"
      })
    };
    const useCase = new BaixarPatrimony(baixador);

    await expect(
      useCase.execute({
        commandId: "command-1",
        patrimonyId: "patrimony-1",
        reason: "INSERVIBILIDADE",
        justification: "Bem sem recuperação",
        actorUserId: "user-1",
        teamContext: "Patrimônio"
      })
    ).resolves.toEqual({
      ok: false,
      reason: "INVALID_PROCEDURE_OR_REPORT_REFERENCE",
      patrimonyId: "patrimony-1"
    });
    expect(baixador.baixar).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "INSERVIBILIDADE",
        procedureOrReportReference: undefined,
        authorizationReference: undefined
      })
    );
  });

  it("normaliza a entrada e preserva as referências de suporte", async () => {
    const baixador: PatrimonyBaixador = {
      baixar: vi.fn().mockResolvedValue({
        ok: true,
        writeOffId: "write-off-1",
        patrimonyId: "patrimony-1",
        status: "BAIXADO",
        activeTomboRetired: true
      })
    };
    const useCase = new BaixarPatrimony(baixador);
    const occurredAt = new Date("2026-11-09T18:00:00.000Z");

    await expect(
      useCase.execute({
        commandId: " command-1 ",
        patrimonyId: " patrimony-1 ",
        reason: " inservibilidade ",
        occurredAt,
        justification: " Bem sem recuperação ",
        procedureOrReportReference: " LAUDO-1 ",
        authorizationReference: " AUT-1 ",
        actorUserId: " user-1 ",
        teamContext: " Patrimônio "
      })
    ).resolves.toEqual({
      ok: true,
      writeOffId: "write-off-1",
      patrimonyId: "patrimony-1",
      status: "BAIXADO",
      activeTomboRetired: true
    });

    expect(baixador.baixar).toHaveBeenCalledWith({
      commandId: "command-1",
      patrimonyId: "patrimony-1",
      reason: "INSERVIBILIDADE",
      occurredAt,
      occurredAtWasProvided: true,
      justification: "Bem sem recuperação",
      procedureOrReportReference: "LAUDO-1",
      authorizationReference: "AUT-1",
      actorUserId: "user-1",
      teamContext: "Patrimônio",
      correlationId: "command-1"
    });
  });
});
