import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  AuthorizeLogisticsRecollectionCommand,
  AuthorizeLogisticsRecollectionResult,
  LogisticsRecollectionAuthorizer
} from "../application/authorize-logistics-recollection";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: AuthorizeLogisticsRecollectionResult }
  | { kind: "CONFLICT" };

type RecollectionRow = {
  id: string;
  status: "SOLICITADA" | "AUTORIZADA" | "EXECUTADA" | "CANCELADA";
  requested_at: Date;
  authorized_at: Date | null;
  version: number;
};

const AUTHORIZE_LOGISTICS_RECOLLECTION_COMMAND = "logistics.authorize_recollection";

export class PostgresLogisticsRecollectionAuthorizer implements LogisticsRecollectionAuthorizer {
  constructor(private readonly pool: Pool) {}

  async authorize(
    input: AuthorizeLogisticsRecollectionCommand
  ): Promise<AuthorizeLogisticsRecollectionResult> {
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

      const result = await this.authorizeInTransaction(client, input);
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
    input: AuthorizeLogisticsRecollectionCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashAuthorizeLogisticsRecollectionCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, AUTHORIZE_LOGISTICS_RECOLLECTION_COMMAND, input.commandId, requestHash]
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
      [AUTHORIZE_LOGISTICS_RECOLLECTION_COMMAND, input.commandId]
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
    result: AuthorizeLogisticsRecollectionResult
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

  private async authorizeInTransaction(
    client: PoolClient,
    input: AuthorizeLogisticsRecollectionCommand
  ): Promise<AuthorizeLogisticsRecollectionResult> {
    const recollection = await client.query<RecollectionRow>(
      `select "id", "status"::text as "status", "requested_at", "authorized_at", "version"
         from "logistics_recollection"
        where "id" = $1
        for update`,
      [input.recollectionId]
    );
    const recollectionRow = recollection.rows[0];

    if (recollectionRow === undefined) {
      return { ok: false, reason: "RECOLLECTION_NOT_FOUND", recollectionId: input.recollectionId };
    }

    if (recollectionRow.status !== "SOLICITADA") {
      return {
        ok: false,
        reason: "RECOLLECTION_NOT_REQUESTED",
        recollectionId: input.recollectionId
      };
    }

    if (input.authorizedAt < recollectionRow.requested_at) {
      return {
        ok: false,
        reason: "AUTHORIZATION_DATE_BEFORE_REQUEST",
        recollectionId: input.recollectionId
      };
    }

    await client.query(
      `update "logistics_recollection"
          set "status" = 'AUTORIZADA',
              "authorized_at" = $2,
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.recollectionId, input.authorizedAt]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.authorizedAt,
        input.actorUserId ?? null,
        input.teamContext ?? null,
        AUTHORIZE_LOGISTICS_RECOLLECTION_COMMAND,
        "logistics_recollection",
        input.recollectionId,
        JSON.stringify({
          status: recollectionRow.status,
          authorizedAt: recollectionRow.authorized_at,
          version: recollectionRow.version
        }),
        JSON.stringify({
          status: "AUTORIZADA",
          authorizedAt: input.authorizedAt.toISOString(),
          version: recollectionRow.version + 1
        }),
        input.reason,
        input.correlationId
      ]
    );

    await client.query(
      `insert into "outbox_event" (
        "id", "event_type", "aggregate_type", "aggregate_id", "payload", "updated_at"
      ) values ($1, $2, $3, $4, $5::jsonb, current_timestamp)`,
      [
        randomUUID(),
        "logistics.recollection_authorized",
        "logistics_recollection",
        input.recollectionId,
        JSON.stringify({
          recollectionId: input.recollectionId,
          status: "AUTORIZADA",
          authorizedAt: input.authorizedAt.toISOString(),
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      recollectionId: input.recollectionId,
      status: "AUTORIZADA"
    };
  }
}

function hashAuthorizeLogisticsRecollectionCommand(
  input: AuthorizeLogisticsRecollectionCommand
): string {
  const payload = {
    recollectionId: input.recollectionId,
    reason: input.reason
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): AuthorizeLogisticsRecollectionResult {
  if (isAuthorizeLogisticsRecollectionResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isAuthorizeLogisticsRecollectionResult(
  value: unknown
): value is AuthorizeLogisticsRecollectionResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { recollectionId?: unknown }).recollectionId === "string";
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
