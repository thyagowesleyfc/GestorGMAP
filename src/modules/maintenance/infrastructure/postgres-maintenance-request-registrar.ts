import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  MaintenanceRequestRegistrar,
  RegisterMaintenanceRequestCommand,
  RegisterMaintenanceRequestResult
} from "../application/register-maintenance-request";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RegisterMaintenanceRequestResult }
  | { kind: "CONFLICT" };

type RequestingEntityRow = {
  id: string;
  gre_code: string;
};

const UNIQUE_VIOLATION = "23505";
const REGISTER_MAINTENANCE_REQUEST_COMMAND = "maintenance.register_request";
const MAINTENANCE_REQUEST_REGISTERED_EVENT = "maintenance.request_registered";
const AUTHORIZED_TEAM_NAMES = ["Triagem", "Ger\u00eancia"];

export class PostgresMaintenanceRequestRegistrar implements MaintenanceRequestRegistrar {
  constructor(private readonly pool: Pool) {}

  async register(
    input: RegisterMaintenanceRequestCommand
  ): Promise<RegisterMaintenanceRequestResult> {
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

      if (isPgError(error) && error.code === UNIQUE_VIOLATION) {
        if (error.constraint === "maintenance_request_reference_system_identifier_key") {
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
    input: RegisterMaintenanceRequestCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashRegisterMaintenanceRequestCommand(input);
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [randomUUID(), REGISTER_MAINTENANCE_REQUEST_COMMAND, input.commandId, requestHash]
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
      [REGISTER_MAINTENANCE_REQUEST_COMMAND, input.commandId]
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
    result: RegisterMaintenanceRequestResult
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
    input: RegisterMaintenanceRequestCommand
  ): Promise<RegisterMaintenanceRequestResult> {
    const entityResult = await client.query<RequestingEntityRow>(
      `select e."id", g."code" as "gre_code"
         from "entity" e
         join "gre" g on g."id" = e."gre_id"
        where e."id" = $1
        for share of e, g`,
      [input.requestingEntityId]
    );
    const entity = entityResult.rows[0];

    if (entity === undefined) {
      return { ok: false, reason: "REQUESTING_ENTITY_NOT_FOUND" };
    }

    if (!(await this.isAuthorized(client, input.actorUserId, entity.gre_code))) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED" };
    }

    const maintenanceRequestId = randomUUID();

    await client.query(
      `insert into "maintenance_request" (
        "id", "requesting_entity_id", "status", "summary", "description",
        "requested_at", "registered_by_user_id", "version", "correlation_id", "updated_at"
      ) values ($1, $2, 'REGISTRADA', $3, $4, $5, $6, 1, $7, current_timestamp)`,
      [
        maintenanceRequestId,
        input.requestingEntityId,
        input.summary,
        input.description,
        input.requestedAt,
        input.actorUserId,
        input.correlationId
      ]
    );

    for (const reference of input.references) {
      await client.query(
        `insert into "maintenance_request_reference" (
          "id", "maintenance_request_id", "system", "identifier", "url", "updated_at"
        ) values ($1, $2, $3, $4, $5, current_timestamp)`,
        [
          randomUUID(),
          maintenanceRequestId,
          reference.system,
          reference.identifier,
          reference.url ?? null
        ]
      );
    }

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        randomUUID(),
        input.requestedAt,
        input.actorUserId,
        input.teamContext,
        MAINTENANCE_REQUEST_REGISTERED_EVENT,
        "maintenance_request",
        maintenanceRequestId,
        JSON.stringify(null),
        JSON.stringify({
          id: maintenanceRequestId,
          entity: input.requestingEntityId,
          status: "REGISTRADA",
          referenceCount: input.references.length
        }),
        input.correlationId
      ]
    );

    await client.query(
      `insert into "outbox_event" (
        "id", "event_type", "aggregate_type", "aggregate_id", "payload", "updated_at"
      ) values ($1, $2, $3, $4, $5::jsonb, current_timestamp)`,
      [
        randomUUID(),
        MAINTENANCE_REQUEST_REGISTERED_EVENT,
        "maintenance_request",
        maintenanceRequestId,
        JSON.stringify({
          id: maintenanceRequestId,
          entity: input.requestingEntityId,
          status: "REGISTRADA",
          referenceCount: input.references.length,
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      maintenanceRequestId,
      status: "REGISTRADA",
      referenceCount: input.references.length
    };
  }

  private async isAuthorized(
    client: PoolClient,
    actorUserId: string,
    greCode: string
  ): Promise<boolean> {
    const authorization = await client.query<{ authorized: boolean }>(
      `select exists(
         select 1
           from "user_account" u
           join "team_membership" tm on tm."user_id" = u."id"
           join "team" t on t."id" = tm."team_id"
          where u."id" = $1
            and u."status" = 'ACTIVE'
            and tm."active" = true
            and t."name" = any($2::varchar[])
            and (
              tm."scope_type" = 'GLOBAL'
              or (tm."scope_type" = 'GRE' and tm."gre_code" = $3)
            )
       ) as "authorized"`,
      [actorUserId, AUTHORIZED_TEAM_NAMES, greCode]
    );

    return authorization.rows[0]?.authorized === true;
  }
}

function hashRegisterMaintenanceRequestCommand(input: RegisterMaintenanceRequestCommand): string {
  const payload = {
    requestingEntityId: input.requestingEntityId,
    summary: input.summary,
    description: input.description,
    references: [...input.references]
      .map((reference) => ({
        system: reference.system,
        identifier: reference.identifier,
        url: reference.url ?? null
      }))
      .sort((left, right) =>
        `${left.system}:${left.identifier}:${left.url ?? ""}`.localeCompare(
          `${right.system}:${right.identifier}:${right.url ?? ""}`
        )
      ),
    requestedAt: input.requestedAt.toISOString(),
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RegisterMaintenanceRequestResult {
  if (isRegisterMaintenanceRequestResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isRegisterMaintenanceRequestResult(
  value: unknown
): value is RegisterMaintenanceRequestResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { maintenanceRequestId?: unknown }).maintenanceRequestId === "string" &&
      (value as { status?: unknown }).status === "REGISTRADA" &&
      typeof (value as { referenceCount?: unknown }).referenceCount === "number"
    );
  }

  return isMaintenanceRequestFailureReason((value as { reason?: unknown }).reason);
}

function isMaintenanceRequestFailureReason(
  value: unknown
): value is Exclude<RegisterMaintenanceRequestResult, { ok: true }>["reason"] {
  return (
    typeof value === "string" &&
    new Set([
      "INVALID_COMMAND_ID",
      "INVALID_REQUESTING_ENTITY_ID",
      "INVALID_SUMMARY",
      "INVALID_DESCRIPTION",
      "INVALID_REQUESTED_AT",
      "INVALID_ACTOR_USER_ID",
      "INVALID_TEAM_CONTEXT",
      "INVALID_REFERENCE_SYSTEM",
      "INVALID_REFERENCE_IDENTIFIER",
      "INVALID_REFERENCE_URL",
      "DUPLICATE_REFERENCE",
      "IDEMPOTENCY_KEY_CONFLICT",
      "ACTOR_NOT_AUTHORIZED",
      "REQUESTING_ENTITY_NOT_FOUND"
    ]).has(value)
  );
}

function isPgError(error: unknown): error is { code: string; constraint?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
