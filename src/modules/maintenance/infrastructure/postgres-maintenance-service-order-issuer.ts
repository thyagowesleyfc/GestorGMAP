import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  IssueMaintenanceServiceOrderCommand,
  IssueMaintenanceServiceOrderFailureReason,
  IssueMaintenanceServiceOrderResult,
  MaintenanceServiceOrderIssuer
} from "../application/issue-maintenance-service-order";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: IssueMaintenanceServiceOrderResult }
  | { kind: "CONFLICT" };

type MaintenanceRequestRow = {
  id: string;
  requesting_entity_id: string;
  status: string;
  authorized_at: Date | null;
  authorized_by_user_id: string | null;
  authorization_reason: string | null;
};

type ContractRow = {
  id: string;
  active: boolean;
  validity_start: Date;
  validity_end: Date;
};

type TargetRow = {
  patrimony_id: string;
  gre_code: string;
  strategy_type: string | null;
  strategy_contract_id: string | null;
};

const ISSUE_MAINTENANCE_SERVICE_ORDER_COMMAND = "maintenance.issue_service_order";
const MAINTENANCE_SERVICE_ORDER_ISSUED_EVENT = "maintenance.service_order_issued";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio"];

export class PostgresMaintenanceServiceOrderIssuer implements MaintenanceServiceOrderIssuer {
  constructor(private readonly pool: Pool) {}

  async issue(
    input: IssueMaintenanceServiceOrderCommand
  ): Promise<IssueMaintenanceServiceOrderResult> {
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

      const result = await this.issueInTransaction(client, input);
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
    input: IssueMaintenanceServiceOrderCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashIssueServiceOrderCommand(input);
    const idempotencyId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, ISSUE_MAINTENANCE_SERVICE_ORDER_COMMAND, input.commandId, requestHash]
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
      [ISSUE_MAINTENANCE_SERVICE_ORDER_COMMAND, input.commandId]
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
    result: IssueMaintenanceServiceOrderResult
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

  private async issueInTransaction(
    client: PoolClient,
    input: IssueMaintenanceServiceOrderCommand
  ): Promise<IssueMaintenanceServiceOrderResult> {
    const request = await client.query<MaintenanceRequestRow>(
      `select "id", "requesting_entity_id", "status"::text as "status",
              "authorized_at", "authorized_by_user_id", "authorization_reason"
         from "maintenance_request"
        where "id" = $1
        for update`,
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
    if (
      requestRow.status !== "EM_ANALISE" ||
      requestRow.authorized_at === null ||
      requestRow.authorized_by_user_id === null ||
      requestRow.authorization_reason === null
    ) {
      return {
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
        maintenanceRequestId: input.maintenanceRequestId
      };
    }
    if (requestRow.requesting_entity_id !== input.entityId) {
      return { ok: false, reason: "ENTITY_NOT_REQUESTING_ENTITY", entityId: input.entityId };
    }

    const contract = await client.query<ContractRow>(
      `select "id", "active", "validity_start", "validity_end"
         from "contract"
        where "id" = $1
        for share`,
      [input.contractId]
    );
    const contractRow = contract.rows[0];

    if (contractRow === undefined) {
      return { ok: false, reason: "CONTRACT_NOT_FOUND", contractId: input.contractId };
    }

    const issuedDate = input.issuedAt.toISOString().slice(0, 10);
    if (
      !contractRow.active ||
      issuedDate < contractRow.validity_start.toISOString().slice(0, 10) ||
      issuedDate > contractRow.validity_end.toISOString().slice(0, 10)
    ) {
      return { ok: false, reason: "CONTRACT_NOT_APPLICABLE", contractId: input.contractId };
    }

    const targetRows = await client.query<TargetRow>(
      `select t."patrimony_id",
              g."code" as "gre_code",
              s."strategy_type"::text as "strategy_type",
              s."contract_id" as "strategy_contract_id"
         from "maintenance_request_patrimony_target" t
         join "patrimony" p on p."id" = t."patrimony_id"
         join "entity" e on e."id" = p."responsible_entity_id"
         join "gre" g on g."id" = e."gre_id"
         left join "maintenance_request_patrimony_strategy" s
           on s."maintenance_request_id" = t."maintenance_request_id"
          and s."patrimony_id" = t."patrimony_id"
        where t."maintenance_request_id" = $1
          and t."patrimony_id" = any($2::uuid[])
        for share of t, p`,
      [input.maintenanceRequestId, input.patrimonyIds]
    );
    const targetByPatrimonyId = new Map(
      targetRows.rows.map((target) => [target.patrimony_id, target])
    );

    for (const patrimonyId of input.patrimonyIds) {
      const target = targetByPatrimonyId.get(patrimonyId);
      if (target === undefined) {
        return {
          ok: false,
          reason: "PATRIMONY_TARGET_NOT_LINKED",
          patrimonyId
        };
      }
      if (target.strategy_type === null) {
        return { ok: false, reason: "PATRIMONY_STRATEGY_NOT_DEFINED", patrimonyId };
      }
      if (
        target.strategy_type !== "CONTRATO_SERVICO" ||
        target.strategy_contract_id !== input.contractId
      ) {
        return { ok: false, reason: "PATRIMONY_STRATEGY_CONTRACT_MISMATCH", patrimonyId };
      }
      if (!(await this.isAuthorized(client, input.actorUserId, target.gre_code))) {
        return { ok: false, reason: "ACTOR_NOT_AUTHORIZED", patrimonyId };
      }
    }

    const existingCode = await client.query<{ id: string }>(
      `select "id"
         from "maintenance_service_order"
        where "code" = $1
        for share`,
      [input.code]
    );
    if (existingCode.rows.length > 0) {
      return { ok: false, reason: "SERVICE_ORDER_CODE_CONFLICT" };
    }

    const serviceOrderId = randomUUID();
    await client.query(
      `insert into "maintenance_service_order" (
        "id", "code", "maintenance_request_id", "contract_id", "entity_id", "status",
        "issued_at", "issued_by_user_id", "correlation_id", "updated_at"
      ) values ($1, $2, $3, $4, $5, 'EMITIDA', $6, $7, $8, current_timestamp)`,
      [
        serviceOrderId,
        input.code,
        input.maintenanceRequestId,
        input.contractId,
        input.entityId,
        input.issuedAt,
        input.actorUserId,
        input.correlationId
      ]
    );

    for (const patrimonyId of input.patrimonyIds) {
      await client.query(
        `insert into "maintenance_service_order_patrimony" (
          "id", "service_order_id", "maintenance_request_id", "patrimony_id"
        ) values ($1, $2, $3, $4)`,
        [randomUUID(), serviceOrderId, input.maintenanceRequestId, patrimonyId]
      );
    }

    for (const [index, service] of input.services.entries()) {
      await client.query(
        `insert into "maintenance_service_order_service" (
          "id", "service_order_id", "line_number", "description", "updated_at"
        ) values ($1, $2, $3, $4, current_timestamp)`,
        [randomUUID(), serviceOrderId, index + 1, service.description]
      );
    }

    await client.query(
      `update "maintenance_request"
          set "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.maintenanceRequestId]
    );

    const nextValue = {
      serviceOrderId,
      code: input.code,
      maintenanceRequestId: input.maintenanceRequestId,
      contractId: input.contractId,
      entityId: input.entityId,
      status: "EMITIDA",
      issuedAt: input.issuedAt,
      issuedByUserId: input.actorUserId,
      patrimonyIds: input.patrimonyIds,
      services: input.services,
      correlationId: input.correlationId
    };
    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        randomUUID(),
        input.issuedAt,
        input.actorUserId,
        input.teamContext,
        ISSUE_MAINTENANCE_SERVICE_ORDER_COMMAND,
        "maintenance_service_order",
        serviceOrderId,
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
        MAINTENANCE_SERVICE_ORDER_ISSUED_EVENT,
        "maintenance_service_order",
        serviceOrderId,
        JSON.stringify(nextValue)
      ]
    );

    return {
      ok: true,
      serviceOrderId,
      code: input.code,
      maintenanceRequestId: input.maintenanceRequestId,
      contractId: input.contractId,
      entityId: input.entityId,
      patrimonyIds: input.patrimonyIds,
      serviceCount: input.services.length,
      status: "EMITIDA"
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

function hashIssueServiceOrderCommand(input: IssueMaintenanceServiceOrderCommand): string {
  const payload = {
    code: input.code,
    maintenanceRequestId: input.maintenanceRequestId,
    contractId: input.contractId,
    entityId: input.entityId,
    patrimonyIds: input.patrimonyIds,
    services: input.services,
    issuedAt: input.issuedAt.toISOString(),
    actorUserId: input.actorUserId
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): IssueMaintenanceServiceOrderResult {
  if (isIssueServiceOrderResult(value)) {
    return value;
  }
  throw new Error("Stored service order idempotency result is invalid.");
}

function isIssueServiceOrderResult(value: unknown): value is IssueMaintenanceServiceOrderResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  if (value.ok === true) {
    const result = value as {
      serviceOrderId?: unknown;
      code?: unknown;
      maintenanceRequestId?: unknown;
      contractId?: unknown;
      entityId?: unknown;
      patrimonyIds?: unknown;
      serviceCount?: unknown;
      status?: unknown;
    };
    return (
      typeof result.serviceOrderId === "string" &&
      typeof result.code === "string" &&
      typeof result.maintenanceRequestId === "string" &&
      typeof result.contractId === "string" &&
      typeof result.entityId === "string" &&
      Array.isArray(result.patrimonyIds) &&
      result.patrimonyIds.every((patrimonyId) => typeof patrimonyId === "string") &&
      typeof result.serviceCount === "number" &&
      result.status === "EMITIDA"
    );
  }

  return isFailureReason((value as { reason?: unknown }).reason);
}

function isFailureReason(value: unknown): value is IssueMaintenanceServiceOrderFailureReason {
  return (
    typeof value === "string" &&
    new Set([
      "INVALID_COMMAND_ID",
      "INVALID_CODE",
      "INVALID_MAINTENANCE_REQUEST_ID",
      "INVALID_CONTRACT_ID",
      "INVALID_ENTITY_ID",
      "INVALID_PATRIMONY_ID",
      "EMPTY_PATRIMONY_TARGETS",
      "DUPLICATE_PATRIMONY_TARGET",
      "EMPTY_SERVICES",
      "INVALID_SERVICE_DESCRIPTION",
      "INVALID_ISSUED_AT",
      "INVALID_ACTOR_USER_ID",
      "INVALID_TEAM_CONTEXT",
      "IDEMPOTENCY_KEY_CONFLICT",
      "SERVICE_ORDER_CODE_CONFLICT",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
      "ENTITY_NOT_REQUESTING_ENTITY",
      "CONTRACT_NOT_FOUND",
      "CONTRACT_NOT_APPLICABLE",
      "PATRIMONY_TARGET_NOT_LINKED",
      "PATRIMONY_STRATEGY_NOT_DEFINED",
      "PATRIMONY_STRATEGY_CONTRACT_MISMATCH",
      "ACTOR_NOT_AUTHORIZED"
    ]).has(value)
  );
}
