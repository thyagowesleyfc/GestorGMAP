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

describe("receiving stock movement migration", () => {
  it("creates append-only stock movements without stock position side effects", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name in ('stock_movement', 'stock_position')
          order by table_name`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["stock_movement"]);

      const movementTypes = await client.query<{ enumlabel: string }>(
        `select enumlabel
           from pg_enum
          where enumtypid = '"StockMovementType"'::regtype
          order by enumlabel`
      );

      expect(movementTypes.rows.map((row) => row.enumlabel)).toEqual(["ENTRADA_RECEBIMENTO"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'stock_movement_code_public_format',
            'stock_movement_quantity_delta_non_zero',
            'stock_movement_receipt_entry_positive',
            'stock_movement_receiving_entry_item_id_fkey',
            'stock_movement_regularization_identity_fkey',
            'stock_movement_summary_not_blank'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "stock_movement_code_public_format",
        "stock_movement_quantity_delta_non_zero",
        "stock_movement_receipt_entry_positive",
        "stock_movement_receiving_entry_item_id_fkey",
        "stock_movement_regularization_identity_fkey",
        "stock_movement_summary_not_blank"
      ]);

      const indexes = await client.query<{ indexname: string }>(
        `select indexname
           from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'receiving_entry_item_regularization_identity_key',
              'stock_movement_code_key',
              'stock_movement_movement_type_idx',
              'stock_movement_occurred_at_idx',
              'stock_movement_origin_type_idx',
              'stock_movement_receiving_entry_item_id_idx',
              'stock_movement_receiving_regularization_type_key',
              'stock_movement_regularization_id_idx'
            )
          order by indexname`
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "receiving_entry_item_regularization_identity_key",
        "stock_movement_code_key",
        "stock_movement_movement_type_idx",
        "stock_movement_occurred_at_idx",
        "stock_movement_origin_type_idx",
        "stock_movement_receiving_entry_item_id_idx",
        "stock_movement_receiving_regularization_type_key",
        "stock_movement_regularization_id_idx"
      ]);

      const seed = await seedStockMovementDependencies(client);

      await insertStockMovement(client, {
        code: "EST-2026-0001",
        receivingEntryItemRegularizationId: seed.singularRegularizationId,
        receivingEntryItemId: seed.singularReceivingItemId,
        originType: "PENDENTE",
        quantityDelta: 5,
        summary: "Entrada regularizada de monitores"
      });

      await insertStockMovement(client, {
        code: "EST-2026-0002",
        receivingEntryItemRegularizationId: seed.configurationRegularizationId,
        receivingEntryItemId: seed.configurationReceivingItemId,
        originType: "INDENIZATORIO",
        quantityDelta: 2,
        summary: "Entrada regularizada de kits"
      });

      await expect(
        insertStockMovement(client, {
          code: "est-2026-0003",
          receivingEntryItemRegularizationId: seed.invalidCodeRegularizationId,
          receivingEntryItemId: seed.invalidCodeReceivingItemId,
          originType: "PENDENTE",
          quantityDelta: 1,
          summary: "Codigo invalido"
        })
      ).rejects.toThrow(/stock_movement_code_public_format/);

      await expect(
        insertStockMovement(client, {
          code: "EST-2026-0003",
          receivingEntryItemRegularizationId: seed.zeroQuantityRegularizationId,
          receivingEntryItemId: seed.zeroQuantityReceivingItemId,
          originType: "PENDENTE",
          quantityDelta: 0,
          summary: "Quantidade zero"
        })
      ).rejects.toThrow(/stock_movement_quantity_delta_non_zero/);

      await expect(
        insertStockMovement(client, {
          code: "EST-2026-0004",
          receivingEntryItemRegularizationId: seed.negativeQuantityRegularizationId,
          receivingEntryItemId: seed.negativeQuantityReceivingItemId,
          originType: "PENDENTE",
          quantityDelta: -1,
          summary: "Quantidade negativa"
        })
      ).rejects.toThrow(/stock_movement_receipt_entry_positive/);

      await expect(
        insertStockMovement(client, {
          code: "EST-2026-0005",
          receivingEntryItemRegularizationId: seed.blankSummaryRegularizationId,
          receivingEntryItemId: seed.blankSummaryReceivingItemId,
          originType: "PENDENTE",
          quantityDelta: 1,
          summary: " "
        })
      ).rejects.toThrow(/stock_movement_summary_not_blank/);

      await expect(
        insertStockMovement(client, {
          code: "EST-2026-0006",
          receivingEntryItemRegularizationId: seed.singularRegularizationId,
          receivingEntryItemId: seed.singularReceivingItemId,
          originType: "PENDENTE",
          quantityDelta: 1,
          summary: "Duplicidade de regularizacao"
        })
      ).rejects.toThrow(/stock_movement_receiving_regularization_type_key/);

      await expect(
        insertStockMovement(client, {
          code: "EST-2026-0007",
          receivingEntryItemRegularizationId: seed.mismatchedRegularizationId,
          receivingEntryItemId: seed.singularReceivingItemId,
          originType: "PENDENTE",
          quantityDelta: 1,
          summary: "Item incoerente com regularizacao"
        })
      ).rejects.toThrow(/stock_movement_regularization_identity_fkey/);

      await expect(
        insertStockMovement(client, {
          code: "EST-2026-0008",
          receivingEntryItemRegularizationId: seed.originMismatchRegularizationId,
          receivingEntryItemId: seed.originMismatchReceivingItemId,
          originType: "PENDENTE",
          quantityDelta: 1,
          summary: "Origem incoerente com regularizacao"
        })
      ).rejects.toThrow(/stock_movement_regularization_identity_fkey/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

type StockMovementSeed = {
  singularReceivingItemId: string;
  singularRegularizationId: string;
  configurationReceivingItemId: string;
  configurationRegularizationId: string;
  invalidCodeReceivingItemId: string;
  invalidCodeRegularizationId: string;
  zeroQuantityReceivingItemId: string;
  zeroQuantityRegularizationId: string;
  negativeQuantityReceivingItemId: string;
  negativeQuantityRegularizationId: string;
  blankSummaryReceivingItemId: string;
  blankSummaryRegularizationId: string;
  mismatchedRegularizationId: string;
  originMismatchReceivingItemId: string;
  originMismatchRegularizationId: string;
};

async function seedStockMovementDependencies(client: Client): Promise<StockMovementSeed> {
  const greId = randomUUID();
  const entityId = randomUUID();
  const materialClassId = randomUUID();
  const materialSingularId = randomUUID();
  const configurationId = randomUUID();
  const receivingEntryId = randomUUID();

  await client.query(
    `insert into "gre" ("id", "code", "name", "updated_at")
     values ($1, $2, $3, current_timestamp)`,
    [greId, "GRE-STK", "GRE Estoque"]
  );
  await client.query(
    `insert into "entity" (
      "id", "code", "name", "entity_type", "gre_id", "updated_at"
    ) values ($1, $2, $3, 'GERENCIA', $4, current_timestamp)`,
    [entityId, "ENT-STK", "Almoxarifado Estoque", greId]
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
    [materialSingularId, "MAT-STK-MONITOR", "Monitor", materialClassId, "EQUIPAMENTO"]
  );
  await client.query(
    `insert into "material_configuration" ("id", "code", "name", "configuration_type", "updated_at")
     values ($1, $2, $3, 'KIT', current_timestamp)`,
    [configurationId, "KIT-STK", "Kit Estoque"]
  );
  await client.query(
    `insert into "material_configuration_component" (
      "id", "configuration_id", "material_singular_id", "quantity", "updated_at"
    ) values ($1, $2, $3, 1, current_timestamp)`,
    [randomUUID(), configurationId, materialSingularId]
  );
  await client.query(
    `insert into "receiving_entry" (
      "id", "code", "receiving_entity_id", "received_at", "updated_at"
    ) values ($1, $2, $3, $4, current_timestamp)`,
    [receivingEntryId, "ENT-STK-001", entityId, "2026-09-23T10:00:00.000Z"]
  );

  const singularReceivingItemId = await insertReceivingItem(client, {
    receivingEntryId,
    lineNumber: 1,
    materialSingularId,
    originType: "PENDENTE"
  });
  const singularRegularizationId = await insertRegularization(client, {
    receivingEntryItemId: singularReceivingItemId,
    originType: "PENDENTE"
  });

  const configurationReceivingItemId = await insertReceivingItem(client, {
    receivingEntryId,
    lineNumber: 2,
    materialConfigurationId: configurationId,
    originType: "INDENIZATORIO"
  });
  const configurationRegularizationId = await insertRegularization(client, {
    receivingEntryItemId: configurationReceivingItemId,
    originType: "INDENIZATORIO"
  });

  const invalidCodeReceivingItemId = await insertReceivingItem(client, {
    receivingEntryId,
    lineNumber: 3,
    materialSingularId,
    originType: "PENDENTE"
  });
  const invalidCodeRegularizationId = await insertRegularization(client, {
    receivingEntryItemId: invalidCodeReceivingItemId,
    originType: "PENDENTE"
  });

  const zeroQuantityReceivingItemId = await insertReceivingItem(client, {
    receivingEntryId,
    lineNumber: 4,
    materialSingularId,
    originType: "PENDENTE"
  });
  const zeroQuantityRegularizationId = await insertRegularization(client, {
    receivingEntryItemId: zeroQuantityReceivingItemId,
    originType: "PENDENTE"
  });

  const negativeQuantityReceivingItemId = await insertReceivingItem(client, {
    receivingEntryId,
    lineNumber: 5,
    materialSingularId,
    originType: "PENDENTE"
  });
  const negativeQuantityRegularizationId = await insertRegularization(client, {
    receivingEntryItemId: negativeQuantityReceivingItemId,
    originType: "PENDENTE"
  });

  const blankSummaryReceivingItemId = await insertReceivingItem(client, {
    receivingEntryId,
    lineNumber: 6,
    materialSingularId,
    originType: "PENDENTE"
  });
  const blankSummaryRegularizationId = await insertRegularization(client, {
    receivingEntryItemId: blankSummaryReceivingItemId,
    originType: "PENDENTE"
  });

  const mismatchedReceivingItemId = await insertReceivingItem(client, {
    receivingEntryId,
    lineNumber: 7,
    materialSingularId,
    originType: "PENDENTE"
  });
  const mismatchedRegularizationId = await insertRegularization(client, {
    receivingEntryItemId: mismatchedReceivingItemId,
    originType: "PENDENTE"
  });

  const originMismatchReceivingItemId = await insertReceivingItem(client, {
    receivingEntryId,
    lineNumber: 8,
    materialConfigurationId: configurationId,
    originType: "INDENIZATORIO"
  });
  const originMismatchRegularizationId = await insertRegularization(client, {
    receivingEntryItemId: originMismatchReceivingItemId,
    originType: "INDENIZATORIO"
  });

  return {
    singularReceivingItemId,
    singularRegularizationId,
    configurationReceivingItemId,
    configurationRegularizationId,
    invalidCodeReceivingItemId,
    invalidCodeRegularizationId,
    zeroQuantityReceivingItemId,
    zeroQuantityRegularizationId,
    negativeQuantityReceivingItemId,
    negativeQuantityRegularizationId,
    blankSummaryReceivingItemId,
    blankSummaryRegularizationId,
    mismatchedRegularizationId,
    originMismatchReceivingItemId,
    originMismatchRegularizationId
  };
}

async function insertReceivingItem(
  client: Client,
  input: {
    receivingEntryId: string;
    lineNumber: number;
    materialSingularId?: string;
    materialConfigurationId?: string;
    originType: "CONTRATUAL" | "INDENIZATORIO" | "PENDENTE";
  }
): Promise<string> {
  const receivingEntryItemId = randomUUID();

  await client.query(
    `insert into "receiving_entry_item" (
      "id", "receiving_entry_id", "line_number", "material_singular_id", "material_configuration_id", "origin_type", "quantity", "updated_at"
    ) values ($1, $2, $3, $4, $5, $6, 1, current_timestamp)`,
    [
      receivingEntryItemId,
      input.receivingEntryId,
      input.lineNumber,
      input.materialSingularId ?? null,
      input.materialConfigurationId ?? null,
      input.originType
    ]
  );

  return receivingEntryItemId;
}

async function insertRegularization(
  client: Client,
  input: {
    receivingEntryItemId: string;
    originType: "CONTRATUAL" | "INDENIZATORIO" | "PENDENTE";
  }
): Promise<string> {
  const regularizationId = randomUUID();

  await client.query(
    `insert into "receiving_entry_item_regularization" (
      "id", "receiving_entry_item_id", "origin_type", "regularized_at", "updated_at"
    ) values ($1, $2, $3, $4, current_timestamp)`,
    [regularizationId, input.receivingEntryItemId, input.originType, "2026-09-23T11:00:00.000Z"]
  );

  return regularizationId;
}

async function insertStockMovement(
  client: Client,
  input: {
    code: string;
    receivingEntryItemRegularizationId: string;
    receivingEntryItemId: string;
    originType: "CONTRATUAL" | "INDENIZATORIO" | "PENDENTE";
    quantityDelta: number;
    summary: string;
  }
): Promise<void> {
  await client.query(
    `insert into "stock_movement" (
      "id", "code", "movement_type", "receiving_entry_item_regularization_id", "receiving_entry_item_id",
      "origin_type", "quantity_delta", "occurred_at", "summary"
    ) values ($1, $2, 'ENTRADA_RECEBIMENTO', $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      input.code,
      input.receivingEntryItemRegularizationId,
      input.receivingEntryItemId,
      input.originType,
      input.quantityDelta,
      "2026-09-23T12:00:00.000Z",
      input.summary
    ]
  );
}
