import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

import { AllocateTomboSequence } from "../../src/modules/patrimony/application/allocate-tombo-sequence";
import { PostgresTomboSequenceAllocator } from "../../src/modules/patrimony/infrastructure/postgres-tombo-sequence-allocator";

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

describe("allocate tombo sequence", () => {
  it("serializes concurrent allocations by patrimonial group", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 8 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const useCase = new AllocateTomboSequence(new PostgresTomboSequenceAllocator(pool));
      const results = await Promise.all(
        Array.from({ length: 10 }, () => useCase.execute({ patrimonialGroupCode: "01" }))
      );

      expect(new Set(results.map((result) => result.tombo)).size).toBe(10);
      expect(
        results.map((result) => result.sequenceNumber).sort((left, right) => left - right)
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(results.map((result) => result.tombo).sort()).toEqual([
        "011-01-000001",
        "011-01-000002",
        "011-01-000003",
        "011-01-000004",
        "011-01-000005",
        "011-01-000006",
        "011-01-000007",
        "011-01-000008",
        "011-01-000009",
        "011-01-000010"
      ]);

      await expectSequenceRow(client, {
        patrimonialGroupCode: "01",
        currentValue: 10
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });

  it("keeps independent counters per patrimonial group", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    const pool = new Pool({ connectionString: postgres.getConnectionUri(), max: 4 });

    try {
      await runPrismaMigrateDeploy(postgres.getConnectionUri());
      await client.connect();

      const useCase = new AllocateTomboSequence(new PostgresTomboSequenceAllocator(pool));

      await expect(useCase.execute({ patrimonialGroupCode: "01" })).resolves.toMatchObject({
        sequenceNumber: 1,
        tombo: "011-01-000001"
      });
      await expect(useCase.execute({ patrimonialGroupCode: "02" })).resolves.toMatchObject({
        sequenceNumber: 1,
        tombo: "011-02-000001"
      });
      await expect(useCase.execute({ patrimonialGroupCode: "01" })).resolves.toMatchObject({
        sequenceNumber: 2,
        tombo: "011-01-000002"
      });
    } finally {
      await pool.end().catch(() => undefined);
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});

async function expectSequenceRow(
  client: Client,
  expected: { patrimonialGroupCode: string; currentValue: number }
): Promise<void> {
  const sequence = await client.query<{
    patrimonial_group_code: string;
    current_value: number;
  }>(
    `select "patrimonial_group_code", "current_value"
       from "patrimony_tombo_sequence"
      where "patrimonial_group_code" = $1`,
    [expected.patrimonialGroupCode]
  );

  expect(sequence.rows).toEqual([
    {
      patrimonial_group_code: expected.patrimonialGroupCode,
      current_value: expected.currentValue
    }
  ]);
}
