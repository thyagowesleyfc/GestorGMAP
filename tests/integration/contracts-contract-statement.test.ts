import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  GetContractStatement,
  type ContractStatementReader
} from "../../src/modules/contracts/application/get-contract-statement";
import { PostgresContractStatementReader } from "../../src/modules/contracts/infrastructure/postgres-contract-statement-reader";

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

describe("contract statement", () => {
  it("rejects invalid pagination before persistence", async () => {
    const reader: ContractStatementReader = {
      get: async () => {
        throw new Error("reader should not be called for invalid pagination");
      }
    };
    const useCase = new GetContractStatement(reader);

    await expect(
      useCase.execute({
        contractId: randomUUID(),
        movementsLimit: 0
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_PAGINATION" });

    await expect(
      useCase.execute({
        contractId: randomUUID(),
        supplyOrdersOffset: -1
      })
    ).resolves.toEqual({ ok: false, reason: "INVALID_PAGINATION" });
  });

  it("returns contract items, totals, supply orders and paginated balance movements", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 2 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const seed = await seedContractStatement(client);
      const useCase = new GetContractStatement(new PostgresContractStatementReader(pool));

      const result = await useCase.execute({
        contractId: seed.contractId,
        movementsLimit: 2,
        movementsOffset: 1,
        supplyOrdersLimit: 1,
        supplyOrdersOffset: 0
      });

      expect(result).toEqual({
        ok: true,
        statement: {
          contract: {
            id: seed.contractId,
            code: "CTR-2026-EXTRATO",
            supplierName: "Fornecedor de Tecnologia Ltda",
            object: "Aquisicao de equipamentos",
            validityStart: "2026-01-01",
            validityEnd: "2026-12-31"
          },
          totals: {
            totalQuantity: 15,
            committedQuantity: 4,
            availableQuantity: 11,
            totalAmount: "15005.00",
            committedAmount: "5002.00",
            availableAmount: "10003.00"
          },
          items: [
            {
              contractItemId: seed.monitorItemId,
              code: "CTR-2026-EXTRATO-ITEM-001",
              lineNumber: 1,
              contractedQuantity: 10,
              unitPrice: "1250.50",
              totalQuantity: 10,
              committedQuantity: 4,
              availableQuantity: 6,
              totalAmount: "12505.00",
              committedAmount: "5002.00",
              availableAmount: "7503.00"
            },
            {
              contractItemId: seed.keyboardItemId,
              code: "CTR-2026-EXTRATO-ITEM-002",
              lineNumber: 2,
              contractedQuantity: 5,
              unitPrice: "500.00",
              totalQuantity: 5,
              committedQuantity: 0,
              availableQuantity: 5,
              totalAmount: "2500.00",
              committedAmount: "0.00",
              availableAmount: "2500.00"
            }
          ],
          movements: [
            {
              id: seed.commitmentMovementId,
              code: "CTR-2026-EXTRATO-MOV-002",
              contractItemId: seed.monitorItemId,
              contractItemCode: "CTR-2026-EXTRATO-ITEM-001",
              type: "COMPROMETIMENTO_OF",
              quantityDelta: -4,
              amountDelta: "-5002.00",
              occurredAt: "2026-01-02 10:00:00",
              summary: "Comprometimento de saldo pela OF OF-2026-EXTRATO"
            },
            {
              id: seed.initialMovementId,
              code: "CTR-2026-EXTRATO-MOV-001",
              contractItemId: seed.monitorItemId,
              contractItemCode: "CTR-2026-EXTRATO-ITEM-001",
              type: "CONTRATACAO",
              quantityDelta: 10,
              amountDelta: "12505.00",
              occurredAt: "2026-01-01 10:00:00",
              summary: "Saldo inicial do item monitor"
            }
          ],
          movementsPage: {
            limit: 2,
            offset: 1,
            returned: 2
          },
          supplyOrders: [
            {
              id: seed.supplyOrderId,
              code: "OF-2026-EXTRATO",
              status: "CANCELADA",
              issuedAt: "2026-01-04 09:00:00",
              itemsCount: 1,
              totalAmount: "5002.00",
              cancellation: {
                id: seed.cancellationId,
                status: "EFETIVADA",
                reason: "Cancelamento administrativo",
                preparedAt: "2026-01-04 10:00:00",
                authorizedAt: "2026-01-04 11:00:00",
                effectiveAt: "2026-01-04 12:00:00",
                rejectedAt: null
              }
            }
          ],
          supplyOrdersPage: {
            limit: 1,
            offset: 0,
            returned: 1
          }
        }
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("returns not found for an unknown contract", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 1 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());

      const useCase = new GetContractStatement(new PostgresContractStatementReader(pool));
      const result = await useCase.execute({ contractId: randomUUID() });

      expect(result).toEqual({ ok: false, reason: "CONTRACT_NOT_FOUND" });
    } finally {
      await pool.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type ContractStatementSeed = {
  contractId: string;
  monitorItemId: string;
  keyboardItemId: string;
  initialMovementId: string;
  commitmentMovementId: string;
  keyboardMovementId: string;
  supplyOrderId: string;
  cancellationId: string;
};

async function seedContractStatement(client: Client): Promise<ContractStatementSeed> {
  const supplierId = randomUUID();
  const materialClassId = randomUUID();
  const monitorId = randomUUID();
  const keyboardId = randomUUID();
  const contractId = randomUUID();
  const monitorItemId = randomUUID();
  const keyboardItemId = randomUUID();
  const initialMovementId = randomUUID();
  const commitmentMovementId = randomUUID();
  const keyboardMovementId = randomUUID();
  const supplyOrderId = randomUUID();
  const cancellationId = randomUUID();

  await client.query(
    `insert into "supplier" ("id", "code", "name", "tax_id", "updated_at")
     values ($1, $2, $3, $4, current_timestamp)`,
    [supplierId, "FORN-EXTRATO", "Fornecedor de Tecnologia Ltda", null]
  );
  await client.query(
    `insert into "material_class" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [materialClassId, "CLASSE-EXTRATO", "Informatica"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [monitorId, "MAT-EXTRATO-MONITOR", "Monitor", materialClassId, "EQUIPAMENTO"]
  );
  await client.query(
    `insert into "material_singular" (
      "id", "code", "name", "class_id", "control_type", "is_tombable", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, $3, $4, 'INDIVIDUAL', true, $5, current_timestamp)`,
    [keyboardId, "MAT-EXTRATO-TECLADO", "Teclado", materialClassId, "EQUIPAMENTO"]
  );
  await client.query(
    `insert into "contract" (
      "id", "code", "supplier_id", "object", "validity_start", "validity_end", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [
      contractId,
      "CTR-2026-EXTRATO",
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
    [monitorItemId, "CTR-2026-EXTRATO-ITEM-001", contractId, 1, monitorId, 10, "1250.50"]
  );
  await client.query(
    `insert into "contract_item" (
      "id", "code", "contract_id", "line_number", "material_singular_id", "contracted_quantity", "unit_price", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
    [keyboardItemId, "CTR-2026-EXTRATO-ITEM-002", contractId, 2, keyboardId, 5, "500.00"]
  );
  await client.query(
    `insert into "contract_balance_position" (
      "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
      "total_amount", "committed_amount", "available_amount", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
    [randomUUID(), monitorItemId, 10, 4, 6, "12505.00", "5002.00", "7503.00"]
  );
  await client.query(
    `insert into "contract_balance_position" (
      "id", "contract_item_id", "total_quantity", "committed_quantity", "available_quantity",
      "total_amount", "committed_amount", "available_amount", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
    [randomUUID(), keyboardItemId, 5, 0, 5, "2500.00", "0.00", "2500.00"]
  );
  await insertMovement(client, {
    id: initialMovementId,
    code: "CTR-2026-EXTRATO-MOV-001",
    contractItemId: monitorItemId,
    type: "CONTRATACAO",
    quantityDelta: 10,
    amountDelta: "12505.00",
    occurredAt: "2026-01-01 10:00:00",
    summary: "Saldo inicial do item monitor"
  });
  await insertMovement(client, {
    id: commitmentMovementId,
    code: "CTR-2026-EXTRATO-MOV-002",
    contractItemId: monitorItemId,
    type: "COMPROMETIMENTO_OF",
    quantityDelta: -4,
    amountDelta: "-5002.00",
    occurredAt: "2026-01-02 10:00:00",
    summary: "Comprometimento de saldo pela OF OF-2026-EXTRATO"
  });
  await insertMovement(client, {
    id: keyboardMovementId,
    code: "CTR-2026-EXTRATO-MOV-003",
    contractItemId: keyboardItemId,
    type: "CONTRATACAO",
    quantityDelta: 5,
    amountDelta: "2500.00",
    occurredAt: "2026-01-03 10:00:00",
    summary: "Saldo inicial do item teclado"
  });
  await client.query(
    `insert into "supply_order" (
      "id", "code", "contract_id", "status", "issued_at", "updated_at"
    ) values ($1, $2, $3, 'CANCELADA', $4, current_timestamp)`,
    [supplyOrderId, "OF-2026-EXTRATO", contractId, "2026-01-04 09:00:00"]
  );
  await client.query(
    `insert into "supply_order_item" (
      "id", "supply_order_id", "contract_id", "contract_item_id", "line_number", "quantity", "unit_price", "total_amount", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
    [randomUUID(), supplyOrderId, contractId, monitorItemId, 1, 4, "1250.50", "5002.00"]
  );
  await client.query(
    `insert into "supply_order_cancellation" (
      "id", "supply_order_id", "status", "reason", "prepared_at", "authorized_at", "effective_at", "updated_at"
    ) values ($1, $2, 'EFETIVADA', $3, $4, $5, $6, current_timestamp)`,
    [
      cancellationId,
      supplyOrderId,
      "Cancelamento administrativo",
      "2026-01-04 10:00:00",
      "2026-01-04 11:00:00",
      "2026-01-04 12:00:00"
    ]
  );

  return {
    contractId,
    monitorItemId,
    keyboardItemId,
    initialMovementId,
    commitmentMovementId,
    keyboardMovementId,
    supplyOrderId,
    cancellationId
  };
}

async function insertMovement(
  client: Client,
  input: {
    id: string;
    code: string;
    contractItemId: string;
    type: string;
    quantityDelta: number;
    amountDelta: string;
    occurredAt: string;
    summary: string;
  }
): Promise<void> {
  await client.query(
    `insert into "contract_balance_movement" (
      "id", "code", "contract_item_id", "type", "quantity_delta", "amount_delta", "occurred_at", "summary"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.code,
      input.contractItemId,
      input.type,
      input.quantityDelta,
      input.amountDelta,
      input.occurredAt,
      input.summary
    ]
  );
}
