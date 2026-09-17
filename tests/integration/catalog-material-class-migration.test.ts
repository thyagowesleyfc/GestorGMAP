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

describe("catalog material class migration", () => {
  it("creates material classes with stable public codes", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_name = 'material_class'`
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual(["material_class"]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'material_class_code_public_format',
            'material_class_name_not_blank'
          )
          order by conname`
      );

      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "material_class_code_public_format",
        "material_class_name_not_blank"
      ]);

      await client.query(
        `insert into "material_class" ("id", "code", "name", "updated_at")
         values ($1, $2, $3, current_timestamp)`,
        [randomUUID(), "INFORMATICA", "Informatica"]
      );

      await expect(
        client.query(
          `insert into "material_class" ("id", "code", "name", "updated_at")
           values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), "INFORMATICA", "Informatica duplicada"]
        )
      ).rejects.toThrow(/material_class_code_key/);

      await expect(
        client.query(
          `insert into "material_class" ("id", "code", "name", "updated_at")
           values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), "informatica", "Codigo minusculo"]
        )
      ).rejects.toThrow(/material_class_code_public_format/);

      await expect(
        client.query(
          `insert into "material_class" ("id", "code", "name", "updated_at")
           values ($1, $2, $3, current_timestamp)`,
          [randomUUID(), "MOBILIARIO", "  "]
        )
      ).rejects.toThrow(/material_class_name_not_blank/);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
