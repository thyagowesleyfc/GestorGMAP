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

describe("contracts contract base migration", () => {
  it("creates contracts and contract items without saldo or OF side effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('contract', 'contract_item')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["contract", "contract_item"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'contract_code_public_format',
            'contract_item_catalog_reference_xor',
            'contract_item_code_public_format',
            'contract_item_contract_id_fkey',
            'contract_item_contracted_quantity_positive',
            'contract_item_line_number_positive',
            'contract_item_material_configuration_id_fkey',
            'contract_item_material_singular_id_fkey',
            'contract_item_unit_price_non_negative',
            'contract_object_not_blank',
            'contract_supplier_id_fkey',
            'contract_validity_period',
            'contract_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "contract_code_public_format",
        "contract_item_catalog_reference_xor",
        "contract_item_code_public_format",
        "contract_item_contract_id_fkey",
        "contract_item_contracted_quantity_positive",
        "contract_item_line_number_positive",
        "contract_item_material_configuration_id_fkey",
        "contract_item_material_singular_id_fkey",
        "contract_item_unit_price_non_negative",
        "contract_object_not_blank",
        "contract_supplier_id_fkey",
        "contract_validity_period",
        "contract_version_positive"
      ]);

      const supplierId = randomUUID();
      const materialClassId = randomUUID();
      const monitorId = randomUUID();
      const keyboardId = randomUUID();
      const configurationId = randomUUID();
      const contractId = randomUUID();

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
        `insert into "material_configuration" ("id", "code", "name", "configuration_type", "updated_at")
         values ($1, $2, $3, 'COMPOSTO', current_timestamp)`,
        [configurationId, "CFG-MICRO", "Microcomputador"]
      );
      await client.query(
        `insert into "material_configuration_component" (
          "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
        ) values ($1, $2, $3, 1, current_timestamp)`,
        [randomUUID(), configurationId, monitorId]
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
        [randomUUID(), "CTR-2026-001-ITEM-001", contractId, 1, monitorId, 10, "1250.50"]
      );
      await client.query(
        `insert into "contract_item" (
          "id", "code", "contract_id", "line_number", "material_configuration_id", "contracted_quantity", "unit_price", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
        [randomUUID(), "CTR-2026-001-ITEM-002", contractId, 2, configurationId, 5, "2200.00"]
      );

      await expect(
        client.query(
          `insert into "contract" (
            "id", "code", "supplier_id", "object", "validity_start", "validity_end", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
          [randomUUID(), "ctr-2026-002", supplierId, "Codigo invalido", "2026-01-01", "2026-12-31"]
        )
      ).rejects.toThrow(/contract_code_public_format/);

      await expect(
        client.query(
          `insert into "contract" (
            "id", "code", "supplier_id", "object", "validity_start", "validity_end", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
          [randomUUID(), "CTR-2026-003", supplierId, " ", "2026-01-01", "2026-12-31"]
        )
      ).rejects.toThrow(/contract_object_not_blank/);

      await expect(
        client.query(
          `insert into "contract" (
            "id", "code", "supplier_id", "object", "validity_start", "validity_end", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
          [
            randomUUID(),
            "CTR-2026-004",
            supplierId,
            "Vigencia invalida",
            "2026-12-31",
            "2026-01-01"
          ]
        )
      ).rejects.toThrow(/contract_validity_period/);

      await expect(
        client.query(
          `insert into "contract_item" (
            "id", "code", "contract_id", "line_number", "material_singular_id", "contracted_quantity", "unit_price", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
          [randomUUID(), "CTR-2026-001-ITEM-003", contractId, 2, keyboardId, 1, "100.00"]
        )
      ).rejects.toThrow(/contract_item_contract_line_number_key/);

      await expect(
        client.query(
          `insert into "contract_item" (
            "id", "code", "contract_id", "line_number", "material_singular_id", "contracted_quantity", "unit_price", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
          [randomUUID(), "ctr-2026-001-item-004", contractId, 4, keyboardId, 1, "100.00"]
        )
      ).rejects.toThrow(/contract_item_code_public_format/);

      await expect(
        client.query(
          `insert into "contract_item" (
            "id", "code", "contract_id", "line_number", "material_singular_id", "contracted_quantity", "unit_price", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
          [randomUUID(), "CTR-2026-001-ITEM-005", contractId, 5, keyboardId, 0, "100.00"]
        )
      ).rejects.toThrow(/contract_item_contracted_quantity_positive/);

      await expect(
        client.query(
          `insert into "contract_item" (
            "id", "code", "contract_id", "line_number", "material_singular_id", "contracted_quantity", "unit_price", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
          [randomUUID(), "CTR-2026-001-ITEM-006", contractId, 6, keyboardId, 1, "-1.00"]
        )
      ).rejects.toThrow(/contract_item_unit_price_non_negative/);

      await expect(
        client.query(
          `insert into "contract_item" (
            "id", "code", "contract_id", "line_number", "contracted_quantity", "unit_price", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
          [randomUUID(), "CTR-2026-001-ITEM-007", contractId, 7, 1, "100.00"]
        )
      ).rejects.toThrow(/contract_item_catalog_reference_xor/);

      await expect(
        client.query(
          `insert into "contract_item" (
            "id", "code", "contract_id", "line_number", "material_singular_id", "material_configuration_id", "contracted_quantity", "unit_price", "updated_at"
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
          [
            randomUUID(),
            "CTR-2026-001-ITEM-008",
            contractId,
            8,
            keyboardId,
            configurationId,
            1,
            "100.00"
          ]
        )
      ).rejects.toThrow(/contract_item_catalog_reference_xor/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
