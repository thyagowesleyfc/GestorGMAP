import { describe, expect, it, vi } from "vitest";

import {
  RegisterMaintenanceRequest,
  type MaintenanceRequestRegistrar,
  type RegisterMaintenanceRequestInput
} from "../../../src/modules/maintenance/application/register-maintenance-request";

const baseInput: RegisterMaintenanceRequestInput = {
  commandId: " command-1 ",
  requestingEntityId: " entity-1 ",
  summary: " Computador sem vídeo ",
  description: " Equipamento liga, mas não apresenta imagem. ",
  actorUserId: " user-1 ",
  teamContext: " Triagem ",
  correlationId: " correlation-1 ",
  references: [
    {
      system: "SEI",
      identifier: " processo-1 ",
      url: " https://sei.example/processo-1 "
    }
  ]
};

const invalidReferenceCases: Array<
  [string, { system?: string; identifier?: string; url?: string }, string]
> = [
  ["system", { system: "OTHER" }, "INVALID_REFERENCE_SYSTEM"],
  ["identifier", { identifier: " " }, "INVALID_REFERENCE_IDENTIFIER"],
  ["url", { url: "not-a-url" }, "INVALID_REFERENCE_URL"]
];

function createUseCase(result: Awaited<ReturnType<MaintenanceRequestRegistrar["register"]>>) {
  const registrar: MaintenanceRequestRegistrar = {
    register: vi.fn().mockResolvedValue(result)
  };

  return { registrar, useCase: new RegisterMaintenanceRequest(registrar) };
}

describe("register maintenance request", () => {
  it("normalizes the command, keeps optional references and propagates the registrar result", async () => {
    const requestedAt = new Date("2026-11-09T12:00:00.000Z");
    const registrarResult = {
      ok: true as const,
      maintenanceRequestId: "maintenance-request-1",
      status: "REGISTRADA" as const,
      referenceCount: 1
    };
    const { registrar, useCase } = createUseCase(registrarResult);

    await expect(useCase.execute({ ...baseInput, requestedAt })).resolves.toEqual(registrarResult);

    expect(registrar.register).toHaveBeenCalledWith({
      commandId: "command-1",
      requestingEntityId: "entity-1",
      summary: "Computador sem vídeo",
      description: "Equipamento liga, mas não apresenta imagem.",
      references: [
        {
          system: "SEI",
          identifier: "processo-1",
          url: "https://sei.example/processo-1"
        }
      ],
      requestedAt,
      actorUserId: "user-1",
      teamContext: "Triagem",
      correlationId: "correlation-1"
    });
  });

  it("registers without references and falls back to the command id as correlation id", async () => {
    const { registrar, useCase } = createUseCase({
      ok: true,
      maintenanceRequestId: "maintenance-request-2",
      status: "REGISTRADA",
      referenceCount: 0
    });

    await expect(
      useCase.execute({
        ...baseInput,
        commandId: " command-2 ",
        correlationId: "   ",
        references: undefined
      })
    ).resolves.toMatchObject({ ok: true, referenceCount: 0 });

    expect(registrar.register).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "command-2",
        references: [],
        correlationId: "command-2",
        requestedAt: expect.any(Date)
      })
    );
  });

  it.each([
    ["commandId", { commandId: " " }, "INVALID_COMMAND_ID"],
    ["entity", { requestingEntityId: " " }, "INVALID_REQUESTING_ENTITY_ID"],
    ["summary", { summary: " " }, "INVALID_SUMMARY"],
    ["description", { description: " " }, "INVALID_DESCRIPTION"],
    ["date", { requestedAt: new Date("invalid") }, "INVALID_REQUESTED_AT"],
    ["actor", { actorUserId: " " }, "INVALID_ACTOR_USER_ID"],
    ["team context", { teamContext: " " }, "INVALID_TEAM_CONTEXT"]
  ])("rejects an invalid %s before persistence", async (_field, override, reason) => {
    const { registrar, useCase } = createUseCase({
      ok: true,
      maintenanceRequestId: "unused",
      status: "REGISTRADA",
      referenceCount: 0
    });

    await expect(useCase.execute({ ...baseInput, ...override })).resolves.toEqual({
      ok: false,
      reason
    });
    expect(registrar.register).not.toHaveBeenCalled();
  });

  it.each(invalidReferenceCases)(
    "rejects an invalid reference %s before persistence",
    async (_field, override, reason) => {
      const { registrar, useCase } = createUseCase({
        ok: true,
        maintenanceRequestId: "unused",
        status: "REGISTRADA",
        referenceCount: 0
      });

      await expect(
        useCase.execute({
          ...baseInput,
          references: [
            {
              ...baseInput.references![0],
              ...override,
              system: (override.system ?? baseInput.references![0].system) as "SEI" | "REDMINE",
              identifier: override.identifier ?? baseInput.references![0].identifier
            }
          ]
        })
      ).resolves.toEqual({
        ok: false,
        reason,
        referenceIdentifier: override.identifier?.trim() ?? "processo-1"
      });
      expect(registrar.register).not.toHaveBeenCalled();
    }
  );

  it("rejects duplicate references by system and identifier", async () => {
    const { registrar, useCase } = createUseCase({
      ok: true,
      maintenanceRequestId: "unused",
      status: "REGISTRADA",
      referenceCount: 0
    });

    await expect(
      useCase.execute({
        ...baseInput,
        references: [
          { system: "SEI", identifier: "processo-1" },
          { system: "SEI", identifier: " processo-1 " }
        ]
      })
    ).resolves.toEqual({
      ok: false,
      reason: "DUPLICATE_REFERENCE",
      referenceIdentifier: "processo-1"
    });
    expect(registrar.register).not.toHaveBeenCalled();
  });

  it("keeps adapter failure reasons in the application result contract", async () => {
    const registrarResult = { ok: false as const, reason: "ACTOR_NOT_AUTHORIZED" as const };
    const { registrar, useCase } = createUseCase(registrarResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(registrarResult);
    expect(registrar.register).toHaveBeenCalledOnce();
  });
});
