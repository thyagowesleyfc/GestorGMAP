import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  RecordMaintenanceServiceOrderExecutionCommand,
  RecordMaintenanceServiceOrderExecutionFailureReason,
  RecordMaintenanceServiceOrderExecutionResult,
  MaintenanceServiceOrderExecutionRecorder
} from "../application/record-maintenance-service-order-execution";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RecordMaintenanceServiceOrderExecutionResult }
  | { kind: "CONFLICT" };

type ServiceOrderRow = {
  id: string;
  status: string;
};

type TargetGreRow = {
  gre_code: string;
};

const RECORD_MAINTENANCE_SERVICE_ORDER_EXECUTION_COMMAND =
  "maintenance.record_service_order_execution";
const MAINTENANCE_SERVICE_ORDER_EXECUTED_EVENT = "maintenance.service_order_executed";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio"];

export class PostgresMaintenanceServiceOrderExecutionRecorder implements MaintenanceServiceOrderExecutionRecorder {
  constructor(private readonly pool: Pool) {}

  async record(
    input: RecordMaintenanceServiceOrderExecutionCommand
  ): Promise<RecordMaintenanceServiceOrderExecutionResult> {
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

      const result = await this.recordInTransaction(client, input);
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
    input: RecordMaintenanceServiceOrderExecutionCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashRecordExecutionCommand(input);
    const idempotencyId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [
        idempotencyId,
        RECORD_MAINTENANCE_SERVICE_ORDER_EXECUTION_COMMAND,
        input.commandId,
        requestHash
      ]
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
      [RECORD_MAINTENANCE_SERVICE_ORDER_EXECUTION_COMMAND, input.commandId]
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
    result: RecordMaintenanceServiceOrderExecutionResult
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

  private async recordInTransaction(
    client: PoolClient,
    input: RecordMaintenanceServiceOrderExecutionCommand
  ): Promise<RecordMaintenanceServiceOrderExecutionResult> {
    const serviceOrder = await client.query<ServiceOrderRow>(
      `select "id", "status"::text as "status"
         from "maintenance_service_order"
        where "id" = $1
        for update`,
      [input.serviceOrderId]
    );
    const serviceOrderRow = serviceOrder.rows[0];

    if (serviceOrderRow === undefined) {
      return {
        ok: false,
        reason: "SERVICE_ORDER_NOT_FOUND",
        serviceOrderId: input.serviceOrderId
      };
    }
    if (serviceOrderRow.status !== "ENVIADA_AO_PRESTADOR") {
      return {
        ok: false,
        reason: "SERVICE_ORDER_NOT_EXECUTABLE",
        serviceOrderId: input.serviceOrderId
      };
    }

    const targets = await client.query<TargetGreRow>(
      `select g."code" as "gre_code"
         from "maintenance_service_order_patrimony" sop
         join "patrimony" p on p."id" = sop."patrimony_id"
         join "entity" e on e."id" = p."responsible_entity_id"
         join "gre" g on g."id" = e."gre_id"
        where sop."service_order_id" = $1
        for share of sop, p`,
      [input.serviceOrderId]
    );
    const greCodes = [...new Set(targets.rows.map((target) => target.gre_code))];

    for (const greCode of greCodes) {
      if (!(await this.isAuthorized(client, input.actorUserId, greCode))) {
        return {
          ok: false,
          reason: "ACTOR_NOT_AUTHORIZED",
          serviceOrderId: input.serviceOrderId
        };
      }
    }

    await client.query(
      `update "maintenance_service_order"
          set "status" = 'EXECUTADA',
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.serviceOrderId]
    );

    const previousValue = { status: serviceOrderRow.status };
    const nextValue = {
      status: "EXECUTADA",
      executedAt: input.executedAt,
      executedByUserId: input.actorUserId,
      correlationId: input.correlationId
    };
    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        randomUUID(),
        input.executedAt,
        input.actorUserId,
        input.teamContext,
        RECORD_MAINTENANCE_SERVICE_ORDER_EXECUTION_COMMAND,
        "maintenance_service_order",
        input.serviceOrderId,
        JSON.stringify(previousValue),
        JSON.stringify(nextValue),
        input.correlationId
      ]
    );

    await client.query(
      `insert into "outbox_event" (
        "id", "event_type", "aggregate_type", "aggregate_id", "payload", "updated_at"
      ) values ($1, $2, $3, $4, $5::jsonb, current_timestamp)`,
      [
        randomUUID(),
        MAINTENANCE_SERVICE_ORDER_EXECUTED_EVENT,
        "maintenance_service_order",
        input.serviceOrderId,
        JSON.stringify({
          serviceOrderId: input.serviceOrderId,
          status: "EXECUTADA",
          executedAt: input.executedAt,
          executedByUserId: input.actorUserId,
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      serviceOrderId: input.serviceOrderId,
      status: "EXECUTADA"
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

function hashRecordExecutionCommand(input: RecordMaintenanceServiceOrderExecutionCommand): string {
  const payload = {
    serviceOrderId: input.serviceOrderId,
    executedAt: input.executedAt.toISOString(),
    actorUserId: input.actorUserId
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RecordMaintenanceServiceOrderExecutionResult {
  if (isRecordExecutionResult(value)) {
    return value;
  }
  throw new Error("Stored service order execution idempotency result is invalid.");
}

function isRecordExecutionResult(
  value: unknown
): value is RecordMaintenanceServiceOrderExecutionResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  if (value.ok === true) {
    return (
      typeof (value as { serviceOrderId?: unknown }).serviceOrderId === "string" &&
      (value as { status?: unknown }).status === "EXECUTADA"
    );
  }

  return isFailureReason((value as { reason?: unknown }).reason);
}

function isFailureReason(
  value: unknown
): value is RecordMaintenanceServiceOrderExecutionFailureReason {
  return (
    typeof value === "string" &&
    new Set([
      "INVALID_COMMAND_ID",
      "INVALID_SERVICE_ORDER_ID",
      "INVALID_EXECUTED_AT",
      "INVALID_ACTOR_USER_ID",
      "INVALID_TEAM_CONTEXT",
      "IDEMPOTENCY_KEY_CONFLICT",
      "SERVICE_ORDER_NOT_FOUND",
      "SERVICE_ORDER_NOT_EXECUTABLE",
      "ACTOR_NOT_AUTHORIZED"
    ]).has(value)
  );
}
