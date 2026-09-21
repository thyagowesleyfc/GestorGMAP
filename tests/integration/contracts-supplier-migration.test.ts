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

describe("contracts supplier migration", () => {
  it("creates suppliers with stable public codes and optional tax documents", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'supplier'`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["supplier"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'supplier_code_public_format',
            'supplier_name_not_blank',
            'supplier_tax_id_format'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "supplier_code_public_format",
        "supplier_name_not_blank",
        "supplier_tax_id_format"
      ]);

      await client.query(
        `insert into "supplier" ("id", "code", "name", "tax_id", "updated_at")
         values ($1, $2, $3, $4, current_timestamp)`,
        [randomUUID(), "FORN-TECNOLOGIA", "Fornecedor de Tecnologia Ltda", "12345678000199"]
      );

      await client.query(
        `insert into "supplier" ("id", "code", "name", "updated_at")
         values ($1, $2, $3, current_timestamp)`,
        [randomUUID(), "FORN-SEM-DOCUMENTO", "Fornecedor sem documento informado"]
      );

      await expect(
        client.query(
          `insert into "supplier" ("id", "code", "name", "updated_at")
           values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), "FORN-TECNOLOGIA", "Fornecedor duplicado"]
        )
      ).rejects.toThrow(/supplier_code_key/);

      await expect(
        client.query(
          `insert into "supplier" ("id", "code", "name", "updated_at")
           values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), "forn-minusculo", "Codigo minusculo"]
        )
      ).rejects.toThrow(/supplier_code_public_format/);

      await expect(
        client.query(
          `insert into "supplier" ("id", "code", "name", "updated_at")
           values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), "FORN-SEM-NOME", "  "]
        )
      ).rejects.toThrow(/supplier_name_not_blank/);

      await expect(
        client.query(
          `insert into "supplier" ("id", "code", "name", "tax_id", "updated_at")
           values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), "FORN-DOC-INVALIDO", "Documento invalido", "ABC123"]
        )
      ).rejects.toThrow(/supplier_tax_id_format/);

      await expect(
        client.query(
          `insert into "supplier" ("id", "code", "name", "tax_id", "updated_at")
           values ($1, $2, $3, $4, current_timestamp)`,
          [randomUUID(), "FORN-DOC-DUPLICADO", "Documento duplicado", "12345678000199"]
        )
      ).rejects.toThrow(/supplier_tax_id_key/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
