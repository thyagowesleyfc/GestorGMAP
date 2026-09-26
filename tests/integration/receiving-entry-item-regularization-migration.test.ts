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

describe("receiving entry item regularization migration", () => {
  it("creates per-item regularizations without stock position side effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in (
              'receiving_entry_item_regularization',
              'stock_position'
            )
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "receiving_entry_item_regularization"
      ]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'receiving_entry_item_regularization_contract_id_fkey',
            'receiving_entry_item_regularization_contract_item_contract_fkey',
            'receiving_entry_item_regularization_item_id_fkey',
            'receiving_entry_item_regularization_notes_not_blank',
            'receiving_entry_item_regularization_origin_refs',
            'receiving_entry_item_regularization_supply_order_contract_fkey',
            'receiving_entry_item_regularization_so_item_identity_fkey',
            'receiving_entry_item_regularization_supply_order_pair',
            'receiving_entry_item_regularization_user_id_fkey',
            'receiving_entry_item_regularization_version_positive'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "receiving_entry_item_regularization_contract_id_fkey",
        "receiving_entry_item_regularization_contract_item_contract_fkey",
        "receiving_entry_item_regularization_item_id_fkey",
        "receiving_entry_item_regularization_notes_not_blank",
        "receiving_entry_item_regularization_origin_refs",
        "receiving_entry_item_regularization_so_item_identity_fkey",
        "receiving_entry_item_regularization_supply_order_contract_fkey",
        "receiving_entry_item_regularization_supply_order_pair",
        "receiving_entry_item_regularization_user_id_fkey",
        "receiving_entry_item_regularization_version_positive"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'receiving_entry_item_regularization_contract_id_idx',
              'receiving_entry_item_regularization_contract_item_id_idx',
              'receiving_entry_item_regularization_item_id_idx',
              'receiving_entry_item_regularization_item_key',
              'receiving_entry_item_regularization_origin_type_idx',
              'receiving_entry_item_regularization_regularized_at_idx',
              'receiving_entry_item_regularization_supply_order_id_idx',
              'receiving_entry_item_regularization_supply_order_item_id_idx',
              'receiving_entry_item_regularization_user_id_idx',
              'supply_order_item_identity_key'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "receiving_entry_item_regularization_contract_id_idx",
        "receiving_entry_item_regularization_contract_item_id_idx",
        "receiving_entry_item_regularization_item_id_idx",
        "receiving_entry_item_regularization_item_key",
        "receiving_entry_item_regularization_origin_type_idx",
        "receiving_entry_item_regularization_regularized_at_idx",
        "receiving_entry_item_regularization_supply_order_id_idx",
        "receiving_entry_item_regularization_supply_order_item_id_idx",
        "receiving_entry_item_regularization_user_id_idx",
        "supply_order_item_identity_key"
      ]);

      const seed = await seedRegularizationDependencies(client);

      await insertRegularization(client, {
        receivingEntryItemId: seed.pendingReceivingItemId,
        originType: "PENDENTE",
        regularizedByUserId: seed.userId
      });

      await insertRegularization(client, {
        receivingEntryItemId: seed.indemnityReceivingItemId,
        originType: "INDENIZATORIO",
        regularizedByUserId: seed.userId
      });

      await insertRegularization(client, {
        receivingEntryItemId: seed.contractualReceivingItemId,
        originType: "CONTRATUAL",
        contractId: seed.contractId,
        contractItemId: seed.contractItemId,
        supplyOrderId: seed.supplyOrderId,
        supplyOrderItemId: seed.supplyOrderItemId,
        regularizedByUserId: seed.userId
      });

      await expect(
        insertRegularization(client, {
          receivingEntryItemId: seed.pendingReceivingItemId,
          originType: "PENDENTE"
        })
      ).rejects.toThrow(/receiving_entry_item_regularization_item_key/);

      await expect(
        insertRegularization(client, {
          receivingEntryItemId: seed.incompleteContractualReceivingItemId,
          originType: "CONTRATUAL",
          contractId: seed.contractId,
          contractItemId: seed.contractItemId
        })
      ).rejects.toThrow(/receiving_entry_item_regularization_origin_refs/);

      await expect(
        insertRegularization(client, {
          receivingEntryItemId: seed.indemnityWithRefsReceivingItemId,
          originType: "INDENIZATORIO",
          contractId: seed.contractId,
          contractItemId: seed.contractItemId,
          supplyOrderId: seed.supplyOrderId,
          supplyOrderItemId: seed.supplyOrderItemId
        })
      ).rejects.toThrow(/receiving_entry_item_regularization_origin_refs/);

      await expect(
        insertRegularization(client, {
          receivingEntryItemId: seed.mismatchedContractualReceivingItemId,
          originType: "CONTRATUAL",
          contractId: seed.otherContractId,
          contractItemId: seed.contractItemId,
          supplyOrderId: seed.supplyOrderId,
          supplyOrderItemId: seed.supplyOrderItemId
        })
      ).rejects.toThrow(/receiving_entry_item_regularization_contract_item_contract_fkey/);

      await expect(
        insertRegularization(client, {
          receivingEntryItemId: seed.invalidVersionReceivingItemId,
          originType: "PENDENTE",
          version: 0
        })
      ).rejects.toThrow(/receiving_entry_item_regularization_version_positive/);

      await expect(
        insertRegularization(client, {
          receivingEntryItemId: seed.blankNotesReceivingItemId,
          originType: "PENDENTE",
          notes: " "
        })
      ).rejects.toThrow(/receiving_entry_item_regularization_notes_not_blank/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type RegularizationSeed = {
  userId: string;
  contractId: string;
  otherContractId: string;
  contractItemId: string;
  supplyOrderId: string;
  supplyOrderItemId: string;
  pendingReceivingItemId: string;
  indemnityReceivingItemId: string;
  contractualReceivingItemId: string;
  incompleteContractualReceivingItemId: string;
  indemnityWithRefsReceivingItemId: string;
  mismatchedContractualReceivingItemId: string;
  invalidVersionReceivingItemId: string;
  blankNotesReceivingItemId: string;
};

async function seedRegularizationDependencies(client: Client): Promise<RegularizationSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const supplierId = randomUUID();
  const contractId = randomUUID();
  const otherContractId = randomUUID();
  const contractItemId = randomUUID();
  const otherContractItemId = randomUUID();
  const supplyOrderId = randomUUID();
  const supplyOrderItemId = randomUUID();
  const receivingEntryId = randomUUID();
  const personId = randomUUID();
  const userId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-REG", "GRE Regularizacao"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [entityId, "ENT-REG", "Almoxarifado Regularizacao", greId]
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
    [materialSingularId, "MAT-REG-MONITOR", "Monitor", materialClassId, "EQUIPAMENTO"]
  );
  await client.query(
    `insert into "supplier" ("id", "code", "name", "tax_id", "updated_at")
     values ($1, $2, $3, $4, current_timestamp)`,
    [supplierId, "FORN-REG", "Fornecedor Regularizacao", "12345678000199"]
  );
  await client.query(
    `insert into "contract" (
      "id", "code", "supplier_id", "object", "validity_start", "validity_end", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [contractId, "CTR-REG-001", supplierId, "Aquisicao regularizada", "2026-01-01", "2026-12-31"]
  );
  await client.query(
    `insert into "contract" (
      "id", "code", "supplier_id", "object", "validity_start", "validity_end", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
    [otherContractId, "CTR-REG-002", supplierId, "Outro contrato", "2026-01-01", "2026-12-31"]
  );
  await client.query(
    `insert into "contract_item" (
      "id", "code", "contract_id", "line_number", "material_singular_id", "contracted_quantity", "unit_price", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
    [contractItemId, "CTR-REG-001-ITEM-001", contractId, 1, materialSingularId, 10, "100.00"]
  );
  await client.query(
    `insert into "contract_item" (
      "id", "code", "contract_id", "line_number", "material_singular_id", "contracted_quantity", "unit_price", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
    [
      otherContractItemId,
      "CTR-REG-002-ITEM-001",
      otherContractId,
      1,
      materialSingularId,
      10,
      "100.00"
    ]
  );
  await client.query(
    `insert into "supply_order" (
      "id", "code", "contract_id", "issued_at", "updated_at"
    ) values ($1, $2, $3, $4, current_timestamp)`,
    [supplyOrderId, "OF-REG-001", contractId, "2026-09-23T10:00:00.000Z"]
  );
  await client.query(
    `insert into "supply_order_item" (
      "id", "supply_order_id", "contract_id", "contract_item_id", "line_number", "quantity", "unit_price", "total_amount", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)`,
    [supplyOrderItemId, supplyOrderId, contractId, contractItemId, 1, 2, "100.00", "200.00"]
  );
  await client.query(
    `insert into "receiving_entry" (
      "id", "code", "receiving_entity_id", "received_at", "updated_at"
    ) values ($1, $2, $3, $4, current_timestamp)`,
    [receivingEntryId, "ENT-REG-001", entityId, "2026-09-23T11:00:00.000Z"]
  );
  await client.query(
    `insert into "person" ("id", "display_name", "updated_at")
     values ($1, $2, current_timestamp)`,
    [personId, "Usuario Regularizador"]
  );
  await client.query(
    `insert into "user_account" (
      "id", "person_id", "login_identifier", "updated_at"
    ) values ($1, $2, $3, current_timestamp)`,
    [userId, personId, "regularizador@gmap.local"]
  );

  const itemIds = {
    pendingReceivingItemId: randomUUID(),
    indemnityReceivingItemId: randomUUID(),
    contractualReceivingItemId: randomUUID(),
    incompleteContractualReceivingItemId: randomUUID(),
    indemnityWithRefsReceivingItemId: randomUUID(),
    mismatchedContractualReceivingItemId: randomUUID(),
    invalidVersionReceivingItemId: randomUUID(),
    blankNotesReceivingItemId: randomUUID()
  };

  let lineNumber = 1;
  for (const receivingItemId of Object.values(itemIds)) {
    await client.query(
      `insert into "receiving_entry_item" (
        "id", "receiving_entry_id", "line_number", "material_singular_id", "origin_type", "quantity", "updated_at"
      ) values ($1, $2, $3, $4, 'PENDENTE', $5, current_timestamp)`,
      [receivingItemId, receivingEntryId, lineNumber, materialSingularId, 1]
    );
    lineNumber += 1;
  }

  return {
    userId,
    contractId,
    otherContractId,
    contractItemId,
    supplyOrderId,
    supplyOrderItemId,
    ...itemIds
  };
}

async function insertRegularization(
  client: Client,
  input: {
    receivingEntryItemId: string;
    originType: "CONTRATUAL" | "INDENIZATORIO" | "PENDENTE";
    contractId?: string;
    contractItemId?: string;
    supplyOrderId?: string;
    supplyOrderItemId?: string;
    regularizedByUserId?: string;
    notes?: string;
    version?: number;
  }
): Promise<void> {
  await client.query(
    `insert into "receiving_entry_item_regularization" (
      "id", "receiving_entry_item_id", "origin_type", "regularized_at", "contract_id",
      "contract_item_id", "supply_order_id", "supply_order_item_id", "regularized_by_user_id", "notes", "version", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, current_timestamp)`,
    [
      randomUUID(),
      input.receivingEntryItemId,
      input.originType,
      "2026-09-23T12:00:00.000Z",
      input.contractId ?? null,
      input.contractItemId ?? null,
      input.supplyOrderId ?? null,
      input.supplyOrderItemId ?? null,
      input.regularizedByUserId ?? null,
      input.notes ?? null,
      input.version ?? 1
    ]
  );
}
