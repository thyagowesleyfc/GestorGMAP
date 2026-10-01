import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  DispatchMaterialRequestCommand,
  DispatchMaterialRequestResult,
  MaterialRequestDispatcher
} from "../application/dispatch-material-request";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: DispatchMaterialRequestResult }
  | { kind: "CONFLICT" };

type MaterialRequestRow = {
  id: string;
  status: "TRIAGEM" | "NOVA" | "ANALISADA" | "DESPACHADA" | "FINALIZADA";
  version: number;
};

type MaterialRequestItemAuthorizationRow = {
  authorized_quantity: number | null;
};

const DISPATCH_MATERIAL_REQUEST_COMMAND = "requests.dispatch_material_request";

export class PostgresMaterialRequestDispatcher implements MaterialRequestDispatcher {
  constructor(private readonly pool: Pool) {}

  async dispatch(input: DispatchMaterialRequestCommand): Promise<DispatchMaterialRequestResult> {
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

      const result = await this.dispatchInTransaction(client, input);
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
    input: DispatchMaterialRequestCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashDispatchMaterialRequestCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, DISPATCH_MATERIAL_REQUEST_COMMAND, input.commandId, requestHash]
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
      [DISPATCH_MATERIAL_REQUEST_COMMAND, input.commandId]
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
    result: DispatchMaterialRequestResult
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

  private async dispatchInTransaction(
    client: PoolClient,
    input: DispatchMaterialRequestCommand
  ): Promise<DispatchMaterialRequestResult> {
    const request = await client.query<MaterialRequestRow>(
      `select "id", "status"::text as "status", "version"
         from "material_request"
        where "id" = $1
        for update`,
      [input.materialRequestId]
    );
    const requestRow = request.rows[0];

    if (requestRow === undefined) {
      return { ok: false, reason: "MATERIAL_REQUEST_NOT_FOUND" };
    }

    if (requestRow.status !== "ANALISADA") {
      return { ok: false, reason: "MATERIAL_REQUEST_NOT_ANALYZED" };
    }

    const items = await client.query<MaterialRequestItemAuthorizationRow>(
      `select "authorized_quantity"
         from "material_request_item"
        where "material_request_id" = $1
        for update`,
      [input.materialRequestId]
    );

    if (items.rows.length === 0 || items.rows.some((item) => item.authorized_quantity === null)) {
      return { ok: false, reason: "AUTHORIZATION_SET_INCOMPLETE" };
    }

    await client.query(
      `update "material_request"
          set "status" = 'DESPACHADA',
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.materialRequestId]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.dispatchedAt,
        input.actorUserId ?? null,
        input.teamContext ?? null,
        DISPATCH_MATERIAL_REQUEST_COMMAND,
        "material_request",
        input.materialRequestId,
        JSON.stringify({ status: requestRow.status, version: requestRow.version }),
        JSON.stringify({ status: "DESPACHADA", version: requestRow.version + 1 }),
        input.reason,
        input.correlationId
      ]
    );

    return { ok: true, materialRequestId: input.materialRequestId, status: "DESPACHADA" };
  }
}

function hashDispatchMaterialRequestCommand(input: DispatchMaterialRequestCommand): string {
  const payload = {
    materialRequestId: input.materialRequestId,
    reason: input.reason
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): DispatchMaterialRequestResult {
  if (isDispatchMaterialRequestResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isDispatchMaterialRequestResult(value: unknown): value is DispatchMaterialRequestResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { materialRequestId?: unknown }).materialRequestId === "string";
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
