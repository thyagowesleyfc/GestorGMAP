import { describe, expect, it, vi } from "vitest";

import {
  RegisterPatrimonyComposition,
  type PatrimonyCompositionRegisterer
} from "../../../src/modules/patrimony/application/register-patrimony-composition";

describe("register patrimony composition", () => {
  it("rejects an incomplete command before reaching persistence", async () => {
    const registerer: PatrimonyCompositionRegisterer = { register: vi.fn() };
    const useCase = new RegisterPatrimonyComposition(registerer);

    await expect(
      useCase.execute({
        commandId: " ",
        patrimonyId: "patrimony-1",
        materialConfigurationId: "configuration-1",
        components: [{ materialSingularId: "material-1" }],
        reason: "Registrar composição",
        actorUserId: "user-1",
        teamContext: "Patrimônio"
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_COMMAND_ID" });

    expect(registerer.register).not.toHaveBeenCalled();
  });

  it("normalizes components, rejects duplicates, and supplies a correlation id", async () => {
    const registerer: PatrimonyCompositionRegisterer = {
      register: vi.fn().mockResolvedValue({
        ok: true,
        compositionId: "composition-1",
        patrimonyId: "patrimony-1",
        revision: 1,
        itemCount: 2
      })
    };
    const useCase = new RegisterPatrimonyComposition(registerer);

    await expect(
      useCase.execute({
        commandId: " command-1 ",
        patrimonyId: " patrimony-1 ",
        materialConfigurationId: " configuration-1 ",
        components: [
          { materialSingularId: " material-2 " },
          { materialSingularId: " material-1 ", componentPatrimonyId: " component-1 " }
        ],
        reason: " Registrar composição ",
        actorUserId: " user-1 ",
        teamContext: " Patrimônio ",
        correlationId: " correlation-1 "
      })
    ).resolves.toMatchObject({ ok: true });

    expect(registerer.register).toHaveBeenCalledWith({
      commandId: "command-1",
      patrimonyId: "patrimony-1",
      materialConfigurationId: "configuration-1",
      components: [
        { materialSingularId: "material-1", componentPatrimonyId: "component-1" },
        { materialSingularId: "material-2", componentPatrimonyId: undefined }
      ],
      recordedAt: expect.any(Date),
      reason: "Registrar composição",
      actorUserId: "user-1",
      teamContext: "Patrimônio",
      correlationId: "correlation-1"
    });

    await expect(
      useCase.execute({
        commandId: "command-2",
        patrimonyId: "patrimony-1",
        materialConfigurationId: "configuration-1",
        components: [{ materialSingularId: "material-1" }, { materialSingularId: "material-1" }],
        reason: "Registrar composição",
        actorUserId: "user-1",
        teamContext: "Patrimônio"
      })
    ).resolves.toEqual({
      ok: false,
      reason: "DUPLICATE_COMPONENT_MATERIAL",
      materialSingularId: "material-1"
    });
  });
});
