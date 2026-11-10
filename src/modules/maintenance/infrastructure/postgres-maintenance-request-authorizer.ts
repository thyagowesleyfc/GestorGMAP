import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  AuthorizeMaintenanceRequestCommand,
  AuthorizeMaintenanceRequestResult,
  MaintenanceRequestAuthorizer
} from "../application/authorize-maintenance-request";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: AuthorizeMaintenanceRequestResult }
  | { kind: "CONFLICT" };

type MaintenanceRequestRow = {
  id: string;
  status:
    | "REGISTRADA"
    | "EM_ANALISE"
    | "ATENDIMENTO_EMITIDO"
    | "ATENDIDA"
    | "FINALIZADA"
    | "REJEITADA"
    | "CANCELADA";
  requested_at: Date;
  authorized_at: Date | null;
  authorized_by_user_id: string | null;
  authorization_reason: string | null;
  version: number;
  gre_code: string;
};

const AUTHORIZE_MAINTENANCE_REQUEST_COMMAND = "maintenance.authorize_request";
const MAINTENANCE_REQUEST_AUTHORIZED_EVENT = "maintenance.request_authorized";

export class PostgresMaintenanceRequestAuthorizer implements MaintenanceRequestAuthorizer {
  constructor(private readonly pool: Pool) {}

  async authorize(
    input: AuthorizeMaintenanceRequestCommand
  ): Promise<AuthorizeMaintenanceRequestResult> {
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
    input: AuthorizeMaintenanceRequestCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashAuthorizeMaintenanceRequestCommand(input);
    const idempotencyId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, AUTHORIZE_MAINTENANCE_REQUEST_COMMAND, input.commandId, requestHash]
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
      [AUTHORIZE_MAINTENANCE_REQUEST_COMMAND, input.commandId]
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
    result: AuthorizeMaintenanceRequestResult
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
    input: AuthorizeMaintenanceRequestCommand
  ): Promise<AuthorizeMaintenanceRequestResult> {
    const request = await client.query<MaintenanceRequestRow>(
      `select mr."id", mr."status"::text as "status", mr."requested_at",
              mr."authorized_at", mr."authorized_by_user_id", mr."authorization_reason",
              mr."version", g."code" as "gre_code"
         from "maintenance_request" mr
         join "entity" e on e."id" = mr."requesting_entity_id"
         join "gre" g on g."id" = e."gre_id"
        where mr."id" = $1
        for update of mr`,
      [input.maintenanceRequestId]
    );
    const requestRow = request.rows[0];

    if (requestRow === undefined) {
      return {
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_FOUND",
        maintenanceRequestId: input.maintenanceRequestId
      };
    }

    if (requestRow.status !== "REGISTRADA") {
      return {
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_REGISTRADA",
        maintenanceRequestId: input.maintenanceRequestId
      };
    }

    if (input.authorizedAt < requestRow.requested_at) {
      return {
        ok: false,
        reason: "AUTHORIZATION_DATE_BEFORE_REQUEST",
        maintenanceRequestId: input.maintenanceRequestId
      };
    }

    if (!(await this.isAuthorized(client, input.actorUserId, requestRow.gre_code))) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED" };
    }

    await client.query(
      `update "maintenance_request"
          set "status" = 'EM_ANALISE',
              "authorized_at" = $2,
              "authorized_by_user_id" = $3,
              "authorization_reason" = $4,
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.maintenanceRequestId, input.authorizedAt, input.actorUserId, input.reason]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.authorizedAt,
        input.actorUserId,
        input.teamContext,
        AUTHORIZE_MAINTENANCE_REQUEST_COMMAND,
        "maintenance_request",
        input.maintenanceRequestId,
        JSON.stringify({
          status: requestRow.status,
          authorizedAt: requestRow.authorized_at,
          authorizedByUserId: requestRow.authorized_by_user_id,
          authorizationReason: requestRow.authorization_reason,
          version: requestRow.version
        }),
        JSON.stringify({
          status: "EM_ANALISE",
          authorizedAt: input.authorizedAt.toISOString(),
          authorizedByUserId: input.actorUserId,
          authorizationReason: input.reason,
          version: requestRow.version + 1
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
        MAINTENANCE_REQUEST_AUTHORIZED_EVENT,
        "maintenance_request",
        input.maintenanceRequestId,
        JSON.stringify({
          maintenanceRequestId: input.maintenanceRequestId,
          status: "EM_ANALISE",
          authorizedAt: input.authorizedAt.toISOString(),
          authorizedByUserId: input.actorUserId,
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      maintenanceRequestId: input.maintenanceRequestId,
      status: "EM_ANALISE"
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
            and t."name" = 'Ger\u00eancia'
            and (
              tm."scope_type" = 'GLOBAL'
              or (tm."scope_type" = 'GRE' and tm."gre_code" = $2)
            )
       ) as "authorized"`,
      [actorUserId, greCode]
    );

    return authorization.rows[0]?.authorized === true;
  }
}

function hashAuthorizeMaintenanceRequestCommand(input: AuthorizeMaintenanceRequestCommand): string {
  const payload = {
    maintenanceRequestId: input.maintenanceRequestId,
    reason: input.reason
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): AuthorizeMaintenanceRequestResult {
  if (isAuthorizeMaintenanceRequestResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isAuthorizeMaintenanceRequestResult(
  value: unknown
): value is AuthorizeMaintenanceRequestResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { maintenanceRequestId?: unknown }).maintenanceRequestId === "string" &&
      (value as { status?: unknown }).status === "EM_ANALISE"
    );
  }

  return isAuthorizeMaintenanceRequestFailureReason((value as { reason?: unknown }).reason);
}

function isAuthorizeMaintenanceRequestFailureReason(
  value: unknown
): value is Exclude<AuthorizeMaintenanceRequestResult, { ok: true }>["reason"] {
  return (
    typeof value === "string" &&
    new Set([
      "INVALID_COMMAND_ID",
      "INVALID_MAINTENANCE_REQUEST_ID",
      "INVALID_REASON",
      "INVALID_AUTHORIZED_AT",
      "INVALID_ACTOR_USER_ID",
      "INVALID_TEAM_CONTEXT",
      "IDEMPOTENCY_KEY_CONFLICT",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      "MAINTENANCE_REQUEST_NOT_REGISTRADA",
      "AUTHORIZATION_DATE_BEFORE_REQUEST",
      "ACTOR_NOT_AUTHORIZED"
    ]).has(value)
  );
}
