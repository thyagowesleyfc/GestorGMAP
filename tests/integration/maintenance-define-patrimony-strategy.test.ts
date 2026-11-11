import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { DefineMaintenanceRequestPatrimonyStrategy } from "../../src/modules/maintenance/application/define-maintenance-request-patrimony-strategy";
import { PostgresMaintenanceRequestPatrimonyStrategyDefiner } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-request-patrimony-strategy-definer";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("define estratégia patrimonial da solicitação de manutenção", () => {
  it("define estratégias para vários alvos com contrato, autorização, idempotência e atomicidade", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedDependencies(client);
      const useCase = new DefineMaintenanceRequestPatrimonyStrategy(
        new PostgresMaintenanceRequestPatrimonyStrategyDefiner(pool)
      );
      const initialSnapshot = await takeSnapshot(client, seed);
      const successCommand = strategyCommand(seed, "cmd-maintenance-strategy-success-001", [
        {
          patrimonyId: seed.firstPatrimonyId,
          strategyType: "UTD",
          justification: "Atendimento pela unidade técnica descentralizada."
        },
        {
          patrimonyId: seed.secondPatrimonyId,
          strategyType: "UTD",
          justification: "Atendimento pela unidade técnica descentralizada."
        },
        {
          patrimonyId: seed.contractPatrimonyId,
          strategyType: "CONTRATO_SERVICO",
          contractId: seed.activeContractId,
          justification: "Serviço coberto pelo contrato vigente."
        }
      ]);

      await expect(useCase.execute(successCommand)).resolves.toEqual({
        ok: true,
        maintenanceRequestId: seed.requestId,
        status: "EM_ANALISE",
        definedPatrimonyIds: [
          seed.firstPatrimonyId,
          seed.secondPatrimonyId,
          seed.contractPatrimonyId
        ],
        definedCount: 3
      });

      const afterSuccess = await takeSnapshot(client, seed);
      expect(afterSuccess.request).toEqual({ status: "EM_ANALISE", version: 3 });
      expect(afterSuccess.patrimonies).toEqual(initialSnapshot.patrimonies);
      expect(afterSuccess.strategyCount).toBe(3);
      await expectStrategies(client, seed, [
        {
          patrimonyId: seed.firstPatrimonyId,
          strategyType: "UTD",
          contractId: null,
          justification: "Atendimento pela unidade técnica descentralizada.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-success-001-correlation"
        },
        {
          patrimonyId: seed.secondPatrimonyId,
          strategyType: "UTD",
          contractId: null,
          justification: "Atendimento pela unidade técnica descentralizada.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-success-001-correlation"
        },
        {
          patrimonyId: seed.contractPatrimonyId,
          strategyType: "CONTRATO_SERVICO",
          contractId: seed.activeContractId,
          justification: "Serviço coberto pelo contrato vigente.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-success-001-correlation"
        }
      ]);

      await expect(useCase.execute(successCommand)).resolves.toEqual({
        ok: true,
        maintenanceRequestId: seed.requestId,
        status: "EM_ANALISE",
        definedPatrimonyIds: [
          seed.firstPatrimonyId,
          seed.secondPatrimonyId,
          seed.contractPatrimonyId
        ],
        definedCount: 3
      });
      await expect(
        useCase.execute({
          ...successCommand,
          targets: successCommand.targets.map((target) => ({
            ...target,
            justification: `${target.justification} Alteração incompatível.`
          }))
        })
      ).resolves.toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });

      const authorization = await client.query<{
        authorized_at: Date;
        authorized_by_user_id: string;
        authorization_reason: string;
      }>(
        `select "authorized_at", "authorized_by_user_id", "authorization_reason"
           from "maintenance_request"
          where "id" = $1`,
        [seed.requestId]
      );
      await client.query(
        `update "maintenance_request"
            set "authorized_at" = null,
                "authorized_by_user_id" = null,
                "authorization_reason" = null
          where "id" = $1`,
        [seed.requestId]
      );
      await expect(
        useCase.execute(
          strategyCommand(seed, "cmd-maintenance-strategy-missing-authorization-001", [
            {
              patrimonyId: seed.secondPatrimonyId,
              strategyType: "CERME",
              justification: "Autorizacao registrada de forma incompleta."
            }
          ])
        )
      ).resolves.toEqual({
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
        maintenanceRequestId: seed.requestId
      });
      expect(await takeSnapshot(client, seed)).toEqual(afterSuccess);
      await client.query(
        `update "maintenance_request"
            set "authorized_at" = $2,
                "authorized_by_user_id" = $3,
                "authorization_reason" = $4
          where "id" = $1`,
        [
          seed.requestId,
          authorization.rows[0].authorized_at,
          authorization.rows[0].authorized_by_user_id,
          authorization.rows[0].authorization_reason
        ]
      );

      await expect(
        useCase.execute(
          strategyCommand(seed, "cmd-maintenance-strategy-rectification-001", [
            {
              patrimonyId: seed.firstPatrimonyId,
              strategyType: "GARANTIA",
              justification: "Estratégia retificada para garantia."
            }
          ])
        )
      ).resolves.toEqual({
        ok: true,
        maintenanceRequestId: seed.requestId,
        status: "EM_ANALISE",
        definedPatrimonyIds: [seed.firstPatrimonyId],
        definedCount: 1
      });
      const afterRectification = await takeSnapshot(client, seed);
      expect(afterRectification.request).toEqual({ status: "EM_ANALISE", version: 4 });
      expect(afterRectification.patrimonies).toEqual(initialSnapshot.patrimonies);
      expect(afterRectification.strategyCount).toBe(3);
      await expectStrategies(client, seed, [
        {
          patrimonyId: seed.firstPatrimonyId,
          strategyType: "GARANTIA",
          contractId: null,
          justification: "Estratégia retificada para garantia.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-rectification-001-correlation"
        },
        {
          patrimonyId: seed.secondPatrimonyId,
          strategyType: "UTD",
          contractId: null,
          justification: "Atendimento pela unidade técnica descentralizada.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-success-001-correlation"
        },
        {
          patrimonyId: seed.contractPatrimonyId,
          strategyType: "CONTRATO_SERVICO",
          contractId: seed.activeContractId,
          justification: "Serviço coberto pelo contrato vigente.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-success-001-correlation"
        }
      ]);

      const beforeContractRollback = await takeSnapshot(client, seed);
      await expect(
        useCase.execute(
          strategyCommand(seed, "cmd-maintenance-strategy-contract-rollback-001", [
            {
              patrimonyId: seed.atomicPatrimonyId,
              strategyType: "UTD",
              justification: "Alvo válido que não deve ser persistido parcialmente."
            },
            {
              patrimonyId: seed.grePatrimonyId,
              strategyType: "CONTRATO_SERVICO",
              contractId: seed.inactiveContractId,
              justification: "Contrato inativo não aplicável."
            }
          ])
        )
      ).resolves.toEqual({
        ok: false,
        reason: "CONTRACT_NOT_APPLICABLE",
        patrimonyId: seed.grePatrimonyId
      });
      expect(await takeSnapshot(client, seed)).toEqual(beforeContractRollback);

      await expect(
        useCase.execute(
          strategyCommand(seed, "cmd-maintenance-strategy-contract-required-001", [
            {
              patrimonyId: seed.atomicPatrimonyId,
              strategyType: "CONTRATO_SERVICO",
              justification: "Contrato obrigatório ausente."
            }
          ])
        )
      ).resolves.toEqual({
        ok: false,
        reason: "CONTRACT_REQUIRED_FOR_STRATEGY",
        patrimonyId: seed.atomicPatrimonyId
      });

      await expect(
        useCase.execute(
          strategyCommand(seed, "cmd-maintenance-strategy-unlinked-001", [
            {
              patrimonyId: seed.unlinkedPatrimonyId,
              strategyType: "CERME",
              justification: "Alvo ainda não vinculado à solicitação."
            }
          ])
        )
      ).resolves.toEqual({
        ok: false,
        reason: "PATRIMONY_TARGET_NOT_LINKED",
        patrimonyId: seed.unlinkedPatrimonyId
      });

      for (const [commandId, actorUserId] of [
        ["cmd-maintenance-strategy-incompatible-gre-001", seed.incompatibleGrePatrimonyUserId],
        ["cmd-maintenance-strategy-inactive-membership-001", seed.inactivePatrimonyUserId],
        ["cmd-maintenance-strategy-triage-001", seed.triageUserId],
        ["cmd-maintenance-strategy-technical-001", seed.technicalUserId]
      ] as const) {
        await expect(
          useCase.execute({
            ...strategyCommand(seed, commandId, [
              {
                patrimonyId: seed.atomicPatrimonyId,
                strategyType: "AVALIACAO_BAIXA",
                justification: "Ator sem competência compatível."
              }
            ]),
            actorUserId
          })
        ).resolves.toEqual({ ok: false, reason: "ACTOR_NOT_AUTHORIZED" });
      }

      await expect(
        useCase.execute(
          strategyCommand(
            seed,
            "cmd-maintenance-strategy-wrong-state-001",
            [
              {
                patrimonyId: seed.registeredPatrimonyId,
                strategyType: "UTD",
                justification: "Solicitação ainda não autorizada."
              }
            ],
            seed.globalPatrimonyUserId,
            seed.registeredRequestId
          )
        )
      ).resolves.toEqual({
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
        maintenanceRequestId: seed.registeredRequestId
      });

      await expect(
        useCase.execute(
          strategyCommand(
            seed,
            "cmd-maintenance-strategy-gre-success-001",
            [
              {
                patrimonyId: seed.grePatrimonyId,
                strategyType: "GARANTIA",
                justification: "Atendimento por membro de Patrimônio do GRE compatível."
              }
            ],
            seed.compatibleGrePatrimonyUserId
          )
        )
      ).resolves.toEqual({
        ok: true,
        maintenanceRequestId: seed.requestId,
        status: "EM_ANALISE",
        definedPatrimonyIds: [seed.grePatrimonyId],
        definedCount: 1
      });

      const finalSnapshot = await takeSnapshot(client, seed);
      expect(finalSnapshot.request).toEqual({ status: "EM_ANALISE", version: 5 });
      expect(finalSnapshot.patrimonies).toEqual(initialSnapshot.patrimonies);
      expect(finalSnapshot.strategyCount).toBe(4);
      await expectStrategies(client, seed, [
        {
          patrimonyId: seed.firstPatrimonyId,
          strategyType: "GARANTIA",
          contractId: null,
          justification: "Estratégia retificada para garantia.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-rectification-001-correlation"
        },
        {
          patrimonyId: seed.secondPatrimonyId,
          strategyType: "UTD",
          contractId: null,
          justification: "Atendimento pela unidade técnica descentralizada.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-success-001-correlation"
        },
        {
          patrimonyId: seed.contractPatrimonyId,
          strategyType: "CONTRATO_SERVICO",
          contractId: seed.activeContractId,
          justification: "Serviço coberto pelo contrato vigente.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-success-001-correlation"
        },
        {
          patrimonyId: seed.grePatrimonyId,
          strategyType: "GARANTIA",
          contractId: null,
          justification: "Atendimento por membro de Patrimônio do GRE compatível.",
          definedByUserId: seed.compatibleGrePatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-gre-success-001-correlation"
        }
      ]);

      await client.query(
        `update "maintenance_request"
            set "status" = 'ATENDIMENTO_EMITIDO',
                "version" = "version" + 1,
                "updated_at" = current_timestamp
          where "id" = $1`,
        [seed.requestId]
      );
      const frozenSnapshot = await takeSnapshot(client, seed);
      await expect(
        useCase.execute(
          strategyCommand(seed, "cmd-maintenance-strategy-frozen-001", [
            {
              patrimonyId: seed.firstPatrimonyId,
              strategyType: "UTD",
              justification: "Tentativa de alteração após emissão do atendimento."
            }
          ])
        )
      ).resolves.toEqual({
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
        maintenanceRequestId: seed.requestId
      });
      expect(await takeSnapshot(client, seed)).toEqual(frozenSnapshot);
      await expectStrategies(client, seed, [
        {
          patrimonyId: seed.firstPatrimonyId,
          strategyType: "GARANTIA",
          contractId: null,
          justification: "Estratégia retificada para garantia.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-rectification-001-correlation"
        },
        {
          patrimonyId: seed.secondPatrimonyId,
          strategyType: "UTD",
          contractId: null,
          justification: "Atendimento pela unidade técnica descentralizada.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-success-001-correlation"
        },
        {
          patrimonyId: seed.contractPatrimonyId,
          strategyType: "CONTRATO_SERVICO",
          contractId: seed.activeContractId,
          justification: "Serviço coberto pelo contrato vigente.",
          definedByUserId: seed.globalPatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-success-001-correlation"
        },
        {
          patrimonyId: seed.grePatrimonyId,
          strategyType: "GARANTIA",
          contractId: null,
          justification: "Atendimento por membro de Patrimônio do GRE compatível.",
          definedByUserId: seed.compatibleGrePatrimonyUserId,
          correlationId: "cmd-maintenance-strategy-gre-success-001-correlation"
        }
      ]);

      const effects = await client.query(
        `select
           (select count(*)::int from "audit_entry"
             where "object_id" = $1 and "action" = 'maintenance.define_patrimony_strategy') as audits,
           (select count(*)::int from "outbox_event"
             where "aggregate_id" = $1 and "event_type" = 'maintenance.request_patrimony_strategy_defined') as outbox,
           (select count(*)::int from "command_idempotency"
             where "command_name" = 'maintenance.define_patrimony_strategy') as idempotency,
           (select count(*)::int from "patrimony_movement"
             where "patrimony_id" = any($2::uuid[])) as movements,
           (select count(*)::int from "patrimony_write_off"
             where "patrimony_id" = any($2::uuid[])) as write_offs`,
        [seed.requestId, seed.allPatrimonyIds]
      );
      expect(effects.rows).toEqual([
        { audits: 3, outbox: 3, idempotency: 12, movements: 0, write_offs: 0 }
      ]);

      const strategyKeys = await client.query<{ count: number }>(
        `select count(*)::int as count
           from "command_idempotency"
          where "command_name" = 'maintenance.define_patrimony_strategy'
            and "idempotency_key" = $1`,
        [successCommand.commandId]
      );
      expect(strategyKeys.rows).toEqual([{ count: 1 }]);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  }, 180000);
});

function strategyCommand(
  seed: MaintenanceStrategySeed,
  commandId: string,
  targets: Array<{
    patrimonyId: string;
    strategyType: "UTD" | "CERME" | "CONTRATO_SERVICO" | "GARANTIA" | "AVALIACAO_BAIXA";
    contractId?: string;
    justification: string;
  }>,
  actorUserId = seed.globalPatrimonyUserId,
  maintenanceRequestId = seed.requestId
) {
  return {
    commandId,
    maintenanceRequestId,
    targets,
    definedAt: new Date("2026-11-11T15:00:00.000Z"),
    actorUserId,
    teamContext: "Patrimônio",
    correlationId: `${commandId}-correlation`
  };
}

type MaintenanceStrategySnapshot = {
  request: { status: string; version: number };
  patrimonies: Array<{ id: string; operational_state: string; version: number }>;
  strategyCount: number;
};

async function takeSnapshot(
  client: Client,
  seed: MaintenanceStrategySeed
): Promise<MaintenanceStrategySnapshot> {
  const request = await client.query<MaintenanceStrategySnapshot["request"]>(
    `select "status"::text, "version"
       from "maintenance_request"
      where "id" = $1`,
    [seed.requestId]
  );
  const patrimonies = await client.query<MaintenanceStrategySnapshot["patrimonies"][number]>(
    `select "id", "operational_state"::text, "version"
       from "patrimony"
      where "id" = any($1::uuid[])
      order by "id"`,
    [seed.allPatrimonyIds]
  );
  const strategies = await client.query<{ count: number }>(
    `select count(*)::int as count
       from "maintenance_request_patrimony_strategy"
      where "maintenance_request_id" = $1`,
    [seed.requestId]
  );

  return {
    request: request.rows[0],
    patrimonies: patrimonies.rows,
    strategyCount: strategies.rows[0].count
  };
}

async function expectStrategies(
  client: Client,
  seed: MaintenanceStrategySeed,
  expected: Array<{
    patrimonyId: string;
    strategyType: string;
    contractId: string | null;
    justification: string;
    definedByUserId: string;
    correlationId: string;
  }>
): Promise<void> {
  const result = await client.query(
    `select "patrimony_id", "strategy_type"::text as "strategy_type", "contract_id",
            "justification", "defined_by_user_id", "correlation_id"
       from "maintenance_request_patrimony_strategy"
      where "maintenance_request_id" = $1
      order by "patrimony_id"`,
    [seed.requestId]
  );

  expect(result.rows).toHaveLength(expected.length);
  expect(result.rows).toEqual(
    expect.arrayContaining(
      expected.map((row) => ({
        patrimony_id: row.patrimonyId,
        strategy_type: row.strategyType,
        contract_id: row.contractId,
        justification: row.justification,
        defined_by_user_id: row.definedByUserId,
        correlation_id: row.correlationId
      }))
    )
  );
}

type MaintenanceStrategySeed = {
  requestId: string;
  registeredRequestId: string;
  firstPatrimonyId: string;
  secondPatrimonyId: string;
  contractPatrimonyId: string;
  grePatrimonyId: string;
  atomicPatrimonyId: string;
  registeredPatrimonyId: string;
  unlinkedPatrimonyId: string;
  allPatrimonyIds: string[];
  globalPatrimonyUserId: string;
  compatibleGrePatrimonyUserId: string;
  incompatibleGrePatrimonyUserId: string;
  inactivePatrimonyUserId: string;
  triageUserId: string;
  technicalUserId: string;
  activeContractId: string;
  inactiveContractId: string;
};

async function seedDependencies(client: Client): Promise<MaintenanceStrategySeed> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const loginSuffix = suffix.toLowerCase();
  const compatibleGreCode = `GRE-MS-${suffix}`;
  const incompatibleGreCode = `GRE-OUT-${suffix}`;
  const compatibleGreId = randomUUID();
  const incompatibleGreId = randomUUID();
  const entityId = randomUUID();
  const incompatibleEntityId = randomUUID();
  const materialClassId = randomUUID();
  const materialId = randomUUID();
  const patrimonyIds = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID()
  ];
  const requestId = randomUUID();
  const registeredRequestId = randomUUID();
  const supplierId = randomUUID();
  const activeContractId = randomUUID();
  const inactiveContractId = randomUUID();
  const patrimonyTeamId = randomUUID();
  const triageTeamId = randomUUID();
  const managerTeamId = randomUUID();
  const globalPatrimonyUserId = randomUUID();
  const compatibleGrePatrimonyUserId = randomUUID();
  const incompatibleGrePatrimonyUserId = randomUUID();
  const inactivePatrimonyUserId = randomUUID();
  const triageUserId = randomUUID();
  const technicalUserId = randomUUID();
  const managerId = randomUUID();
  const personIds = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID()
  ];

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at") values
      ($1, $2, 'GRE Manutenção', current_timestamp),
      ($3, $4, 'GRE Externa', current_timestamp)`,
    [compatibleGreId, compatibleGreCode, incompatibleGreId, incompatibleGreCode]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at") values
      ($1, $2, 'Entidade solicitante', 'ESCOLA', $3, current_timestamp),
      ($4, $5, 'Entidade externa', 'ESCOLA', $6, current_timestamp)`,
    [
      entityId,
      `ENT-MS-${suffix}`,
      compatibleGreId,
      incompatibleEntityId,
      `ENT-OUT-${suffix}`,
      incompatibleGreId
    ]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Informática', current_timestamp)`,
    [materialClassId, `CLASSE-MS-${suffix}`]
  );
  await client.query(
    `insert into "material_singular" (
       "id", "code", "name", "class_id", "control_type", "is_tombable",
       "patrimonial_group_code", "updated_at"
     ) values ($1, $2, 'Computador de manutenção', $3, 'INDIVIDUAL', true, '01', current_timestamp)`,
    [materialId, `MAT-MS-${suffix}`, materialClassId]
  );
  for (const patrimonyId of patrimonyIds) {
    await client.query(
      `insert into "patrimony" (
         "id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at"
       ) values ($1, $2, $3, 'EM_USO', current_timestamp)`,
      [patrimonyId, materialId, entityId]
    );
  }
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at") values
      ($1, 'Patrimônio Global', current_timestamp),
      ($2, 'Patrimônio GRE', current_timestamp),
      ($3, 'Patrimônio GRE incompatível', current_timestamp),
      ($4, 'Patrimônio inativo', current_timestamp),
      ($5, 'Triagem', current_timestamp),
      ($6, 'Superusuário técnico', current_timestamp),
      ($7, 'Gerência', current_timestamp)`,
    personIds
  );
  await client.query(
    `insert into "user_account" (
       "id", "person_id", "login_identifier", "status", "is_technical_superuser", "updated_at"
     ) values
       ($1, $2, $3, 'ACTIVE', false, current_timestamp),
       ($4, $5, $6, 'ACTIVE', false, current_timestamp),
       ($7, $8, $9, 'ACTIVE', false, current_timestamp),
       ($10, $11, $12, 'ACTIVE', false, current_timestamp),
       ($13, $14, $15, 'ACTIVE', false, current_timestamp),
       ($16, $17, $18, 'ACTIVE', true, current_timestamp),
       ($19, $20, $21, 'ACTIVE', false, current_timestamp)`,
    [
      globalPatrimonyUserId,
      personIds[0],
      `patrimonio.global.${loginSuffix}@gmap.test`,
      compatibleGrePatrimonyUserId,
      personIds[1],
      `patrimonio.gre.${loginSuffix}@gmap.test`,
      incompatibleGrePatrimonyUserId,
      personIds[2],
      `patrimonio.incompatible.${loginSuffix}@gmap.test`,
      inactivePatrimonyUserId,
      personIds[3],
      `patrimonio.inactive.${loginSuffix}@gmap.test`,
      triageUserId,
      personIds[4],
      `triagem.${loginSuffix}@gmap.test`,
      technicalUserId,
      personIds[5],
      `technical.${loginSuffix}@gmap.test`,
      managerId,
      personIds[6],
      `gerencia.${loginSuffix}@gmap.test`
    ]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at") values
      ($1, 'Patrimônio', current_timestamp),
      ($2, 'Triagem', current_timestamp),
      ($3, 'Gerência', current_timestamp)`,
    [patrimonyTeamId, triageTeamId, managerTeamId]
  );
  await client.query(
    `insert into "team_membership" (
       "id", "user_id", "team_id", "role", "scope_type", "gre_code", "active", "updated_at"
     ) values
       ($1, $2, $3, 'MEMBRO', 'GLOBAL', null, true, current_timestamp),
       ($4, $5, $3, 'MEMBRO', 'GRE', $6, true, current_timestamp),
       ($7, $8, $3, 'MEMBRO', 'GRE', $9, true, current_timestamp),
       ($10, $11, $3, 'MEMBRO', 'GLOBAL', null, false, current_timestamp),
       ($12, $13, $14, 'MEMBRO', 'GLOBAL', null, true, current_timestamp),
       ($15, $16, $17, 'MEMBRO', 'GLOBAL', null, true, current_timestamp)`,
    [
      randomUUID(),
      globalPatrimonyUserId,
      patrimonyTeamId,
      randomUUID(),
      compatibleGrePatrimonyUserId,
      compatibleGreCode,
      randomUUID(),
      incompatibleGrePatrimonyUserId,
      incompatibleGreCode,
      randomUUID(),
      inactivePatrimonyUserId,
      randomUUID(),
      triageUserId,
      triageTeamId,
      randomUUID(),
      managerId,
      managerTeamId
    ]
  );
  await client.query(
    `insert into "supplier" ("id", "code", "name", "updated_at")
     values ($1, $2, 'Prestador de manutenção', current_timestamp)`,
    [supplierId, `FORN-MS-${suffix}`]
  );
  await client.query(
    `insert into "contract" (
       "id", "code", "supplier_id", "object", "validity_start", "validity_end", "active", "updated_at"
     ) values
       ($1, $2, $3, 'Serviços de manutenção', '2026-01-01', '2026-12-31', true, current_timestamp),
       ($4, $5, $3, 'Contrato inativo', '2026-01-01', '2026-12-31', false, current_timestamp)`,
    [
      activeContractId,
      `CTR-MS-${suffix}`,
      supplierId,
      inactiveContractId,
      `CTR-MS-INACTIVE-${suffix}`
    ]
  );
  await client.query(
    `insert into "maintenance_request" (
       "id", "requesting_entity_id", "status", "summary", "description", "requested_at",
       "registered_by_user_id", "authorized_at", "authorized_by_user_id", "authorization_reason",
       "version", "correlation_id", "updated_at"
     ) values
       ($1, $3, 'EM_ANALISE', 'Solicitação autorizada', 'Descrição da solicitação',
        '2026-11-11T10:00:00.000Z', $4, '2026-11-11T12:00:00.000Z', $5,
        'Autorização da Gerência', 2, $6, current_timestamp),
       ($2, $3, 'REGISTRADA', 'Solicitação registrada', 'Descrição da solicitação',
        '2026-11-11T10:00:00.000Z', $4, null, null, null, 1, $7, current_timestamp)`,
    [
      requestId,
      registeredRequestId,
      entityId,
      triageUserId,
      managerId,
      `corr-${requestId}`,
      `corr-${registeredRequestId}`
    ]
  );
  await client.query(
    `insert into "maintenance_request_patrimony_target" (
       "id", "maintenance_request_id", "patrimony_id", "linked_at", "linked_by_user_id",
       "correlation_id", "updated_at"
     ) values
       ($1, $2, $3, '2026-11-11T13:00:00.000Z', $4, $5, current_timestamp),
       ($6, $2, $7, '2026-11-11T13:00:00.000Z', $4, $5, current_timestamp),
       ($8, $2, $9, '2026-11-11T13:00:00.000Z', $4, $5, current_timestamp),
       ($10, $2, $11, '2026-11-11T13:00:00.000Z', $4, $5, current_timestamp),
       ($12, $2, $13, '2026-11-11T13:00:00.000Z', $4, $5, current_timestamp),
       ($14, $2, $15, '2026-11-11T13:00:00.000Z', $4, $5, current_timestamp),
       ($16, $2, $17, '2026-11-11T13:00:00.000Z', $4, $5, current_timestamp),
       ($18, $19, $20, '2026-11-11T13:00:00.000Z', $4, $21, current_timestamp)`,
    [
      randomUUID(),
      requestId,
      patrimonyIds[0],
      globalPatrimonyUserId,
      `corr-target-${requestId}`,
      randomUUID(),
      patrimonyIds[1],
      randomUUID(),
      patrimonyIds[2],
      randomUUID(),
      patrimonyIds[3],
      randomUUID(),
      patrimonyIds[4],
      randomUUID(),
      patrimonyIds[5],
      randomUUID(),
      patrimonyIds[6],
      randomUUID(),
      registeredRequestId,
      patrimonyIds[7],
      `corr-target-${registeredRequestId}`
    ]
  );

  return {
    requestId,
    registeredRequestId,
    firstPatrimonyId: patrimonyIds[0],
    secondPatrimonyId: patrimonyIds[1],
    contractPatrimonyId: patrimonyIds[2],
    grePatrimonyId: patrimonyIds[3],
    atomicPatrimonyId: patrimonyIds[4],
    registeredPatrimonyId: patrimonyIds[7],
    unlinkedPatrimonyId: patrimonyIds[7],
    allPatrimonyIds: patrimonyIds,
    globalPatrimonyUserId,
    compatibleGrePatrimonyUserId,
    incompatibleGrePatrimonyUserId,
    inactivePatrimonyUserId,
    triageUserId,
    technicalUserId,
    activeContractId,
    inactiveContractId
  };
}
