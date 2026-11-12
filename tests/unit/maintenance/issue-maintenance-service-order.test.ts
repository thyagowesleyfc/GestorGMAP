import { describe, expect, it, vi } from "vitest";

import {
  IssueMaintenanceServiceOrder,
  type IssueMaintenanceServiceOrderInput,
  type MaintenanceServiceOrderIssuer
} from "../../../src/modules/maintenance/application/issue-maintenance-service-order";

const baseInput: IssueMaintenanceServiceOrderInput = {
  commandId: " command-1 ",
  maintenanceRequestId: " maintenance-request-1 ",
  contractId: " contract-1 ",
  entityId: " entity-1 ",
  code: " os-001 ",
  patrimonyIds: [" patrimony-1 ", "patrimony-2"],
  services: [
    { description: " Manutenção preventiva ", contractItemId: " item-1 ", quantity: 1 },
    { description: " Troca de componente ", contractItemId: "item-2", quantity: 2 }
  ],
  issuedAt: new Date("2026-11-11T12:00:00.000Z"),
  actorUserId: " user-1 ",
  teamContext: " Manutenção ",
  correlationId: " correlation-1 "
};

function createUseCase(result: Awaited<ReturnType<MaintenanceServiceOrderIssuer["issue"]>>) {
  const issuer: MaintenanceServiceOrderIssuer = {
    issue: vi.fn().mockResolvedValue(result)
  };

  return { issuer, useCase: new IssueMaintenanceServiceOrder(issuer) };
}

describe("issue maintenance service order", () => {
  it("normalizes the command and forwards it to the infrastructure port", async () => {
    const issuerResult = {
      ok: true as const,
      serviceOrderId: "service-order-1",
      code: "OS-001",
      maintenanceRequestId: "maintenance-request-1",
      contractId: "contract-1",
      entityId: "entity-1",
      patrimonyIds: ["patrimony-1", "patrimony-2"],
      serviceCount: 2,
      status: "EMITIDA" as const
    };
    const { issuer, useCase } = createUseCase(issuerResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(issuerResult);

    expect(issuer.issue).toHaveBeenCalledWith({
      commandId: "command-1",
      maintenanceRequestId: "maintenance-request-1",
      contractId: "contract-1",
      entityId: "entity-1",
      code: "OS-001",
      patrimonyIds: ["patrimony-1", "patrimony-2"],
      services: [
        { description: "Manutenção preventiva", contractItemId: "item-1", quantity: 1 },
        { description: "Troca de componente", contractItemId: "item-2", quantity: 2 }
      ],
      issuedAt: baseInput.issuedAt,
      actorUserId: "user-1",
      teamContext: "Manutenção",
      correlationId: "correlation-1"
    });
  });

  it.each([
    ["patrimony targets", [], "EMPTY_PATRIMONY_TARGETS"],
    ["services", [], "EMPTY_SERVICES"]
  ])("rejects an empty %s before issuing", async (_field, value, reason) => {
    const { issuer, useCase } = createUseCase(unusedResult);

    const input =
      _field === "patrimony targets"
        ? { ...baseInput, patrimonyIds: value as string[] }
        : {
            ...baseInput,
            services: value as Array<{
              description: string;
              contractItemId: string;
              quantity: number;
            }>
          };

    await expect(useCase.execute(input)).resolves.toMatchObject({ ok: false, reason });
    expect(issuer.issue).not.toHaveBeenCalled();
  });

  it("rejects a blank service description before issuing", async () => {
    const { issuer, useCase } = createUseCase(unusedResult);

    await expect(
      useCase.execute({
        ...baseInput,
        services: [{ description: " \t ", contractItemId: "item-1", quantity: 1 }]
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "INVALID_SERVICE_DESCRIPTION"
    });
    expect(issuer.issue).not.toHaveBeenCalled();
  });

  it.each([
    ["commandId", { commandId: " " }, "INVALID_COMMAND_ID"],
    ["maintenance request id", { maintenanceRequestId: " " }, "INVALID_MAINTENANCE_REQUEST_ID"],
    ["contract id", { contractId: " " }, "INVALID_CONTRACT_ID"],
    ["entity id", { entityId: " " }, "INVALID_ENTITY_ID"],
    ["code", { code: " " }, "INVALID_CODE"],
    ["patrimony id", { patrimonyIds: [" "] }, "INVALID_PATRIMONY_ID"],
    ["actor", { actorUserId: " " }, "INVALID_ACTOR_USER_ID"],
    ["team context", { teamContext: " " }, "INVALID_TEAM_CONTEXT"],
    ["date", { issuedAt: new Date("invalid") }, "INVALID_ISSUED_AT"]
  ])("rejects an invalid %s before issuing", async (_field, override, reason) => {
    const { issuer, useCase } = createUseCase(unusedResult);

    await expect(useCase.execute({ ...baseInput, ...override })).resolves.toMatchObject({
      ok: false,
      reason
    });
    expect(issuer.issue).not.toHaveBeenCalled();
  });

  it("uses the command id as correlationId when it is omitted", async () => {
    const { issuer, useCase } = createUseCase(unusedResult);

    await useCase.execute({ ...baseInput, correlationId: undefined });

    expect(issuer.issue).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "command-1" })
    );
  });
});

const unusedResult = {
  ok: true as const,
  serviceOrderId: "unused",
  code: "OS-UNUSED",
  maintenanceRequestId: "maintenance-request-unused",
  contractId: "contract-unused",
  entityId: "entity-unused",
  patrimonyIds: ["patrimony-unused"],
  serviceCount: 1,
  status: "EMITIDA" as const
};
