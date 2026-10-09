import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  AuthorizedMaterialRequestCreator,
  CreateAuthorizedMaterialRequestCommand,
  CreateAuthorizedMaterialRequestItemCommand,
  CreateAuthorizedMaterialRequestResult
} from "../application/create-authorized-material-request";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: CreateAuthorizedMaterialRequestResult }
  | { kind: "CONFLICT" };

type LookupTable = "entity" | "user_account" | "material_singular" | "material_configuration";

const UNIQUE_VIOLATION = "23505";
const CREATE_AUTHORIZED_MATERIAL_REQUEST_COMMAND = "requests.create_authorized_material_request";

export class PostgresAuthorizedMaterialRequestCreator implements AuthorizedMaterialRequestCreator {
  constructor(private readonly pool: Pool) {}

  async create(
    input: CreateAuthorizedMaterialRequestCommand
  ): Promise<CreateAuthorizedMaterialRequestResult> {
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

      const result = await this.createInTransaction(client, input);
      await this.storeIdempotencyResult(client, reservation.id, result);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);

      if (isPgError(error) && error.code === UNIQUE_VIOLATION) {
        if (error.constraint === "material_request_code_key") {
          return { ok: false, reason: "DUPLICATE_REQUEST_CODE" };
        }

        if (
          error.constraint === "material_request_reference_system_identifier_key" ||
          error.constraint === "material_request_reference_request_system_identifier_key"
        ) {
          return { ok: false, reason: "DUPLICATE_REFERENCE" };
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: CreateAuthorizedMaterialRequestCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashCreateAuthorizedMaterialRequestCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, CREATE_AUTHORIZED_MATERIAL_REQUEST_COMMAND, input.commandId, requestHash]
    );

    if (inserted.rows.length === 1) return { kind: "NEW", id: inserted.rows[0].id };

    const existing = await client.query<IdempotencyRow>(
      `select "request_hash", "status", "result_json"
         from "command_idempotency"
        where "command_name" = $1
          and "idempotency_key" = $2
        for update`,
      [CREATE_AUTHORIZED_MATERIAL_REQUEST_COMMAND, input.commandId]
    );
    const row = existing.rows[0];

    if (row === undefined || row.request_hash !== requestHash) return { kind: "CONFLICT" };
    if (row.status === "SUCCEEDED" && row.result_json !== null) {
      return { kind: "REPLAY", result: parseStoredResult(row.result_json) };
    }

    return { kind: "CONFLICT" };
  }

  private async storeIdempotencyResult(
    client: PoolClient,
    idempotencyId: string,
    result: CreateAuthorizedMaterialRequestResult
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

  private async createInTransaction(
    client: PoolClient,
    input: CreateAuthorizedMaterialRequestCommand
  ): Promise<CreateAuthorizedMaterialRequestResult> {
    if (!(await rowExists(client, "entity", input.requestingEntityId))) {
      return { ok: false, reason: "REQUESTING_ENTITY_NOT_FOUND" };
    }

    if (input.registeredByUserId !== undefined) {
      if (!(await rowExists(client, "user_account", input.registeredByUserId))) {
        return { ok: false, reason: "REGISTERED_BY_USER_NOT_FOUND" };
      }
    }

    const missingItem = await findMissingMaterialItem(client, input.items);
    if (missingItem !== undefined) {
      return { ok: false, reason: "MATERIAL_NOT_FOUND", itemLineNumber: missingItem.lineNumber };
    }

    const materialRequestId = randomUUID();

    await client.query(
      `insert into "material_request" (
        "id", "code", "requesting_entity_id", "status", "requested_at", "summary",
        "registered_by_user_id", "version", "updated_at"
      ) values ($1, $2, $3, 'ANALISADA', $4, $5, $6, 2, current_timestamp)`,
      [
        materialRequestId,
        input.code,
        input.requestingEntityId,
        input.requestedAt,
        input.summary,
        input.registeredByUserId ?? null
      ]
    );

    for (const item of input.items) {
      await client.query(
        `insert into "material_request_item" (
          "id", "material_request_id", "line_number", "material_singular_id",
          "material_configuration_id", "requested_quantity", "authorized_quantity", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, $7, current_timestamp)`,
        [
          randomUUID(),
          materialRequestId,
          item.lineNumber,
          item.materialSingularId ?? null,
          item.materialConfigurationId ?? null,
          item.requestedQuantity,
          item.authorizedQuantity
        ]
      );
    }

    for (const reference of input.references) {
      await client.query(
        `insert into "material_request_reference" (
          "id", "material_request_id", "system", "reference_type", "identifier", "url", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
        [
          randomUUID(),
          materialRequestId,
          reference.system,
          reference.referenceType,
          reference.identifier,
          reference.url ?? null
        ]
      );
    }

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.requestedAt,
        input.actorUserId ?? input.registeredByUserId ?? null,
        input.teamContext ?? null,
        CREATE_AUTHORIZED_MATERIAL_REQUEST_COMMAND,
        "material_request",
        materialRequestId,
        JSON.stringify(null),
        JSON.stringify({
          code: input.code,
          requestingEntityId: input.requestingEntityId,
          status: "ANALISADA",
          itemCount: input.items.length,
          referenceCount: input.references.length
        }),
        input.reason,
        input.correlationId
      ]
    );

    return {
      ok: true,
      materialRequestId,
      status: "ANALISADA",
      itemCount: input.items.length,
      referenceCount: input.references.length
    };
  }
}

async function rowExists(client: PoolClient, tableName: LookupTable, id: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `select exists(select 1 from "${tableName}" where "id" = $1) as "exists"`,
    [id]
  );
  return result.rows[0]?.exists === true;
}

async function findMissingMaterialItem(
  client: PoolClient,
  items: CreateAuthorizedMaterialRequestItemCommand[]
): Promise<CreateAuthorizedMaterialRequestItemCommand | undefined> {
  for (const item of items) {
    const tableName =
      item.materialSingularId !== undefined ? "material_singular" : "material_configuration";
    const id = item.materialSingularId ?? item.materialConfigurationId;
    if (id === undefined || !(await rowExists(client, tableName, id))) return item;
  }
  return undefined;
}

function hashCreateAuthorizedMaterialRequestCommand(
  input: CreateAuthorizedMaterialRequestCommand
): string {
  const payload = {
    code: input.code,
    requestingEntityId: input.requestingEntityId,
    items: input.items,
    references: [...input.references].sort((left, right) =>
      `${left.system}:${left.identifier}`.localeCompare(`${right.system}:${right.identifier}`)
    ),
    summary: input.summary,
    reason: input.reason,
    registeredByUserId: input.registeredByUserId
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): CreateAuthorizedMaterialRequestResult {
  if (isCreateAuthorizedMaterialRequestResult(value)) return value;
  throw new Error("Stored idempotency result is invalid.");
}

function isCreateAuthorizedMaterialRequestResult(
  value: unknown
): value is CreateAuthorizedMaterialRequestResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === true) {
    return typeof (value as { materialRequestId?: unknown }).materialRequestId === "string";
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
