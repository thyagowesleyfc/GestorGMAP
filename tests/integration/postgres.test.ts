import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

describe("postgres integration baseline", () => {
  it("runs a query against PostgreSQL from Testcontainers", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const client = new Client({
      connectionString: postgres.getConnectionUri()
    });

    try {
      await client.connect();

      const result = await client.query<{ value: number }>("select 1::int as value");

      expect(result.rows[0]?.value).toBe(1);
    } finally {
      await client.end().catch(() => undefined);
      await postgres.stop();
    }
  });
});
