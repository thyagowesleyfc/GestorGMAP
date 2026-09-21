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

describe("contracts designation migration", () => {
  it("stores contract manager and inspector designations as descriptive temporal records", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'contract_designation'`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["contract_designation"]);

      const userLinkColumns = await client.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'contract_designation'
            and column_name in ('user_id', 'person_id')`
      );

      expect(userLinkColumns.rows).toEqual([]);

      const enumValues = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"ContractDesignationRole"'::regtype
          order by enumlabel`
      );

      expect(enumValues.rows.map((row) => row.enumlabel)).toEqual(["FISCAL", "GESTOR"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'contract_designation_contract_id_fkey',
            'contract_designation_holder_document_format',
            'contract_designation_holder_name_not_blank',
            'contract_designation_period'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "contract_designation_contract_id_fkey",
        "contract_designation_holder_document_format",
        "contract_designation_holder_name_not_blank",
        "contract_designation_period"
      ]);

      const supplierId = randomUUID();
      const contractId = randomUUID();

      await client.query(
        `insert into "supplier" ("id", "code", "name", "tax_id", "updated_at")
         values ($1, $2, $3, $4, current_timestamp)`,
        [supplierId, "FORN-TECNOLOGIA", "Fornecedor de Tecnologia Ltda", "12345678000199"]
      );
      await client.query(
        `insert into "contract" (
          "id", "code", "supplier_id", "object", "validity_start", "validity_end", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
        [
          contractId,
          "CTR-2026-001",
          supplierId,
          "Aquisicao de equipamentos",
          "2026-01-01",
          "2026-12-31"
        ]
      );
      await client.query(
        `insert into "contract_designation" (
          "id", "contract_id", "role", "holder_name", "holder_document", "starts_on", "ends_on", "updated_at"
        ) values ($1, $2, 'GESTOR', $3, $4, $5, $6, current_timestamp)`,
        [
          randomUUID(),
          contractId,
          "Gestor Legal do Contrato",
          "12345678901",
          "2026-01-01",
          "2026-12-31"
        ]
      );
      await client.query(
        `insert into "contract_designation" (
          "id", "contract_id", "role", "holder_name", "starts_on", "updated_at"
        ) values ($1, $2, 'FISCAL', $3, $4, current_timestamp)`,
        [randomUUID(), contractId, "Fiscal Legal do Contrato", "2026-01-01"]
      );

      await expect(
        client.query(
          `insert into "contract_designation" (
            "id", "contract_id", "role", "holder_name", "starts_on", "updated_at"
          ) values ($1, $2, 'GESTOR', $3, $4, current_timestamp)`,
          [randomUUID(), randomUUID(), "Contrato inexistente", "2026-01-01"]
        )
      ).rejects.toThrow(/contract_designation_contract_id_fkey/);

      await expect(
        client.query(
          `insert into "contract_designation" (
            "id", "contract_id", "role", "holder_name", "starts_on", "updated_at"
          ) values ($1, $2, 'GESTOR', $3, $4, current_timestamp)`,
          [randomUUID(), contractId, "  ", "2026-01-01"]
        )
      ).rejects.toThrow(/contract_designation_holder_name_not_blank/);

      await expect(
        client.query(
          `insert into "contract_designation" (
            "id", "contract_id", "role", "holder_name", "holder_document", "starts_on", "updated_at"
          ) values ($1, $2, 'FISCAL', $3, $4, $5, current_timestamp)`,
          [randomUUID(), contractId, "Documento invalido", "ABC123", "2026-01-01"]
        )
      ).rejects.toThrow(/contract_designation_holder_document_format/);

      await expect(
        client.query(
          `insert into "contract_designation" (
            "id", "contract_id", "role", "holder_name", "starts_on", "ends_on", "updated_at"
          ) values ($1, $2, 'FISCAL', $3, $4, $5, current_timestamp)`,
          [randomUUID(), contractId, "Periodo invalido", "2026-12-31", "2026-01-01"]
        )
      ).rejects.toThrow(/contract_designation_period/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
