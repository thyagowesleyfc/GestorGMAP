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

describe("contracts balance movement migration", () => {
  it("stores contract item balance movements as an append-only ledger without position or supply order tables", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'contract_balance_movement'`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["contract_balance_movement"]);

      const enumValues = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"ContractBalanceMovementType"'::regtype
          order by enumlabel`
      );

      expect(enumValues.rows.map((row) => row.enumlabel)).toEqual([
        "ADITIVO",
        "AJUSTE",
        "APOSTILAMENTO",
        "COMPROMETIMENTO_OF",
        "CONTRATACAO"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'contract_balance_movement_code_public_format',
            'contract_balance_movement_contract_change_id_fkey',
            'contract_balance_movement_contract_item_id_fkey',
            'contract_balance_movement_delta_non_zero',
            'contract_balance_movement_summary_not_blank'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "contract_balance_movement_code_public_format",
        "contract_balance_movement_contract_change_id_fkey",
        "contract_balance_movement_contract_item_id_fkey",
        "contract_balance_movement_delta_non_zero",
        "contract_balance_movement_summary_not_blank"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and tablename = 'contract_balance_movement'
            and indexname in (
              'contract_balance_movement_contract_change_id_idx',
              'contract_balance_movement_contract_item_id_idx',
              'contract_balance_movement_item_time_idx',
              'contract_balance_movement_type_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "contract_balance_movement_contract_change_id_idx",
        "contract_balance_movement_contract_item_id_idx",
        "contract_balance_movement_item_time_idx",
        "contract_balance_movement_type_idx"
      ]);

      const supplierId = randomUUID();
      const materialClassId = randomUUID();
      const materialSingularId = randomUUID();
      const contractId = randomUUID();
      const contractItemId = randomUUID();
      const contractChangeId = randomUUID();

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
        `insert into "contract_change" (
          "id", "contract_id", "type", "code", "summary", "effective_on", "updated_at"
        ) values ($1, $2, 'ADITIVO', $3, $4, $5, current_timestamp)`,
        [
          contractChangeId,
          contractId,
          "CTR-2026-001-ADT-001",
          "Prorrogacao e ajuste de valor",
          "2026-07-01"
        ]
      );

      await client.query(
        `insert into "contract_balance_movement" (
          "id", "code", "contract_item_id", "type", "quantity_delta", "amount_delta", "occurred_at", "summary"
        ) values ($1, $2, $3, 'CONTRATACAO', $4, $5, $6, $7)`,
        [
          randomUUID(),
          "CTR-2026-001-ITEM-001-MOV-001",
          contractItemId,
          10,
          "12505.00",
          "2026-01-01T10:00:00.000Z",
          "Saldo contratado inicial"
        ]
      );
      await client.query(
        `insert into "contract_balance_movement" (
          "id", "code", "contract_item_id", "contract_change_id", "type", "quantity_delta", "amount_delta", "occurred_at", "summary"
        ) values ($1, $2, $3, $4, 'ADITIVO', $5, $6, $7, $8)`,
        [
          randomUUID(),
          "CTR-2026-001-ITEM-001-MOV-002",
          contractItemId,
          contractChangeId,
          0,
          "500.00",
          "2026-07-01T10:00:00.000Z",
          "Ajuste de valor sem alterar quantidade"
        ]
      );

      await expect(
        client.query(
          `insert into "contract_balance_movement" (
            "id", "code", "contract_item_id", "type", "quantity_delta", "amount_delta", "occurred_at", "summary"
          ) values ($1, $2, $3, 'CONTRATACAO', $4, $5, $6, $7)`,
          [
            randomUUID(),
            "ctr-2026-001-item-001-mov-003",
            contractItemId,
            1,
            "100.00",
            "2026-01-01T10:00:00.000Z",
            "Codigo invalido"
          ]
        )
      ).rejects.toThrow(/contract_balance_movement_code_public_format/);

      await expect(
        client.query(
          `insert into "contract_balance_movement" (
            "id", "code", "contract_item_id", "type", "quantity_delta", "amount_delta", "occurred_at", "summary"
          ) values ($1, $2, $3, 'AJUSTE', $4, $5, $6, $7)`,
          [
            randomUUID(),
            "CTR-2026-001-ITEM-001-MOV-003",
            contractItemId,
            0,
            "0.00",
            "2026-01-01T10:00:00.000Z",
            "Sem efeito"
          ]
        )
      ).rejects.toThrow(/contract_balance_movement_delta_non_zero/);

      await expect(
        client.query(
          `insert into "contract_balance_movement" (
            "id", "code", "contract_item_id", "type", "quantity_delta", "amount_delta", "occurred_at", "summary"
          ) values ($1, $2, $3, 'AJUSTE', $4, $5, $6, $7)`,
          [
            randomUUID(),
            "CTR-2026-001-ITEM-001-MOV-004",
            contractItemId,
            1,
            "1.00",
            "2026-01-01T10:00:00.000Z",
            "  "
          ]
        )
      ).rejects.toThrow(/contract_balance_movement_summary_not_blank/);

      await expect(
        client.query(
          `insert into "contract_balance_movement" (
            "id", "code", "contract_item_id", "type", "quantity_delta", "amount_delta", "occurred_at", "summary"
          ) values ($1, $2, $3, 'AJUSTE', $4, $5, $6, $7)`,
          [
            randomUUID(),
            "CTR-2026-001-ITEM-001-MOV-005",
            randomUUID(),
            1,
            "1.00",
            "2026-01-01T10:00:00.000Z",
            "Item inexistente"
          ]
        )
      ).rejects.toThrow(/contract_balance_movement_contract_item_id_fkey/);

      await expect(
        client.query(
          `insert into "contract_balance_movement" (
            "id", "code", "contract_item_id", "contract_change_id", "type", "quantity_delta", "amount_delta", "occurred_at", "summary"
          ) values ($1, $2, $3, $4, 'ADITIVO', $5, $6, $7, $8)`,
          [
            randomUUID(),
            "CTR-2026-001-ITEM-001-MOV-006",
            contractItemId,
            randomUUID(),
            1,
            "1.00",
            "2026-01-01T10:00:00.000Z",
            "Aditivo inexistente"
          ]
        )
      ).rejects.toThrow(/contract_balance_movement_contract_change_id_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
