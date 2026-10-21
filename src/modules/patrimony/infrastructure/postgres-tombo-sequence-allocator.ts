import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import {
  formatTomboSequence,
  type AllocateTomboSequenceCommand,
  type AllocateTomboSequenceResult,
  type TomboSequenceAllocator
} from "../application/allocate-tombo-sequence";

type LockedTomboSequence = {
  id: string;
  current_value: number;
};

export class PostgresTomboSequenceAllocator implements TomboSequenceAllocator {
  constructor(private readonly pool: Pool) {}

  async allocate(input: AllocateTomboSequenceCommand): Promise<AllocateTomboSequenceResult> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");

      const result = await allocateTomboSequenceInTransaction(client, input);

      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function allocateTomboSequenceInTransaction(
  client: PoolClient,
  input: AllocateTomboSequenceCommand
): Promise<AllocateTomboSequenceResult> {
  await client.query(
    `insert into "patrimony_tombo_sequence" (
      "id", "patrimonial_group_code", "updated_at"
    ) values ($1, $2, current_timestamp)
    on conflict ("patrimonial_group_code") do nothing`,
    [randomUUID(), input.patrimonialGroupCode]
  );

  const sequence = await client.query<LockedTomboSequence>(
    `select "id", "current_value"
       from "patrimony_tombo_sequence"
      where "patrimonial_group_code" = $1
      for update`,
    [input.patrimonialGroupCode]
  );
  const row = sequence.rows[0];

  if (row === undefined) {
    throw new Error("Tombo sequence row was not created.");
  }

  const sequenceNumber = row.current_value + 1;

  await client.query(
    `update "patrimony_tombo_sequence"
        set "current_value" = $2,
            "updated_at" = current_timestamp
      where "id" = $1`,
    [row.id, sequenceNumber]
  );

  return {
    organCode: "011",
    patrimonialGroupCode: input.patrimonialGroupCode,
    sequenceNumber,
    tombo: formatTomboSequence({
      patrimonialGroupCode: input.patrimonialGroupCode,
      sequenceNumber
    })
  };
}
