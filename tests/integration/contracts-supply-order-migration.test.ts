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

describe("contracts supply order migration", () => {
  it("creates supply orders and items without implementing cancellation or stock movement", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('supply_order', 'supply_order_item')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "supply_order",
        "supply_order_item"
      ]);

      const enumValues = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"SupplyOrderStatus"'::regtype
          order by enumlabel`
      );

      expect(enumValues.rows.map((row) => row.enumlabel)).toEqual(["CANCELADA", "EMITIDA"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'supply_order_code_public_format',
            'supply_order_contract_id_fkey',
            'supply_order_item_contract_item_contract_fkey',
            'supply_order_item_line_number_positive',
            'supply_order_item_quantity_positive',
            'supply_order_item_supply_order_contract_fkey',
            'supply_order_item_total_amount_consistent',
            'supply_order_item_unit_price_non_negative',
            'supply_order_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "supply_order_code_public_format",
        "supply_order_contract_id_fkey",
        "supply_order_item_contract_item_contract_fkey",
        "supply_order_item_line_number_positive",
        "supply_order_item_quantity_positive",
        "supply_order_item_supply_order_contract_fkey",
        "supply_order_item_total_amount_consistent",
        "supply_order_item_unit_price_non_negative",
        "supply_order_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'contract_item_id_contract_id_key',
              'supply_order_code_key',
              'supply_order_contract_id_idx',
              'supply_order_id_contract_id_key',
              'supply_order_item_contract_id_idx',
              'supply_order_item_contract_item_id_idx',
              'supply_order_item_order_line_key',
              'supply_order_status_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "contract_item_id_contract_id_key",
        "supply_order_code_key",
        "supply_order_contract_id_idx",
        "supply_order_id_contract_id_key",
        "supply_order_item_contract_id_idx",
        "supply_order_item_contract_item_id_idx",
        "supply_order_item_order_line_key",
        "supply_order_status_idx"
      ]);

      const supplierId = randomUUID();
      const materialClassId = randomUUID();
      const monitorId = randomUUID();
      const keyboardId = randomUUID();
      const contractId = randomUUID();
      const otherContractId = randomUUID();
      const contractItemId = randomUUID();
      const otherContractItemId = randomUUID();
      const supplyOrderId = randomUUID();

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
        [monitorId, "MAT-MONITOR", "Monitor", materialClassId, "EQUIPAMENTO"]
      );
      await client.query(
        `insert into "material_singular" (
          "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
        ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
        [keyboardId, "MAT-TECLADO", "Teclado", materialClassId, "EQUIPAMENTO"]
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
        `insert into "contract" (
          "id", "code", "supplier_id", "object", "validity_start", "validity_end", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
        [
          otherContractId,
          "CTR-2026-002",
          supplierId,
          "Aquisicao de perifericos",
          "2026-01-01",
          "2026-12-31"
        ]
      );
      await client.query(
        `insert into "contract_item" (
          "id", "code", "contract_id", "line_number", "material_singular_id", "contracted_quantity", "unit_price", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
        [contractItemId, "CTR-2026-001-ITEM-001", contractId, 1, monitorId, 10, "1250.50"]
      );
      await client.query(
        `insert into "contract_item" (
          "id", "code", "contract_id", "line_number", "material_singular_id", "contracted_quantity", "unit_price", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
        [otherContractItemId, "CTR-2026-002-ITEM-001", otherContractId, 1, keyboardId, 10, "100.00"]
      );

      await client.query(
        `insert into "supply_order" (
          "id", "code", "contract_id", "issued_at", "updated_at"
        ) values ($1, $2, $3, $4, current_timestamp)`,
        [supplyOrderId, "OF-2026-0001", contractId, "2026-09-22T10:00:00.000Z"]
      );
      await client.query(
        `insert into "supply_order_item" (
          "id", "supply_order_id", "contract_id", "contract_item_id", "line_number", "quantity", "unit_price", "total_amount", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
        [randomUUID(), supplyOrderId, contractId, contractItemId, 1, 2, "1250.50", "2501.00"]
      );

      await expect(
        client.query(
          `insert into "supply_order" (
            "id", "code", "contract_id", "issued_at", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), "of-2026-0002", contractId, "2026-09-22T10:00:00.000Z"]
        )
      ).rejects.toThrow(/supply_order_code_public_format/);

      await expect(
        client.query(
          `insert into "supply_order" (
            "id", "code", "contract_id", "issued_at", "version", "updated_at"
          ) values ($1, $2, $3, $4, $5, current_timestamp)`,
          [randomUUID(), "OF-2026-0002", contractId, "2026-09-22T10:00:00.000Z", 0]
        )
      ).rejects.toThrow(/supply_order_version_positive/);

      await expect(
        client.query(
          `insert into "supply_order_item" (
            "id", "supply_order_id", "contract_id", "contract_item_id", "line_number", "quantity", "unit_price", "total_amount", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
          [randomUUID(), supplyOrderId, contractId, contractItemId, 1, 1, "1250.50", "1250.50"]
        )
      ).rejects.toThrow(/supply_order_item_order_line_key/);

      await expect(
        client.query(
          `insert into "supply_order_item" (
            "id", "supply_order_id", "contract_id", "contract_item_id", "line_number", "quantity", "unit_price", "total_amount", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
          [randomUUID(), supplyOrderId, contractId, contractItemId, 2, 0, "1250.50", "0.00"]
        )
      ).rejects.toThrow(/supply_order_item_quantity_positive/);

      await expect(
        client.query(
          `insert into "supply_order_item" (
            "id", "supply_order_id", "contract_id", "contract_item_id", "line_number", "quantity", "unit_price", "total_amount", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
          [randomUUID(), supplyOrderId, contractId, contractItemId, 2, 1, "-1.00", "-1.00"]
        )
      ).rejects.toThrow(/supply_order_item_unit_price_non_negative/);

      await expect(
        client.query(
          `insert into "supply_order_item" (
            "id", "supply_order_id", "contract_id", "contract_item_id", "line_number", "quantity", "unit_price", "total_amount", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
          [randomUUID(), supplyOrderId, contractId, contractItemId, 2, 2, "1250.50", "2500.99"]
        )
      ).rejects.toThrow(/supply_order_item_total_amount_consistent/);

      await expect(
        client.query(
          `insert into "supply_order_item" (
            "id", "supply_order_id", "contract_id", "contract_item_id", "line_number", "quantity", "unit_price", "total_amount", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
          [randomUUID(), supplyOrderId, contractId, otherContractItemId, 2, 1, "100.00", "100.00"]
        )
      ).rejects.toThrow(/supply_order_item_contract_item_contract_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
