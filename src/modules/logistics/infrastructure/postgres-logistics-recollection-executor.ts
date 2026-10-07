import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  ExecuteLogisticsRecollectionCommand,
  ExecuteLogisticsRecollectionResult,
  LogisticsRecollectionExecutor
} from "../application/execute-logistics-recollection";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: ExecuteLogisticsRecollectionResult }
  | { kind: "CONFLICT" };

type RecollectionRow = {
  id: string;
  status: "SOLICITADA" | "AUTORIZADA" | "EXECUTADA" | "CANCELADA";
  authorized_at: Date | null;
  executed_at: Date | null;
  version: number;
};

const EXECUTE_LOGISTICS_RECOLLECTION_COMMAND = "logistics.execute_recollection";

export class PostgresLogisticsRecollectionExecutor implements LogisticsRecollectionExecutor {
  constructor(private readonly pool: Pool) {}

  async execute(
    input: ExecuteLogisticsRecollectionCommand
  ): Promise<ExecuteLogisticsRecollectionResult> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");

      const reservation = await this.reserveIdempotency(client, input);
      if (reservation.kind === "REPLAY") {
        await client.query("commit");
        return reservation.result;
      }

      if (reservation.kind === "CONFLICT") {
        await client.query("commit");
        return { ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" };
      }

      const result = await this.executeInTransaction(client, input);
      await this.storeIdempotencyResult(client, reservation.id, result);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: ExecuteLogisticsRecollectionCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashExecuteLogisticsRecollectionCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, EXECUTE_LOGISTICS_RECOLLECTION_COMMAND, input.commandId, requestHash]
    );

    if (inserted.rows.length === 1) {
      return { kind: "NEW", id: inserted.rows[0].id };
    }

    const existing = await client.query<IdempotencyRow>(
      `select "request_hash", "status", "result_json"
         from "command_idempotency"
        where "command_name" = $1
          and "idempotency_key" = $2
        for update`,
      [EXECUTE_LOGISTICS_RECOLLECTION_COMMAND, input.commandId]
    );
    const row = existing.rows[0];

    if (row === undefined || row.request_hash !== requestHash) {
      return { kind: "CONFLICT" };
    }

    if (row.status === "SUCCEEDED" && row.result_json !== null) {
      return { kind: "REPLAY", result: parseStoredResult(row.result_json) };
    }

    return { kind: "CONFLICT" };
  }

  private async storeIdempotencyResult(
    client: PoolClient,
    idempotencyId: string,
    result: ExecuteLogisticsRecollectionResult
  ): Promise<void> {
    await client.query(
      `update "command_idempotency"
          set "status" = 'SUCCEEDED',
              "result_json" = $2::jsonb,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [idempotencyId, JSON.stringify(result)]
    );
  }

  private async executeInTransaction(
    client: PoolClient,
    input: ExecuteLogisticsRecollectionCommand
  ): Promise<ExecuteLogisticsRecollectionResult> {
    const recollection = await client.query<RecollectionRow>(
      `select "id", "status"::text as "status", "authorized_at", "executed_at", "version"
         from "logistics_recollection"
        where "id" = $1
        for update`,
      [input.recollectionId]
    );
    const recollectionRow = recollection.rows[0];

    if (recollectionRow === undefined) {
      return { ok: false, reason: "RECOLLECTION_NOT_FOUND", recollectionId: input.recollectionId };
    }

    if (recollectionRow.status !== "AUTORIZADA" || recollectionRow.authorized_at === null) {
      return {
        ok: false,
        reason: "RECOLLECTION_NOT_AUTHORIZED",
        recollectionId: input.recollectionId
      };
    }

    if (input.executedAt < recollectionRow.authorized_at) {
      return {
        ok: false,
        reason: "EXECUTION_DATE_BEFORE_AUTHORIZATION",
        recollectionId: input.recollectionId
      };
    }

    await client.query(
      `update "logistics_recollection"
          set "status" = 'EXECUTADA',
              "executed_at" = $2,
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.recollectionId, input.executedAt]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.executedAt,
        input.actorUserId ?? null,
        input.teamContext ?? null,
        EXECUTE_LOGISTICS_RECOLLECTION_COMMAND,
        "logistics_recollection",
        input.recollectionId,
        JSON.stringify({
          status: recollectionRow.status,
          executedAt: recollectionRow.executed_at,
          version: recollectionRow.version
        }),
        JSON.stringify({
          status: "EXECUTADA",
          executedAt: input.executedAt.toISOString(),
          version: recollectionRow.version + 1
        }),
        input.summary,
        input.correlationId
      ]
    );

    await client.query(
      `insert into "outbox_event" (
        "id", "event_type", "aggregate_type", "aggregate_id", "payload", "updated_at"
      ) values ($1, $2, $3, $4, $5::jsonb, current_timestamp)`,
      [
        randomUUID(),
        "logistics.recollection_executed",
        "logistics_recollection",
        input.recollectionId,
        JSON.stringify({
          recollectionId: input.recollectionId,
          status: "EXECUTADA",
          executedAt: input.executedAt.toISOString(),
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      recollectionId: input.recollectionId,
      status: "EXECUTADA"
    };
  }
}

function hashExecuteLogisticsRecollectionCommand(
  input: ExecuteLogisticsRecollectionCommand
): string {
  const payload = {
    recollectionId: input.recollectionId,
    summary: input.summary
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): ExecuteLogisticsRecollectionResult {
  if (isExecuteLogisticsRecollectionResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isExecuteLogisticsRecollectionResult(
  value: unknown
): value is ExecuteLogisticsRecollectionResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { recollectionId?: unknown }).recollectionId === "string";
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
