import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  LogisticsRecollectionRegistrar,
  RegisterLogisticsRecollectionCommand,
  RegisterLogisticsRecollectionResult
} from "../application/register-logistics-recollection";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RegisterLogisticsRecollectionResult }
  | { kind: "CONFLICT" };

type EntityRow = {
  id: string;
};

type UserRow = {
  id: string;
};

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const REGISTER_LOGISTICS_RECOLLECTION_COMMAND = "logistics.register_recollection";

export class PostgresLogisticsRecollectionRegistrar implements LogisticsRecollectionRegistrar {
  constructor(private readonly pool: Pool) {}

  async register(
    input: RegisterLogisticsRecollectionCommand
  ): Promise<RegisterLogisticsRecollectionResult> {
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

      const result = await this.registerInTransaction(client, input);
      await this.storeIdempotencyResult(client, reservation.id, result);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);

      if (isPgError(error)) {
        if (
          error.code === UNIQUE_VIOLATION &&
          error.constraint === "logistics_recollection_code_key"
        ) {
          return { ok: false, reason: "DUPLICATE_RECOLLECTION_CODE" };
        }

        if (error.code === FOREIGN_KEY_VIOLATION) {
          return { ok: false, reason: "ENTITY_NOT_FOUND" };
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: RegisterLogisticsRecollectionCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashRegisterLogisticsRecollectionCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, REGISTER_LOGISTICS_RECOLLECTION_COMMAND, input.commandId, requestHash]
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
      [REGISTER_LOGISTICS_RECOLLECTION_COMMAND, input.commandId]
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
    result: RegisterLogisticsRecollectionResult
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

  private async registerInTransaction(
    client: PoolClient,
    input: RegisterLogisticsRecollectionCommand
  ): Promise<RegisterLogisticsRecollectionResult> {
    const requestingEntity = await this.findEntityForLock(client, input.requestingEntityId);
    if (requestingEntity === undefined) {
      return { ok: false, reason: "ENTITY_NOT_FOUND", entityId: input.requestingEntityId };
    }

    const receivingEntity = await this.findEntityForLock(client, input.receivingEntityId);
    if (receivingEntity === undefined) {
      return { ok: false, reason: "ENTITY_NOT_FOUND", entityId: input.receivingEntityId };
    }

    if (input.requestedByUserId !== undefined) {
      const requestedByUser = await client.query<UserRow>(
        `select "id"
           from "user_account"
          where "id" = $1
          for key share`,
        [input.requestedByUserId]
      );

      if (requestedByUser.rows[0] === undefined) {
        return {
          ok: false,
          reason: "REQUESTED_BY_USER_NOT_FOUND",
          requestedByUserId: input.requestedByUserId
        };
      }
    }

    const recollectionId = randomUUID();

    await client.query(
      `insert into "logistics_recollection" (
        "id", "code", "requesting_entity_id", "receiving_entity_id", "requested_by_user_id",
        "status", "requested_at", "summary", "updated_at"
      ) values ($1, $2, $3, $4, $5, 'SOLICITADA', $6, $7, current_timestamp)`,
      [
        recollectionId,
        input.code,
        input.requestingEntityId,
        input.receivingEntityId,
        input.requestedByUserId ?? null,
        input.requestedAt,
        input.summary
      ]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.requestedAt,
        input.actorUserId ?? null,
        input.teamContext ?? null,
        REGISTER_LOGISTICS_RECOLLECTION_COMMAND,
        "logistics_recollection",
        recollectionId,
        JSON.stringify({}),
        JSON.stringify({
          status: "SOLICITADA",
          requestingEntityId: input.requestingEntityId,
          receivingEntityId: input.receivingEntityId
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
        "logistics.recollection_registered",
        "logistics_recollection",
        recollectionId,
        JSON.stringify({
          recollectionId,
          requestingEntityId: input.requestingEntityId,
          receivingEntityId: input.receivingEntityId,
          status: "SOLICITADA",
          requestedAt: input.requestedAt.toISOString(),
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      recollectionId,
      requestingEntityId: input.requestingEntityId,
      receivingEntityId: input.receivingEntityId,
      status: "SOLICITADA"
    };
  }

  private async findEntityForLock(
    client: PoolClient,
    entityId: string
  ): Promise<EntityRow | undefined> {
    const entity = await client.query<EntityRow>(
      `select "id"
         from "entity"
        where "id" = $1
        for key share`,
      [entityId]
    );

    return entity.rows[0];
  }
}

function hashRegisterLogisticsRecollectionCommand(
  input: RegisterLogisticsRecollectionCommand
): string {
  const payload = {
    code: input.code,
    requestingEntityId: input.requestingEntityId,
    receivingEntityId: input.receivingEntityId,
    requestedByUserId: input.requestedByUserId ?? null,
    summary: input.summary
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RegisterLogisticsRecollectionResult {
  if (isRegisterLogisticsRecollectionResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isRegisterLogisticsRecollectionResult(
  value: unknown
): value is RegisterLogisticsRecollectionResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { recollectionId?: unknown }).recollectionId === "string";
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}

function isPgError(error: unknown): error is { code: string; constraint?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
