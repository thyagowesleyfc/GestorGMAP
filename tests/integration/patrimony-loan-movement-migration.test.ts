import { execFile } from "node:child_process";
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
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 90000
  });
}

describe("patrimony loan movement migration", () => {
  it("adiciona EMPRESTIMO ao ledger sem remover REMANEJAMENTO", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const enumValues = await client.query<{ enumlabel: string }>(
        `select e.enumlabel
           from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = 'PatrimonyMovementType'
          order by e.enumsortorder`
      );

      expect(enumValues.rows.map((row) => row.enumlabel)).toEqual(["REMANEJAMENTO", "EMPRESTIMO"]);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
