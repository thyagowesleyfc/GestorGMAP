import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { GetEntityPatrimonyInventory } from "../../src/modules/patrimony/application/get-entity-patrimony-inventory";
import { PostgresEntityPatrimonyInventoryReader } from "../../src/modules/patrimony/infrastructure/postgres-entity-patrimony-inventory-reader";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("get entity patrimony inventory", () => {
  it("lista a posição atual da Entidade com escopo e paginação", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();
      const seed = await seedInventory(client);
      const query = new GetEntityPatrimonyInventory(
        new PostgresEntityPatrimonyInventoryReader(pool)
      );

      await expect(
        query.execute({ entityId: seed.entityId, actorUserId: seed.unauthorizedUserId })
      ).resolves.toEqual({ ok: false, reason: "ACTOR_NOT_AUTHORIZED" });

      const firstPage = await query.execute({
        entityId: seed.entityId,
        actorUserId: seed.authorizedUserId,
        limit: 1,
        offset: 0
      });
      const secondPage = await query.execute({
        entityId: seed.entityId,
        actorUserId: seed.authorizedUserId,
        limit: 1,
        offset: 1
      });

      expect(firstPage).toMatchObject({
        ok: true,
        inventory: {
          entity: {
            id: seed.entityId,
            code: "ENT-PAT-INVENTORY",
            greCode: "GRE-PAT-INVENTORY"
          },
          page: { limit: 1, offset: 0, returned: 1, total: 2 },
          entries: [
            {
              patrimonyId: seed.activeTombablePatrimonyId,
              materialCode: "MAT-PAT-INVENTORY-01",
              controlType: "INDIVIDUAL",
              isTombable: true,
              operationalState: "EM_USO",
              activeTombo: {
                tombo: "011-01-000401",
                patrimonialGroupCode: "01"
              },
              latestComposition: {
                revision: 1,
                configurationCode: "CFG-PAT-INVENTORY"
              }
            }
          ]
        }
      });
      expect(secondPage).toMatchObject({
        ok: true,
        inventory: {
          page: { limit: 1, offset: 1, returned: 1, total: 2 },
          entries: [
            {
              patrimonyId: seed.activeQuantitativePatrimonyId,
              materialCode: "MAT-PAT-INVENTORY-02",
              controlType: "QUANTITATIVO",
              isTombable: false,
              operationalState: "EM_MANUTENCAO",
              activeTombo: null,
              latestComposition: null
            }
          ]
        }
      });

      if (firstPage.ok && secondPage.ok) {
        expect(firstPage.inventory.entries[0]?.patrimonyId).not.toBe(
          secondPage.inventory.entries[0]?.patrimonyId
        );
      }

      await expect(
        query.execute({
          entityId: seed.entityId,
          actorUserId: seed.authorizedUserId,
          materialCode: "MAT-PAT-INVENTORY-02",
          operationalStates: ["EM_MANUTENCAO"]
        })
      ).resolves.toMatchObject({
        ok: true,
        inventory: {
          page: { limit: 50, offset: 0, returned: 1, total: 1 },
          entries: [
            {
              patrimonyId: seed.activeQuantitativePatrimonyId,
              materialCode: "MAT-PAT-INVENTORY-02"
            }
          ]
        }
      });

      const inventoryIncludingWrittenOff = await query.execute({
        entityId: seed.entityId,
        actorUserId: seed.authorizedUserId,
        includeWrittenOff: true
      });
      expect(inventoryIncludingWrittenOff.ok).toBe(true);
      if (inventoryIncludingWrittenOff.ok) {
        expect(inventoryIncludingWrittenOff.inventory.page).toEqual({
          limit: 50,
          offset: 0,
          returned: 3,
          total: 3
        });
        expect(inventoryIncludingWrittenOff.inventory.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              patrimonyId: seed.writtenOffPatrimonyId,
              operationalState: "BAIXADO",
              activeTombo: null
            })
          ])
        );
      }
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type InventorySeed = {
  entityId: string;
  activeTombablePatrimonyId: string;
  activeQuantitativePatrimonyId: string;
  writtenOffPatrimonyId: string;
  authorizedUserId: string;
  unauthorizedUserId: string;
};

async function seedInventory(client: Client): Promise<InventorySeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const classId = randomUUID();
  const materialOneId = randomUUID();
  const materialTwoId = randomUUID();
  const configId = randomUUID();
  const activeTombablePatrimonyId = randomUUID();
  const activeQuantitativePatrimonyId = randomUUID();
  const writtenOffPatrimonyId = randomUUID();
  const tomboId = randomUUID();
  const compositionId = randomUUID();
  const authorizedPersonId = randomUUID();
  const authorizedUserId = randomUUID();
  const unauthorizedPersonId = randomUUID();
  const unauthorizedUserId = randomUUID();
  const teamId = randomUUID();
  const greCode = "GRE-PAT-INVENTORY";

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, 'GRE Inventory', current_timestamp)`,
    [greId, greCode]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, 'ENT-PAT-INVENTORY', 'Entidade Inventory', 'ESCOLA', $2, current_timestamp)`,
    [entityId, greId]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, 'CL-PAT-INVENTORY', 'Classe Inventory', current_timestamp)`,
    [classId]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable",
      "patrimonial_group_code", "updated_at"
    ) values ($1, 'MAT-PAT-INVENTORY-01', 'Material Tombável Inventory', $3, 'INDIVIDUAL', true, '01', current_timestamp),
             ($2, 'MAT-PAT-INVENTORY-02', 'Material Quantitativo Inventory', $3, 'QUANTITATIVO', false, null, current_timestamp)`,
    [materialOneId, materialTwoId, classId]
  );
  await client.query(
    `insert into "material_configuration" (
      "id", "code", "name", "configuration_type", "updated_at"
    ) values ($1, 'CFG-PAT-INVENTORY', 'Configuração Inventory', 'COMPOSTO', current_timestamp)`,
    [configId]
  );
  await client.query(
    `insert into "patrimony" (
      "id", "material_singular_id", "responsible_entity_id", "operational_state", "updated_at"
    ) values ($1, $2, $4, 'EM_USO', current_timestamp),
             ($3, $5, $4, 'EM_MANUTENCAO', current_timestamp),
             ($6, $2, $4, 'BAIXADO', current_timestamp)`,
    [
      activeTombablePatrimonyId,
      materialOneId,
      activeQuantitativePatrimonyId,
      entityId,
      materialTwoId,
      writtenOffPatrimonyId
    ]
  );
  await client.query(
    `insert into "patrimony_tombo" (
      "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
    ) values ($1, $2, '011-01-000401', '01', '2026-01-01T10:00:00.000Z', current_timestamp),
             ($3, $4, '011-01-000402', '01', '2026-01-01T10:00:00.000Z', current_timestamp)`,
    [tomboId, activeTombablePatrimonyId, randomUUID(), writtenOffPatrimonyId]
  );
  await client.query(
    `update "patrimony_tombo"
        set "status" = 'ENCERRADO',
            "retired_at" = '2026-02-01T10:00:00.000Z',
            "retirement_reason" = 'Baixa de teste'
      where "patrimony_id" = $1`,
    [writtenOffPatrimonyId]
  );
  await client.query(
    `insert into "patrimony_composition" (
      "id", "patrimony_id", "revision", "material_configuration_id",
      "configuration_code", "configuration_name", "configuration_type",
      "recorded_at", "updated_at"
    ) values ($1, $2, 1, $3, 'CFG-PAT-INVENTORY', 'Configuração Inventory', 'COMPOSTO', $4, current_timestamp)`,
    [compositionId, activeTombablePatrimonyId, configId, "2026-01-02T10:00:00.000Z"]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, 'Usuário Inventory', current_timestamp),
            ($2, 'Usuário sem escopo Inventory', current_timestamp)`,
    [authorizedPersonId, unauthorizedPersonId]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "updated_at"
    ) values ($1, $2, 'usuario-inventory', current_timestamp),
             ($3, $4, 'usuario-sem-escopo-inventory', current_timestamp)`,
    [authorizedUserId, authorizedPersonId, unauthorizedUserId, unauthorizedPersonId]
  );
  await client.query(
    `insert into "team" ("id", "name", "updated_at")
     values ($1, 'Patrimônio', current_timestamp)`,
    [teamId]
  );
  await client.query(
    `insert into "team_membership" (
      "id", "user_id", "team_id", "role", "scope_type", "gre_code", "updated_at"
    ) values ($1, $2, $3, 'LIDER', 'GRE', $4, current_timestamp)`,
    [randomUUID(), authorizedUserId, teamId, greCode]
  );

  return {
    entityId,
    activeTombablePatrimonyId,
    activeQuantitativePatrimonyId,
    writtenOffPatrimonyId,
    authorizedUserId,
    unauthorizedUserId
  };
}
