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

describe("contracts supply order cancellation migration", () => {
  it("stores a supply order cancellation workflow without applying balance effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'supply_order_cancellation'`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["supply_order_cancellation"]);

      const cancellationEnumValues = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"SupplyOrderCancellationStatus"'::regtype
          order by enumlabel`
      );

      expect(cancellationEnumValues.rows.map((row) => row.enumlabel)).toEqual([
        "AUTORIZADA",
        "EFETIVADA",
        "PREPARADA",
        "REJEITADA"
      ]);

      const supplyOrderStatusValues = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"SupplyOrderStatus"'::regtype
          order by enumlabel`
      );

      expect(supplyOrderStatusValues.rows.map((row) => row.enumlabel)).toEqual([
        "CANCELADA",
        "EMITIDA"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'supply_order_cancellation_authorized_after_prepared',
            'supply_order_cancellation_authorized_at_by_status',
            'supply_order_cancellation_effective_after_authorized',
            'supply_order_cancellation_effective_at_by_status',
            'supply_order_cancellation_reason_not_blank',
            'supply_order_cancellation_rejected_after_prepared',
            'supply_order_cancellation_rejected_at_by_status',
            'supply_order_cancellation_supply_order_id_fkey'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "supply_order_cancellation_authorized_after_prepared",
        "supply_order_cancellation_authorized_at_by_status",
        "supply_order_cancellation_effective_after_authorized",
        "supply_order_cancellation_effective_at_by_status",
        "supply_order_cancellation_reason_not_blank",
        "supply_order_cancellation_rejected_after_prepared",
        "supply_order_cancellation_rejected_at_by_status",
        "supply_order_cancellation_supply_order_id_fkey"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and tablename = 'supply_order_cancellation'
            and indexname in (
              'supply_order_cancellation_status_idx',
              'supply_order_cancellation_supply_order_id_key'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "supply_order_cancellation_status_idx",
        "supply_order_cancellation_supply_order_id_key"
      ]);

      const supplierId = randomUUID();
      const contractId = randomUUID();
      const supplyOrderId = randomUUID();

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
        `insert into "supply_order" (
          "id", "code", "contract_id", "issued_at", "updated_at"
        ) values ($1, $2, $3, $4, current_timestamp)`,
        [supplyOrderId, "OF-2026-0001", contractId, "2026-09-22T10:00:00.000Z"]
      );
      await client.query(
        `insert into "supply_order_cancellation" (
          "id", "supply_order_id", "reason", "prepared_at", "updated_at"
        ) values ($1, $2, $3, $4, current_timestamp)`,
        [
          randomUUID(),
          supplyOrderId,
          "Material nao sera mais fornecido",
          "2026-09-22T11:00:00.000Z"
        ]
      );

      await expect(
        client.query(
          `insert into "supply_order_cancellation" (
            "id", "supply_order_id", "reason", "prepared_at", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), supplyOrderId, "Duplicado", "2026-09-22T11:00:00.000Z"]
        )
      ).rejects.toThrow(/supply_order_cancellation_supply_order_id_key/);

      await expect(
        client.query(
          `insert into "supply_order_cancellation" (
            "id", "supply_order_id", "reason", "prepared_at", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), randomUUID(), "OF inexistente", "2026-09-22T11:00:00.000Z"]
        )
      ).rejects.toThrow(/supply_order_cancellation_supply_order_id_fkey/);

      await expect(
        client.query(
          `insert into "supply_order_cancellation" (
            "id", "supply_order_id", "reason", "prepared_at", "updated_at"
          ) values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), randomUUID(), "  ", "2026-09-22T11:00:00.000Z"]
        )
      ).rejects.toThrow(/supply_order_cancellation_reason_not_blank/);

      await expect(
        client.query(
          `insert into "supply_order_cancellation" (
            "id", "supply_order_id", "status", "reason", "prepared_at", "updated_at"
          ) values ($1, $2, 'AUTORIZADA', $3, $4, current_timestamp)`,
          [randomUUID(), randomUUID(), "Autorizacao sem data", "2026-09-22T11:00:00.000Z"]
        )
      ).rejects.toThrow(/supply_order_cancellation_authorized_at_by_status/);

      await expect(
        client.query(
          `insert into "supply_order_cancellation" (
            "id", "supply_order_id", "status", "reason", "prepared_at", "authorized_at", "effective_at", "updated_at"
          ) values ($1, $2, 'EFETIVADA', $3, $4, $5, $6, current_timestamp)`,
          [
            randomUUID(),
            randomUUID(),
            "Efetivacao fora de ordem",
            "2026-09-22T11:00:00.000Z",
            "2026-09-22T12:00:00.000Z",
            "2026-09-22T11:30:00.000Z"
          ]
        )
      ).rejects.toThrow(/supply_order_cancellation_effective_after_authorized/);

      await expect(
        client.query(
          `insert into "supply_order_cancellation" (
            "id", "supply_order_id", "status", "reason", "prepared_at", "rejected_at", "updated_at"
          ) values ($1, $2, 'REJEITADA', $3, $4, $5, current_timestamp)`,
          [
            randomUUID(),
            randomUUID(),
            "Rejeicao fora de ordem",
            "2026-09-22T11:00:00.000Z",
            "2026-09-22T10:59:59.000Z"
          ]
        )
      ).rejects.toThrow(/supply_order_cancellation_rejected_after_prepared/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
