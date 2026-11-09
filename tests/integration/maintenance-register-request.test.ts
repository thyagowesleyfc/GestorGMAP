import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { RegisterMaintenanceRequest } from "../../src/modules/maintenance/application/register-maintenance-request";
import { PostgresMaintenanceRequestRegistrar } from "../../src/modules/maintenance/infrastructure/postgres-maintenance-request-registrar";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("register maintenance request", () => {
  it("registra com escopo, referências, idempotência, auditoria e Outbox", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedMaintenanceRequestDependencies(client);
      const useCase = new RegisterMaintenanceRequest(new PostgresMaintenanceRequestRegistrar(pool));

      const baseCommand = {
        commandId: "cmd-maintenance-register-001",
        requestingEntityId: seed.entityId,
        summary: "Computador sem vídeo",
        description: "Equipamento liga, mas não apresenta imagem.",
        references: [
          {
            system: "SEI" as const,
            identifier: "SEI-2026-0001",
            url: "https://sei.example/processo/1"
          }
        ],
        requestedAt: new Date("2026-11-09T12:00:00.000Z"),
        actorUserId: seed.triageUserId,
        teamContext: "Triagem",
        correlationId: "corr-maintenance-register-001"
      };

      await expect(
        useCase.execute({
          ...baseCommand,
          commandId: "cmd-maintenance-technical-user",
          actorUserId: seed.technicalUserId
        })
      ).resolves.toEqual({ ok: false, reason: "ACTOR_NOT_AUTHORIZED" });

      const first = await useCase.execute(baseCommand);
      const retry = await useCase.execute({
        ...baseCommand,
        summary: " Computador sem vídeo ",
        description: " Equipamento liga, mas não apresenta imagem. ",
        references: [
          {
            system: "SEI",
            identifier: " SEI-2026-0001 ",
            url: " https://sei.example/processo/1 "
          }
        ]
      });
      const conflict = await useCase.execute({
        ...baseCommand,
        summary: "Outro resumo"
      });

      expect(first).toEqual({
        ok: true,
        maintenanceRequestId: expect.any(String),
        status: "REGISTRADA",
        referenceCount: 1
      });
      expect(retry).toEqual(first);
      expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" });

      const duplicateReference = await useCase.execute({
        ...baseCommand,
        commandId: "cmd-maintenance-duplicate-reference",
        summary: "Solicitação concorrente",
        references: [{ system: "SEI", identifier: "SEI-2026-0001" }]
      });
      expect(duplicateReference).toEqual({ ok: false, reason: "DUPLICATE_REFERENCE" });

      const request = await client.query<{
        requesting_entity_id: string;
        status: string;
        summary: string;
        description: string;
        registered_by_user_id: string;
        version: number;
        correlation_id: string;
      }>(
        `select "requesting_entity_id", "status"::text, "summary", "description",
                "registered_by_user_id", "version", "correlation_id"
           from "maintenance_request"`
      );
      expect(request.rows).toEqual([
        {
          requesting_entity_id: seed.entityId,
          status: "REGISTRADA",
          summary: "Computador sem vídeo",
          description: "Equipamento liga, mas não apresenta imagem.",
          registered_by_user_id: seed.triageUserId,
          version: 1,
          correlation_id: "corr-maintenance-register-001"
        }
      ]);

      const references = await client.query<{
        system: string;
        identifier: string;
        url: string | null;
      }>(
        `select "system"::text, "identifier", "url"
           from "maintenance_request_reference"`
      );
      expect(references.rows).toEqual([
        { system: "SEI", identifier: "SEI-2026-0001", url: "https://sei.example/processo/1" }
      ]);

      const effects = await client.query<{
        audits: number;
        outbox: number;
        idempotency: number;
      }>(
        `select
           (select count(*)::int from "audit_entry"
             where "action" = 'maintenance.request_registered') as "audits",
           (select count(*)::int from "outbox_event"
             where "event_type" = 'maintenance.request_registered') as "outbox",
           (select count(*)::int from "command_idempotency"
             where "command_name" = 'maintenance.register_request') as "idempotency"`
      );
      expect(effects.rows).toEqual([{ audits: 1, outbox: 1, idempotency: 2 }]);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function seedMaintenanceRequestDependencies(client: Client): Promise<{
  entityId: string;
  triageUserId: string;
  technicalUserId: string;
}> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const greId = randomUUID();
  const entityId = randomUUID();
  const triagePersonId = randomUUID();
  const triageUserId = randomUUID();
  const technicalPersonId = randomUUID();
  const technicalUserId = randomUUID();
  const teamId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, `GRE-MNT-${suffix}`, "GRE Manutenção"]
  );
  await client.query(
    `insert into "entity" ("id", "code", "name", "entity_type", "gre_id", "updated_at")
     values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [entityId, `ENT-MNT-${suffix}`, "Entidade solicitante de manutenção", greId]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Usuário Triagem Manutenção', current_timestamp),
            ($2, 'Superusuário Técnico Manutenção', current_timestamp)`,
    [triagePersonId, technicalPersonId]
  );
  await client.query(
    `insert into "user_account" (
       "id", "person_id", "login_identifier", "is_technical_superuser", "updated_at"
     ) values ($1, $2, $3, false, current_timestamp),
              ($4, $5, $6, true, current_timestamp)`,
    [
      triageUserId,
      triagePersonId,
      `triagem.manutencao.${suffix.toLowerCase()}@gmap.local`,
      technicalUserId,
      technicalPersonId,
      `superuser.manutencao.${suffix.toLowerCase()}@gmap.local`
    ]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at")
     values ($1, 'Triagem', current_timestamp)`,
    [teamId]
  );
  await client.query(
    `insert into "team_membership" (
       "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
     ) values ($1, $2, $3, 'MEMBRO', 'GRE', $4, current_timestamp)`,
    [randomUUID(), triageUserId, teamId, `GRE-MNT-${suffix}`]
  );

  return { entityId, triageUserId, technicalUserId };
}
