import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function runPrismaMigrateDeploy(databaseUrl: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");

  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl
    },
    timeout: 90000
  });
}

describe("material request item authorization migration", () => {
  it("persists optional authorized quantities without choosing physical stock", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const columns = await client.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'material_request_item'
            and column_name = 'authorized_quantity'`
      );

      expect(columns.rows).toEqual([{ column_name: "authorized_quantity", is_nullable: "YES" }]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'material_request_item_authorized_quantity_non_negative',
            'material_request_item_authorized_quantity_not_above_requested'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "material_request_item_authorized_quantity_non_negative",
        "material_request_item_authorized_quantity_not_above_requested"
      ]);

      const seed = await seedMaterialRequestItemAuthorizationDependencies(client);

      await insertMaterialRequestItem(client, {
        materialRequestId: seed.materialRequestId,
        lineNumber: 1,
        materialSingularId: seed.materialSingularId,
        requestedQuantity: 5
      });

      await insertMaterialRequestItem(client, {
        materialRequestId: seed.materialRequestId,
        lineNumber: 2,
        materialSingularId: seed.materialSingularId,
        requestedQuantity: 5,
        authorizedQuantity: 0
      });

      await insertMaterialRequestItem(client, {
        materialRequestId: seed.materialRequestId,
        lineNumber: 3,
        materialSingularId: seed.materialSingularId,
        requestedQuantity: 5,
        authorizedQuantity: 3
      });

      await insertMaterialRequestItem(client, {
        materialRequestId: seed.materialRequestId,
        lineNumber: 4,
        materialSingularId: seed.materialSingularId,
        requestedQuantity: 5,
        authorizedQuantity: 5
      });

      await expect(
        insertMaterialRequestItem(client, {
          materialRequestId: seed.materialRequestId,
          lineNumber: 5,
          materialSingularId: seed.materialSingularId,
          requestedQuantity: 5,
          authorizedQuantity: -1
        })
      ).rejects.toThrow(/material_request_item_authorized_quantity_non_negative/);

      await expect(
        insertMaterialRequestItem(client, {
          materialRequestId: seed.materialRequestId,
          lineNumber: 6,
          materialSingularId: seed.materialSingularId,
          requestedQuantity: 5,
          authorizedQuantity: 6
        })
      ).rejects.toThrow(/material_request_item_authorized_quantity_not_above_requested/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type MaterialRequestItemAuthorizationSeed = {
  materialRequestId: string;
  materialSingularId: string;
};

async function seedMaterialRequestItemAuthorizationDependencies(
  client: Client
): Promise<MaterialRequestItemAuthorizationSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialRequestId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-REQ-AUTH", "GRE Autorizacao Solicitacao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'ESCOLA', $4, current_timestamp)`,
    [entityId, "ENT-REQ-AUTH", "Escola Autorizacao Solicitacao", greId]
  );
  await client.query(
    `insert into "material_request" (
      "id", "code", "requesting_entity_id", "requested_at", "summary", "updated_at"
    ) values ($1, $2, $3, $4, $5, current_timestamp)`,
    [
      materialRequestId,
      "SOL-MAT-AUTH-0001",
      entityId,
      "2026-09-24T15:00:00.000Z",
      "Solicitacao com autorizacao parcial"
    ]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, "REQAUTH", "Materiais autorizaveis"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [materialSingularId, "MAT-REQ-AUTH", "Monitor autorizavel", materialClassId, "EQUIPAMENTO"]
  );

  return { materialRequestId, materialSingularId };
}

async function insertMaterialRequestItem(
  client: Client,
  input: {
    materialRequestId: string;
    lineNumber: number;
    materialSingularId: string;
    requestedQuantity: number;
    authorizedQuantity?: number;
  }
): Promise<void> {
  await client.query(
    `insert into "material_request_item" (
      "id", "material_request_id", "line_number", "material_singular_id", "requested_quantity", "authorized_quantity", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      randomUUID(),
      input.materialRequestId,
      input.lineNumber,
      input.materialSingularId,
      input.requestedQuantity,
      input.authorizedQuantity ?? null
    ]
  );
}
