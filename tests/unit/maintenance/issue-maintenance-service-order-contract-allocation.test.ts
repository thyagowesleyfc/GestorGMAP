import { describe, expect, it, vi } from "vitest";

import {
  IssueMaintenanceServiceOrder,
  type IssueMaintenanceServiceOrderInput,
  type MaintenanceServiceOrderIssuer
} from "../../../src/modules/maintenance/application/issue-maintenance-service-order";

type ContractAllocationServiceInput = {
  description: string;
  contractItemId: string;
  quantity: number;
};

type ContractAllocationIssueInput = Omit<IssueMaintenanceServiceOrderInput, "services"> & {
  services: ContractAllocationServiceInput[];
};

const baseInput: ContractAllocationIssueInput = {
  commandId: " command-1 ",
  maintenanceRequestId: " maintenance-request-1 ",
  contractId: " contract-1 ",
  entityId: " entity-1 ",
  code: " os-001 ",
  patrimonyIds: [" patrimony-1 ", "patrimony-2"],
  services: [
    {
      description: " Manutenção preventiva ",
      contractItemId: " contract-item-1 ",
      quantity: 2
    },
    {
      description: " Troca de componente ",
      contractItemId: " contract-item-2 ",
      quantity: 1
    }
  ],
  issuedAt: new Date("2026-11-12T12:00:00.000Z"),
  actorUserId: " user-1 ",
  teamContext: " Patrimônio ",
  correlationId: " correlation-1 "
};

function createUseCase(result: Awaited<ReturnType<MaintenanceServiceOrderIssuer["issue"]>>) {
  const issuer: MaintenanceServiceOrderIssuer = {
    issue: vi.fn().mockResolvedValue(result)
  };

  return { issuer, useCase: new IssueMaintenanceServiceOrder(issuer) };
}

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

describe("issue maintenance service order with contract allocation", () => {
  it("normalizes and forwards multiple service lines and contract items", async () => {
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
        {
          description: "Manutenção preventiva",
          contractItemId: "contract-item-1",
          quantity: 2
        },
        {
          description: "Troca de componente",
          contractItemId: "contract-item-2",
          quantity: 1
        }
      ],
      issuedAt: baseInput.issuedAt,
      actorUserId: "user-1",
      teamContext: "Patrimônio",
      correlationId: "correlation-1"
    });
  });

  it("rejects a service line without a Contract Item before issuing", async () => {
    const { issuer, useCase } = createUseCase(unusedResult);

    await expect(
      useCase.execute({
        ...baseInput,
        services: [{ ...baseInput.services[0], contractItemId: " \t " }]
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "INVALID_CONTRACT_ITEM_ID"
    });
    expect(issuer.issue).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN]
  ])("rejects a %s service quantity before issuing", async (_label, quantity) => {
    const { issuer, useCase } = createUseCase(unusedResult);

    await expect(
      useCase.execute({
        ...baseInput,
        services: [{ ...baseInput.services[0], quantity }]
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "INVALID_SERVICE_QUANTITY"
    });
    expect(issuer.issue).not.toHaveBeenCalled();
  });

  it("propagates a failure returned by the issuer without masking it", async () => {
    const issuerResult = {
      ok: false as const,
      reason: "CONTRACT_NOT_FOUND" as const,
      contractId: "contract-1"
    };
    const { issuer, useCase } = createUseCase(issuerResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(issuerResult);
    expect(issuer.issue).toHaveBeenCalledOnce();
  });
});
