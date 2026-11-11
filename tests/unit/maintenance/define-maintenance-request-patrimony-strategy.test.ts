import { describe, expect, it, vi } from "vitest";

import {
  DefineMaintenanceRequestPatrimonyStrategy,
  type DefineMaintenanceRequestPatrimonyStrategyInput,
  type MaintenanceRequestPatrimonyStrategyDefiner
} from "../../../src/modules/maintenance/application/define-maintenance-request-patrimony-strategy";

const baseInput: DefineMaintenanceRequestPatrimonyStrategyInput = {
  commandId: " command-1 ",
  maintenanceRequestId: " maintenance-request-1 ",
  targets: [
    {
      patrimonyId: " patrimony-1 ",
      strategyType: "UTD",
      justification: " Uso temporario definido pela equipe. "
    },
    {
      patrimonyId: " patrimony-2 ",
      strategyType: "CONTRATO_SERVICO",
      contractId: " contract-1 ",
      justification: " Atendimento coberto pelo contrato vigente. "
    }
  ],
  definedAt: new Date("2026-11-11T12:00:00.000Z"),
  actorUserId: " user-1 ",
  teamContext: " Manutencao ",
  correlationId: " correlation-1 "
};

function createUseCase(
  result: Awaited<ReturnType<MaintenanceRequestPatrimonyStrategyDefiner["define"]>>
) {
  const definer: MaintenanceRequestPatrimonyStrategyDefiner = {
    define: vi.fn().mockResolvedValue(result)
  };

  return {
    definer,
    useCase: new DefineMaintenanceRequestPatrimonyStrategy(definer)
  };
}

describe("define maintenance request patrimony strategy", () => {
  it("normalizes and forwards multiple targets with distinct strategies", async () => {
    const definedAt = baseInput.definedAt!;
    const definerResult = {
      ok: true as const,
      maintenanceRequestId: "maintenance-request-1",
      status: "EM_ANALISE" as const,
      definedPatrimonyIds: ["patrimony-1", "patrimony-2"],
      definedCount: 2
    };
    const { definer, useCase } = createUseCase(definerResult);

    await expect(useCase.execute(baseInput)).resolves.toEqual(definerResult);

    expect(definer.define).toHaveBeenCalledWith({
      commandId: "command-1",
      maintenanceRequestId: "maintenance-request-1",
      targets: [
        {
          patrimonyId: "patrimony-1",
          strategyType: "UTD",
          justification: "Uso temporario definido pela equipe."
        },
        {
          patrimonyId: "patrimony-2",
          strategyType: "CONTRATO_SERVICO",
          contractId: "contract-1",
          justification: "Atendimento coberto pelo contrato vigente."
        }
      ],
      definedAt,
      actorUserId: "user-1",
      teamContext: "Manutencao",
      correlationId: "correlation-1"
    });
  });

  const invalidTargetCases: Array<
    [string, DefineMaintenanceRequestPatrimonyStrategyInput["targets"], string]
  > = [
    ["empty target list", [], "EMPTY_STRATEGY_TARGETS"],
    [
      "duplicate target IDs",
      [{ ...baseInput.targets[0] }, { ...baseInput.targets[1], patrimonyId: " patrimony-1 " }],
      "DUPLICATE_STRATEGY_TARGET"
    ],
    [
      "invalid strategy",
      [{ ...baseInput.targets[0], strategyType: "INVALID" as never }],
      "INVALID_STRATEGY"
    ],
    [
      "empty justification",
      [{ ...baseInput.targets[0], justification: "  " }],
      "INVALID_JUSTIFICATION"
    ],
    [
      "service contract strategy without a contract",
      [
        {
          ...baseInput.targets[1],
          contractId: undefined,
          justification: "Contrato obrigatorio."
        }
      ],
      "CONTRACT_REQUIRED_FOR_STRATEGY"
    ],
    [
      "contract reference for a non-contract strategy",
      [
        {
          ...baseInput.targets[0],
          contractId: " contract-1 "
        }
      ],
      "CONTRACT_NOT_ALLOWED_FOR_STRATEGY"
    ]
  ];

  it.each(invalidTargetCases)(
    "rejects %s before calling the infrastructure port",
    async (_case, targets, reason) => {
      const { definer, useCase } = createUseCase({
        ok: true,
        maintenanceRequestId: "unused",
        status: "EM_ANALISE",
        definedPatrimonyIds: [],
        definedCount: 0
      });

      const result = await useCase.execute({ ...baseInput, targets: [...targets] });

      expect(result).toMatchObject({ ok: false, reason });
      expect(definer.define).not.toHaveBeenCalled();
    }
  );
});
