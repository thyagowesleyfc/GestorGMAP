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

describe("contracts change migration", () => {
  it("records contract amendments and apostilamentos as historical contract changes", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'contract_change'`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["contract_change"]);

      const forbiddenTables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'supply_order'`
      );

      expect(forbiddenTables.rows).toEqual([]);

      const enumValues = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"ContractChangeType"'::regtype
          order by enumlabel`
      );

      expect(enumValues.rows.map((row) => row.enumlabel)).toEqual(["ADITIVO", "APOSTILAMENTO"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'contract_change_code_public_format',
            'contract_change_contract_id_fkey',
            'contract_change_process_reference_not_blank',
            'contract_change_summary_not_blank'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "contract_change_code_public_format",
        "contract_change_contract_id_fkey",
        "contract_change_process_reference_not_blank",
        "contract_change_summary_not_blank"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and tablename = 'contract_change'
            and indexname in (
              'contract_change_contract_effective_lookup_idx',
              'contract_change_contract_id_idx',
              'contract_change_type_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "contract_change_contract_effective_lookup_idx",
        "contract_change_contract_id_idx",
        "contract_change_type_idx"
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
        `insert into "contract_change" (
          "id", "contract_id", "type", "code", "summary", "effective_on", "signed_on", "process_reference", "updated_at"
        ) values ($1, $2, 'ADITIVO', $3, $4, $5, $6, $7, current_timestamp)`,
        [
          randomUUID(),
          contractId,
          "CTR-2026-001-ADT-001",
          "Prorrogacao de vigencia contratual",
          "2026-07-01",
          "2026-06-20",
          "SEI-0001"
        ]
      );
      await client.query(
        `insert into "contract_change" (
          "id", "contract_id", "type", "code", "summary", "effective_on", "updated_at"
        ) values ($1, $2, 'APOSTILAMENTO', $3, $4, $5, current_timestamp)`,
        [
          randomUUID(),
          contractId,
          "CTR-2026-001-APT-001",
          "Registro formal de ajuste administrativo",
          "2026-08-01"
        ]
      );

      const storedContract = await client.query<{ object: string; validity_end: string }>(
        `select "object", to_char("validity_end", 'YYYY-MM-DD') as validity_end
           from "contract"
          where "id" = $1`,
        [contractId]
      );

      expect(storedContract.rows).toEqual([
        {
          object: "Aquisicao de equipamentos",
          validity_end: "2026-12-31"
        }
      ]);

      await expect(
        client.query(
          `insert into "contract_change" (
            "id", "contract_id", "type", "code", "summary", "effective_on", "updated_at"
          ) values ($1, $2, 'ADITIVO', $3, $4, $5, current_timestamp)`,
          [randomUUID(), randomUUID(), "CTR-2026-002-ADT-001", "Contrato inexistente", "2026-07-01"]
        )
      ).rejects.toThrow(/contract_change_contract_id_fkey/);

      await expect(
        client.query(
          `insert into "contract_change" (
            "id", "contract_id", "type", "code", "summary", "effective_on", "updated_at"
          ) values ($1, $2, 'ADITIVO', $3, $4, $5, current_timestamp)`,
          [randomUUID(), contractId, "ctr-2026-001-adt-002", "Codigo invalido", "2026-07-01"]
        )
      ).rejects.toThrow(/contract_change_code_public_format/);

      await expect(
        client.query(
          `insert into "contract_change" (
            "id", "contract_id", "type", "code", "summary", "effective_on", "updated_at"
          ) values ($1, $2, 'APOSTILAMENTO', $3, $4, $5, current_timestamp)`,
          [randomUUID(), contractId, "CTR-2026-001-APT-002", "  ", "2026-07-01"]
        )
      ).rejects.toThrow(/contract_change_summary_not_blank/);

      await expect(
        client.query(
          `insert into "contract_change" (
            "id", "contract_id", "type", "code", "summary", "effective_on", "process_reference", "updated_at"
          ) values ($1, $2, 'ADITIVO', $3, $4, $5, $6, current_timestamp)`,
          [
            randomUUID(),
            contractId,
            "CTR-2026-001-ADT-003",
            "Referencia invalida",
            "2026-07-01",
            " "
          ]
        )
      ).rejects.toThrow(/contract_change_process_reference_not_blank/);

      await expect(
        client.query(
          `insert into "contract_change" (
            "id", "contract_id", "type", "code", "summary", "effective_on", "updated_at"
          ) values ($1, $2, 'ADITIVO', $3, $4, $5, current_timestamp)`,
          [randomUUID(), contractId, "CTR-2026-001-ADT-001", "Codigo duplicado", "2026-09-01"]
        )
      ).rejects.toThrow(/contract_change_code_key/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
