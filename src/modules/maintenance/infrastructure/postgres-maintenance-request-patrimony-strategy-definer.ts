import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  DefineMaintenanceRequestPatrimonyStrategyCommand,
  DefineMaintenanceRequestPatrimonyStrategyFailureReason,
  DefineMaintenanceRequestPatrimonyStrategyResult,
  MaintenanceRequestPatrimonyStrategyDefiner,
  MaintenanceRequestPatrimonyStrategyType
} from "../application/define-maintenance-request-patrimony-strategy";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: DefineMaintenanceRequestPatrimonyStrategyResult }
  | { kind: "CONFLICT" };

type MaintenanceRequestRow = {
  id: string;
  status: string;
  version: number;
  authorized_at: Date | null;
  authorized_by_user_id: string | null;
  authorization_reason: string | null;
};

type LinkedTargetRow = {
  patrimony_id: string;
  gre_code: string;
};

type ExistingStrategyRow = {
  patrimony_id: string;
  strategy_type: MaintenanceRequestPatrimonyStrategyType;
  contract_id: string | null;
  justification: string;
  defined_at: Date;
  defined_by_user_id: string;
  correlation_id: string;
};

type ContractRow = {
  id: string;
  active: boolean;
  validity_start: Date;
  validity_end: Date;
};

const DEFINE_MAINTENANCE_REQUEST_PATRIMONY_STRATEGY_COMMAND =
  "maintenance.define_patrimony_strategy";
const MAINTENANCE_REQUEST_PATRIMONY_STRATEGY_DEFINED_EVENT =
  "maintenance.request_patrimony_strategy_defined";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio"];

export class PostgresMaintenanceRequestPatrimonyStrategyDefiner implements MaintenanceRequestPatrimonyStrategyDefiner {
  constructor(private readonly pool: Pool) {}

  async define(
    input: DefineMaintenanceRequestPatrimonyStrategyCommand
  ): Promise<DefineMaintenanceRequestPatrimonyStrategyResult> {
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

      const result = await this.defineInTransaction(client, input);
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
    input: DefineMaintenanceRequestPatrimonyStrategyCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashDefineStrategyCommand(input);
    const idempotencyId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [
        idempotencyId,
        DEFINE_MAINTENANCE_REQUEST_PATRIMONY_STRATEGY_COMMAND,
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
      [DEFINE_MAINTENANCE_REQUEST_PATRIMONY_STRATEGY_COMMAND, input.commandId]
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
    result: DefineMaintenanceRequestPatrimonyStrategyResult
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

  private async defineInTransaction(
    client: PoolClient,
    input: DefineMaintenanceRequestPatrimonyStrategyCommand
  ): Promise<DefineMaintenanceRequestPatrimonyStrategyResult> {
    const request = await client.query<MaintenanceRequestRow>(
      `select "id", "status"::text as "status", "version",
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

    const targetRows = await client.query<LinkedTargetRow>(
      `select t."patrimony_id", g."code" as "gre_code"
         from "maintenance_request_patrimony_target" t
         join "patrimony" p on p."id" = t."patrimony_id"
         join "entity" e on e."id" = p."responsible_entity_id"
         join "gre" g on g."id" = e."gre_id"
        where t."maintenance_request_id" = $1
          and t."patrimony_id" = any($2::uuid[])
        for share of t, p`,
      [input.maintenanceRequestId, input.targets.map((target) => target.patrimonyId)]
    );
    const linkedTargetIds = new Set(targetRows.rows.map((row) => row.patrimony_id));
    const unlinkedTarget = input.targets.find((target) => !linkedTargetIds.has(target.patrimonyId));
    if (unlinkedTarget !== undefined) {
      return {
        ok: false,
        reason: "PATRIMONY_TARGET_NOT_LINKED",
        patrimonyId: unlinkedTarget.patrimonyId
      };
    }

    if (!(await this.isAuthorized(client, input.actorUserId, targetRows.rows))) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED" };
    }

    const existing = await client.query<ExistingStrategyRow>(
      `select "patrimony_id", "strategy_type"::text as "strategy_type", "contract_id", "justification",
              "defined_at", "defined_by_user_id", "correlation_id"
         from "maintenance_request_patrimony_strategy"
        where "maintenance_request_id" = $1
        for update`,
      [input.maintenanceRequestId]
    );
    const contractIds = input.targets
      .map((target) => target.contractId)
      .filter((contractId): contractId is string => contractId !== undefined);
    const contracts =
      contractIds.length === 0
        ? []
        : (
            await client.query<ContractRow>(
              `select "id", "active", "validity_start", "validity_end"
                 from "contract"
                where "id" = any($1::uuid[])
                for share`,
              [contractIds]
            )
          ).rows;
    const contractById = new Map(contracts.map((contract) => [contract.id, contract]));
    for (const target of input.targets) {
      if (target.contractId === undefined) {
        continue;
      }
      const contract = contractById.get(target.contractId);
      if (contract === undefined) {
        return { ok: false, reason: "CONTRACT_NOT_FOUND", patrimonyId: target.patrimonyId };
      }

      const definedDate = input.definedAt.toISOString().slice(0, 10);
      if (
        !contract.active ||
        definedDate < contract.validity_start.toISOString().slice(0, 10) ||
        definedDate > contract.validity_end.toISOString().slice(0, 10)
      ) {
        return { ok: false, reason: "CONTRACT_NOT_APPLICABLE", patrimonyId: target.patrimonyId };
      }
    }

    const existingByPatrimonyId = new Map(existing.rows.map((row) => [row.patrimony_id, row]));
    const replacedPatrimonyIds: string[] = [];

    for (const target of input.targets) {
      const existingStrategy = existingByPatrimonyId.get(target.patrimonyId);
      if (existingStrategy !== undefined) {
        replacedPatrimonyIds.push(target.patrimonyId);
        await client.query(
          `update "maintenance_request_patrimony_strategy"
              set "strategy_type" = $2,
                  "contract_id" = $3,
                  "justification" = $4,
                  "defined_at" = $5,
                  "defined_by_user_id" = $6,
                  "correlation_id" = $7,
                  "updated_at" = current_timestamp
            where "maintenance_request_id" = $1
              and "patrimony_id" = $8`,
          [
            input.maintenanceRequestId,
            target.strategyType,
            target.contractId ?? null,
            target.justification,
            input.definedAt,
            input.actorUserId,
            input.correlationId,
            target.patrimonyId
          ]
        );
        continue;
      }

      await client.query(
        `insert into "maintenance_request_patrimony_strategy" (
          "id", "maintenance_request_id", "patrimony_id", "strategy_type", "contract_id",
          "justification", "defined_at", "defined_by_user_id", "correlation_id", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, current_timestamp)`,
        [
          randomUUID(),
          input.maintenanceRequestId,
          target.patrimonyId,
          target.strategyType,
          target.contractId ?? null,
          target.justification,
          input.definedAt,
          input.actorUserId,
          input.correlationId
        ]
      );
    }

    await client.query(
      `update "maintenance_request"
          set "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.maintenanceRequestId]
    );

    const inputByPatrimonyId = new Map(input.targets.map((target) => [target.patrimonyId, target]));
    const previousStrategies = existing.rows.map((row) => ({
      patrimonyId: row.patrimony_id,
      strategyType: row.strategy_type,
      contractId: row.contract_id,
      justification: row.justification,
      definedAt: row.defined_at,
      definedByUserId: row.defined_by_user_id,
      correlationId: row.correlation_id
    }));
    const nextStrategies = [
      ...existing.rows
        .filter((row) => !inputByPatrimonyId.has(row.patrimony_id))
        .map((row) => ({
          patrimonyId: row.patrimony_id,
          strategyType: row.strategy_type,
          contractId: row.contract_id,
          justification: row.justification,
          definedAt: row.defined_at,
          definedByUserId: row.defined_by_user_id,
          correlationId: row.correlation_id
        })),
      ...input.targets.map((target) => ({
        patrimonyId: target.patrimonyId,
        strategyType: target.strategyType,
        contractId: target.contractId ?? null,
        justification: target.justification,
        definedAt: input.definedAt,
        definedByUserId: input.actorUserId,
        correlationId: input.correlationId
      }))
    ];
    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        randomUUID(),
        input.definedAt,
        input.actorUserId,
        input.teamContext,
        DEFINE_MAINTENANCE_REQUEST_PATRIMONY_STRATEGY_COMMAND,
        "maintenance_request",
        input.maintenanceRequestId,
        JSON.stringify({
          status: requestRow.status,
          version: requestRow.version,
          strategies: previousStrategies
        }),
        JSON.stringify({
          status: requestRow.status,
          version: requestRow.version + 1,
          strategies: nextStrategies
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
        MAINTENANCE_REQUEST_PATRIMONY_STRATEGY_DEFINED_EVENT,
        "maintenance_request",
        input.maintenanceRequestId,
        JSON.stringify({
          maintenanceRequestId: input.maintenanceRequestId,
          status: requestRow.status,
          strategies: input.targets,
          replacedPatrimonyIds,
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      maintenanceRequestId: input.maintenanceRequestId,
      status: "EM_ANALISE",
      definedPatrimonyIds: input.targets.map((target) => target.patrimonyId),
      definedCount: input.targets.length
    };
  }

  private async isAuthorized(
    client: PoolClient,
    actorUserId: string,
    targets: LinkedTargetRow[]
  ): Promise<boolean> {
    const authorization = await client.query<{ authorized_count: number }>(
      `select count(*)::int as "authorized_count"
         from unnest($3::varchar[]) as requested("gre_code")
        where exists (
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
               or (tm."scope_type" = 'GRE' and tm."gre_code" = requested."gre_code")
             )
        )`,
      [actorUserId, AUTHORIZED_TEAM_NAMES, targets.map((target) => target.gre_code)]
    );

    return authorization.rows[0]?.authorized_count === targets.length;
  }
}

function hashDefineStrategyCommand(
  input: DefineMaintenanceRequestPatrimonyStrategyCommand
): string {
  const payload = {
    maintenanceRequestId: input.maintenanceRequestId,
    targets: [...input.targets].sort((left, right) =>
      left.patrimonyId.localeCompare(right.patrimonyId)
    ),
    actorUserId: input.actorUserId,
    definedAt: input.definedAt.toISOString()
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): DefineMaintenanceRequestPatrimonyStrategyResult {
  if (isDefineStrategyResult(value)) {
    return value;
  }
  throw new Error("Stored idempotency result is invalid.");
}

function isDefineStrategyResult(
  value: unknown
): value is DefineMaintenanceRequestPatrimonyStrategyResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  if (value.ok === true) {
    return (
      typeof (value as { maintenanceRequestId?: unknown }).maintenanceRequestId === "string" &&
      (value as { status?: unknown }).status === "EM_ANALISE" &&
      Array.isArray((value as { definedPatrimonyIds?: unknown }).definedPatrimonyIds) &&
      typeof (value as { definedCount?: unknown }).definedCount === "number"
    );
  }
  return isFailureReason((value as { reason?: unknown }).reason);
}

function isFailureReason(
  value: unknown
): value is DefineMaintenanceRequestPatrimonyStrategyFailureReason {
  return (
    typeof value === "string" &&
    new Set([
      "INVALID_COMMAND_ID",
      "INVALID_MAINTENANCE_REQUEST_ID",
      "EMPTY_STRATEGY_TARGETS",
      "INVALID_PATRIMONY_ID",
      "DUPLICATE_STRATEGY_TARGET",
      "INVALID_STRATEGY",
      "CONTRACT_REQUIRED_FOR_STRATEGY",
      "INVALID_CONTRACT_ID",
      "INVALID_JUSTIFICATION",
      "INVALID_DEFINED_AT",
      "INVALID_ACTOR_USER_ID",
      "INVALID_TEAM_CONTEXT",
      "IDEMPOTENCY_KEY_CONFLICT",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
      "PATRIMONY_TARGET_NOT_LINKED",
      "CONTRACT_NOT_ALLOWED_FOR_STRATEGY",
      "CONTRACT_NOT_FOUND",
      "CONTRACT_NOT_APPLICABLE",
      "ACTOR_NOT_AUTHORIZED"
    ]).has(value)
  );
}
