import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  ConfirmMaintenanceServiceOrderCommand,
  ConfirmMaintenanceServiceOrderFailureReason,
  ConfirmMaintenanceServiceOrderResult,
  MaintenanceServiceOrderConfirmer
} from "../application/confirm-maintenance-service-order";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: ConfirmMaintenanceServiceOrderResult }
  | { kind: "CONFLICT" };

type ServiceOrderRow = {
  id: string;
  entity_id: string;
  status: string;
};

type EntityGreRow = {
  gre_code: string;
};

const CONFIRM_MAINTENANCE_SERVICE_ORDER_COMMAND = "maintenance.confirm_service_order_entity";
const MAINTENANCE_SERVICE_ORDER_ENTITY_CONFIRMED_EVENT =
  "maintenance.service_order_entity_confirmed";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio"];

export class PostgresMaintenanceServiceOrderConfirmer implements MaintenanceServiceOrderConfirmer {
  constructor(private readonly pool: Pool) {}

  async confirm(
    input: ConfirmMaintenanceServiceOrderCommand
  ): Promise<ConfirmMaintenanceServiceOrderResult> {
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

      const result = await this.confirmInTransaction(client, input);
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
    input: ConfirmMaintenanceServiceOrderCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashConfirmCommand(input);
    const idempotencyId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, CONFIRM_MAINTENANCE_SERVICE_ORDER_COMMAND, input.commandId, requestHash]
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
      [CONFIRM_MAINTENANCE_SERVICE_ORDER_COMMAND, input.commandId]
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
    result: ConfirmMaintenanceServiceOrderResult
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

  private async confirmInTransaction(
    client: PoolClient,
    input: ConfirmMaintenanceServiceOrderCommand
  ): Promise<ConfirmMaintenanceServiceOrderResult> {
    const serviceOrder = await client.query<ServiceOrderRow>(
      `select "id", "entity_id", "status"::text as "status"
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
    if (serviceOrderRow.status !== "EXECUTADA") {
      return {
        ok: false,
        reason: "SERVICE_ORDER_NOT_CONFIRMABLE",
        serviceOrderId: input.serviceOrderId
      };
    }

    const existingConfirmation = await client.query<{ id: string }>(
      `select "id"
         from "maintenance_service_order_entity_confirmation"
        where "service_order_id" = $1`,
      [input.serviceOrderId]
    );
    if (existingConfirmation.rows.length > 0) {
      return {
        ok: false,
        reason: "SERVICE_ORDER_ALREADY_CONFIRMED",
        serviceOrderId: input.serviceOrderId
      };
    }

    const entityGre = await client.query<EntityGreRow>(
      `select g."code" as "gre_code"
         from "entity" e
         join "gre" g on g."id" = e."gre_id"
        where e."id" = $1
          and e."active" = true
          and g."active" = true`,
      [serviceOrderRow.entity_id]
    );
    const greCode = entityGre.rows[0]?.gre_code;
    if (greCode === undefined || !(await this.isAuthorized(client, input.actorUserId, greCode))) {
      return {
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        serviceOrderId: input.serviceOrderId
      };
    }

    const confirmationId = randomUUID();
    await client.query(
      `insert into "maintenance_service_order_entity_confirmation" (
        "id", "service_order_id", "entity_id", "confirmed_at",
        "evidence_reference", "registered_by_user_id", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        confirmationId,
        input.serviceOrderId,
        serviceOrderRow.entity_id,
        input.confirmedAt,
        input.evidenceReference,
        input.actorUserId,
        input.correlationId
      ]
    );

    const nextValue = {
      confirmationId,
      serviceOrderId: input.serviceOrderId,
      entityId: serviceOrderRow.entity_id,
      confirmedAt: input.confirmedAt,
      evidenceReference: input.evidenceReference,
      registeredByUserId: input.actorUserId,
      correlationId: input.correlationId
    };
    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        randomUUID(),
        input.confirmedAt,
        input.actorUserId,
        input.teamContext,
        CONFIRM_MAINTENANCE_SERVICE_ORDER_COMMAND,
        "maintenance_service_order_entity_confirmation",
        confirmationId,
        JSON.stringify(null),
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
        MAINTENANCE_SERVICE_ORDER_ENTITY_CONFIRMED_EVENT,
        "maintenance_service_order",
        input.serviceOrderId,
        JSON.stringify({ ...nextValue, status: serviceOrderRow.status })
      ]
    );

    return {
      ok: true,
      serviceOrderId: input.serviceOrderId,
      confirmationId,
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

function hashConfirmCommand(input: ConfirmMaintenanceServiceOrderCommand): string {
  const payload = {
    serviceOrderId: input.serviceOrderId,
    evidenceReference: input.evidenceReference,
    confirmedAt: input.confirmedAt.toISOString(),
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): ConfirmMaintenanceServiceOrderResult {
  if (isConfirmResult(value)) {
    return value;
  }
  throw new Error("Stored service order entity confirmation idempotency result is invalid.");
}

function isConfirmResult(value: unknown): value is ConfirmMaintenanceServiceOrderResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  if (value.ok === true) {
    const result = value as {
      serviceOrderId?: unknown;
      confirmationId?: unknown;
      status?: unknown;
    };
    return (
      typeof result.serviceOrderId === "string" &&
      typeof result.confirmationId === "string" &&
      result.status === "EXECUTADA"
    );
  }

  return isFailureReason((value as { reason?: unknown }).reason);
}

function isFailureReason(value: unknown): value is ConfirmMaintenanceServiceOrderFailureReason {
  return (
    typeof value === "string" &&
    new Set([
      "INVALID_COMMAND_ID",
      "INVALID_SERVICE_ORDER_ID",
      "INVALID_EVIDENCE_REFERENCE",
      "INVALID_CONFIRMED_AT",
      "INVALID_ACTOR_USER_ID",
      "INVALID_TEAM_CONTEXT",
      "IDEMPOTENCY_KEY_CONFLICT",
      "SERVICE_ORDER_NOT_FOUND",
      "SERVICE_ORDER_NOT_CONFIRMABLE",
      "SERVICE_ORDER_ALREADY_CONFIRMED",
      "ACTOR_NOT_AUTHORIZED"
    ]).has(value)
  );
}
