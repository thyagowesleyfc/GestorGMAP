import { describe, expect, it, vi } from "vitest";

import {
  AuthorizeMaintenanceRequest,
  type AuthorizeMaintenanceRequestInput,
  type MaintenanceRequestAuthorizer
} from "../../../src/modules/maintenance/application/authorize-maintenance-request";

const baseInput: AuthorizeMaintenanceRequestInput = {
  commandId: " command-1 ",
  maintenanceRequestId: " maintenance-request-1 ",
  authorizedAt: new Date("2026-11-10T12:00:00.000Z"),
  reason: " Solicitação validada pela Gerência. ",
  actorUserId: " user-1 ",
  teamContext: " Gerência ",
  correlationId: " correlation-1 "
};

function createUseCase(result: Awaited<ReturnType<MaintenanceRequestAuthorizer["authorize"]>>) {
  const authorizer: MaintenanceRequestAuthorizer = {
    authorize: vi.fn().mockResolvedValue(result)
  };

  return { authorizer, useCase: new AuthorizeMaintenanceRequest(authorizer) };
}

describe("authorize maintenance request", () => {
  it("normalizes the command and propagates the authorizer result", async () => {
    const authorizerResult = {
      ok: true as const,
      maintenanceRequestId: "maintenance-request-1",
      status: "EM_ANALISE" as const
    };
    const { authorizer, useCase } = createUseCase(authorizerResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(authorizerResult);

    expect(authorizer.authorize).toHaveBeenCalledWith({
      commandId: "command-1",
      maintenanceRequestId: "maintenance-request-1",
      authorizedAt: baseInput.authorizedAt,
      reason: "Solicitação validada pela Gerência.",
      actorUserId: "user-1",
      teamContext: "Gerência",
      correlationId: "correlation-1"
    });
  });

  it("defaults authorizedAt and correlationId", async () => {
    const now = new Date("2026-11-10T13:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const { authorizer, useCase } = createUseCase({
        ok: true,
        maintenanceRequestId: "maintenance-request-1",
        status: "EM_ANALISE"
      });

      await useCase.execute({ ...baseInput, authorizedAt: undefined, correlationId: "   " });

      expect(authorizer.authorize).toHaveBeenCalledWith(
        expect.objectContaining({
          authorizedAt: now,
          correlationId: "command-1"
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["commandId", { commandId: " " }, "INVALID_COMMAND_ID"],
    ["maintenance request id", { maintenanceRequestId: " " }, "INVALID_MAINTENANCE_REQUEST_ID"],
    ["reason", { reason: " " }, "INVALID_REASON"],
    ["date", { authorizedAt: new Date("invalid") }, "INVALID_AUTHORIZED_AT"],
    ["actor", { actorUserId: " " }, "INVALID_ACTOR_USER_ID"],
    ["team context", { teamContext: " " }, "INVALID_TEAM_CONTEXT"]
  ])("rejects an invalid %s before authorization", async (_field, override, reason) => {
    const { authorizer, useCase } = createUseCase({
      ok: true,
      maintenanceRequestId: "unused",
      status: "EM_ANALISE"
    });

    await expect(useCase.execute({ ...baseInput, ...override })).resolves.toEqual({
      ok: false,
      reason
    });
    expect(authorizer.authorize).not.toHaveBeenCalled();
  });

  it("uses the command id when correlationId is omitted", async () => {
    const { authorizer, useCase } = createUseCase({
      ok: false,
      reason: "ACTOR_NOT_AUTHORIZED"
    });

    await expect(useCase.execute({ ...baseInput, correlationId: undefined })).resolves.toEqual({
      ok: false,
      reason: "ACTOR_NOT_AUTHORIZED"
    });
    expect(authorizer.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "command-1" })
    );
  });
});
