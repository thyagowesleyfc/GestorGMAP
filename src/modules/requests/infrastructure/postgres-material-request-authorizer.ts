import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  AuthorizeMaterialRequestCommand,
  AuthorizeMaterialRequestResult,
  MaterialRequestAuthorizer
} from "../application/authorize-material-request";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: AuthorizeMaterialRequestResult }
  | { kind: "CONFLICT" };

type MaterialRequestRow = {
  id: string;
  status: "TRIAGEM" | "NOVA" | "ANALISADA" | "DESPACHADA" | "FINALIZADA";
  version: number;
};

type MaterialRequestItemRow = {
  id: string;
  requested_quantity: number;
  authorized_quantity: number | null;
};

const AUTHORIZE_MATERIAL_REQUEST_COMMAND = "requests.authorize_material_request";

export class PostgresMaterialRequestAuthorizer implements MaterialRequestAuthorizer {
  constructor(private readonly pool: Pool) {}

  async authorize(input: AuthorizeMaterialRequestCommand): Promise<AuthorizeMaterialRequestResult> {
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
    input: AuthorizeMaterialRequestCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashAuthorizeMaterialRequestCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, AUTHORIZE_MATERIAL_REQUEST_COMMAND, input.commandId, requestHash]
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
      [AUTHORIZE_MATERIAL_REQUEST_COMMAND, input.commandId]
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
    result: AuthorizeMaterialRequestResult
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
    input: AuthorizeMaterialRequestCommand
  ): Promise<AuthorizeMaterialRequestResult> {
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

    if (requestRow.status !== "TRIAGEM") {
      return { ok: false, reason: "MATERIAL_REQUEST_NOT_IN_TRIAGEM" };
    }

    const items = await client.query<MaterialRequestItemRow>(
      `select "id", "requested_quantity", "authorized_quantity"
         from "material_request_item"
        where "material_request_id" = $1
        order by "line_number"
        for update`,
      [input.materialRequestId]
    );

    if (items.rows.length === 0) {
      return { ok: false, reason: "AUTHORIZATION_SET_INCOMPLETE" };
    }

    const itemById = new Map(items.rows.map((item) => [item.id, item]));
    const authorizationByItemId = new Map(
      input.authorizations.map((authorization) => [authorization.itemId, authorization])
    );

    for (const authorization of input.authorizations) {
      const item = itemById.get(authorization.itemId);

      if (item === undefined) {
        return {
          ok: false,
          reason: "MATERIAL_REQUEST_ITEM_NOT_FOUND",
          itemId: authorization.itemId
        };
      }

      if (authorization.authorizedQuantity > item.requested_quantity) {
        return {
          ok: false,
          reason: "AUTHORIZED_QUANTITY_EXCEEDS_REQUESTED",
          itemId: authorization.itemId
        };
      }
    }

    for (const item of items.rows) {
      if (!authorizationByItemId.has(item.id)) {
        return { ok: false, reason: "AUTHORIZATION_SET_INCOMPLETE", itemId: item.id };
      }
    }

    for (const authorization of input.authorizations) {
      await client.query(
        `update "material_request_item"
            set "authorized_quantity" = $2,
                "updated_at" = current_timestamp
          where "id" = $1`,
        [authorization.itemId, authorization.authorizedQuantity]
      );
    }

    await client.query(
      `update "material_request"
          set "status" = 'ANALISADA',
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
        input.analyzedAt,
        input.actorUserId ?? null,
        input.teamContext ?? null,
        AUTHORIZE_MATERIAL_REQUEST_COMMAND,
        "material_request",
        input.materialRequestId,
        JSON.stringify({
          status: requestRow.status,
          version: requestRow.version,
          items: items.rows.map((item) => ({
            id: item.id,
            requestedQuantity: item.requested_quantity,
            authorizedQuantity: item.authorized_quantity
          }))
        }),
        JSON.stringify({
          status: "ANALISADA",
          version: requestRow.version + 1,
          items: input.authorizations.map((authorization) => ({
            id: authorization.itemId,
            authorizedQuantity: authorization.authorizedQuantity
          }))
        }),
        input.reason,
        input.correlationId
      ]
    );

    return { ok: true, materialRequestId: input.materialRequestId, status: "ANALISADA" };
  }
}

function hashAuthorizeMaterialRequestCommand(input: AuthorizeMaterialRequestCommand): string {
  const payload = {
    materialRequestId: input.materialRequestId,
    authorizations: [...input.authorizations].sort((left, right) =>
      left.itemId.localeCompare(right.itemId)
    ),
    reason: input.reason
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): AuthorizeMaterialRequestResult {
  if (isAuthorizeMaterialRequestResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isAuthorizeMaterialRequestResult(value: unknown): value is AuthorizeMaterialRequestResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { materialRequestId?: unknown }).materialRequestId === "string";
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
