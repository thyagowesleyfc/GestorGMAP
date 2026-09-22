import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { EmitSupplyOrder } from "../../src/modules/contracts/application/emit-supply-order";
import { PostgresSupplyOrderEmitter } from "../../src/modules/contracts/infrastructure/postgres-supply-order-emitter";

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

describe("emit supply order", () => {
  it("uses a pessimistic lock so concurrent emissions cannot overcommit contract balance", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const { contractId, contractItemId } = await seedContractItemWithBalance(client);
      const useCase = new EmitSupplyOrder(new PostgresSupplyOrderEmitter(pool));
      const issuedAt = new Date("2026-09-22T10:00:00.000Z");

      const results = await Promise.all([
        useCase.execute({
          code: "OF-2026-0001",
          contractId,
          issuedAt,
          items: [{ contractItemId, quantity: 10 }]
        }),
        useCase.execute({
          code: "OF-2026-0002",
          contractId,
          issuedAt,
          items: [{ contractItemId, quantity: 10 }]
        })
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: "INSUFFICIENT_CONTRACT_BALANCE",
          contractItemId
        }
      ]);

      const supplyOrders = await client.query<{ count: number }>(
        `select count(*)::int as count from "supply_order"`
      );
      const supplyOrderItems = await client.query<{ count: number }>(
        `select count(*)::int as count from "supply_order_item"`
      );
      const movements = await client.query<{ count: number }>(
        `select count(*)::int as count
           from "contract_balance_movement"
          where "type" = 'COMPROMETIMENTO_OF'`
      );
      const position = await client.query<{
        committed_quantity: number;
        available_quantity: number;
        committed_amount: string;
        available_amount: string;
        version: number;
      }>(
        `select "committed_quantity",
                "available_quantity",
                "committed_amount"::text,
                "available_amount"::text,
                "version"
           from "contract_balance_position"
          where "contract_item_id" = $1`,
        [contractItemId]
      );

      expect(supplyOrders.rows).toEqual([{ count: 1 }]);
      expect(supplyOrderItems.rows).toEqual([{ count: 1 }]);
      expect(movements.rows).toEqual([{ count: 1 }]);
      expect(position.rows).toEqual([
        {
          committed_quantity: 10,
          available_quantity: 0,
          committed_amount: "12505.00",
          available_amount: "0.00",
          version: 2
        }
      ]);
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function seedContractItemWithBalance(client: Client): Promise<{
  contractId: string;
  contractItemId: string;
}> {
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
    [randomUUID(), contractItemId, 10, 0, 10, "12505.00", "0.00", "12505.00"]
  );

  return { contractId, contractItemId };
}
