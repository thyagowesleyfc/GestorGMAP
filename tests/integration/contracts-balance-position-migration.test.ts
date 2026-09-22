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

describe("contracts balance position migration", () => {
  it("stores the current contract item balance position without creating supply orders", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('contract_balance_movement', 'contract_balance_position')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "contract_balance_movement",
        "contract_balance_position"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'contract_balance_position_amount_balance',
            'contract_balance_position_amounts_non_negative',
            'contract_balance_position_contract_item_id_fkey',
            'contract_balance_position_quantity_balance',
            'contract_balance_position_quantities_non_negative',
            'contract_balance_position_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "contract_balance_position_amount_balance",
        "contract_balance_position_amounts_non_negative",
        "contract_balance_position_contract_item_id_fkey",
        "contract_balance_position_quantities_non_negative",
        "contract_balance_position_quantity_balance",
        "contract_balance_position_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and tablename = 'contract_balance_position'
            and indexname in (
              'contract_balance_position_contract_item_id_key'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "contract_balance_position_contract_item_id_key"
      ]);

      const supplierId = randomUUID();
      const materialClassId = randomUUID();
      const materialSingularId = randomUUID();
      const contractId = randomUUID();
      const contractItemId = randomUUID();

      await client.query(
        `insert into "supplier" ("id", "code", "name", "tax_id", "updated_at")
         values ($1, $2, $3, $4, current_timestamp)`,
        [supplierId, "FORN-TECNOLOGIA", "Fornecedor de Tecnologia Ltda", "12345678000199"]
      );
      await client.query(
        `insert into "material_class" ("id", "code", "name", "updated_at")
         values ($1, $2, $3, current_timestamp)`,
        [materialClassId, "INFORMATICA", "Informatica"]
      );
      await client.query(
        `insert into "material_singular" (
          "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
        ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
        [materialSingularId, "MAT-MONITOR", "Monitor", materialClassId, "EQUIPAMENTO"]
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
        `insert into "contract_item" (
          "id", "code", "contract_id", "line_number", "material_singular_id", "contracted_quantity", "unit_price", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
        [contractItemId, "CTR-2026-001-ITEM-001", contractId, 1, materialSingularId, 10, "1250.50"]
      );
      await client.query(
        `insert into "contract_balance_position" (
          "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
          "total_amount", "committed_amount", "available_amount", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
        [randomUUID(), contractItemId, 10, 2, 8, "12505.00", "2501.00", "10004.00"]
      );

      await expect(
        client.query(
          `insert into "contract_balance_position" (
            "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
            "total_amount", "committed_amount", "available_amount", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
          [randomUUID(), contractItemId, 10, 0, 10, "12505.00", "0.00", "12505.00"]
        )
      ).rejects.toThrow(/contract_balance_position_contract_item_id_key/);

      await expect(
        client.query(
          `insert into "contract_balance_position" (
            "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
            "total_amount", "committed_amount", "available_amount", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
          [randomUUID(), randomUUID(), 1, 0, 1, "1.00", "0.00", "1.00"]
        )
      ).rejects.toThrow(/contract_balance_position_contract_item_id_fkey/);

      await expect(
        client.query(
          `insert into "contract_balance_position" (
            "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
            "total_amount", "committed_amount", "available_amount", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
          [randomUUID(), randomUUID(), 10, 9, 2, "10.00", "9.00", "1.00"]
        )
      ).rejects.toThrow(/contract_balance_position_quantity_balance/);

      await expect(
        client.query(
          `insert into "contract_balance_position" (
            "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
            "total_amount", "committed_amount", "available_amount", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
          [randomUUID(), randomUUID(), 10, 0, 10, "10.00", "9.00", "2.00"]
        )
      ).rejects.toThrow(/contract_balance_position_amount_balance/);

      await expect(
        client.query(
          `insert into "contract_balance_position" (
            "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
            "total_amount", "committed_amount", "available_amount", "version", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, current_timestamp)`,
          [randomUUID(), randomUUID(), 10, 0, 10, "10.00", "0.00", "10.00", 0]
        )
      ).rejects.toThrow(/contract_balance_position_version_positive/);

      await expect(
        client.query(
          `insert into "contract_balance_position" (
            "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
            "total_amount", "committed_amount", "available_amount", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
          [randomUUID(), randomUUID(), -1, 0, -1, "10.00", "0.00", "10.00"]
        )
      ).rejects.toThrow(/contract_balance_position_quantities_non_negative/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
