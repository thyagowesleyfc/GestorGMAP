import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  LinkMaintenanceRequestPatrimonyTargetsCommand,
  LinkMaintenanceRequestPatrimonyTargetsFailureReason,
  LinkMaintenanceRequestPatrimonyTargetsResult,
  MaintenanceRequestPatrimonyTargetLinker
} from "../application/link-maintenance-request-patrimony-targets";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: LinkMaintenanceRequestPatrimonyTargetsResult }
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
  version: number;
};

type PatrimonyRow = {
  id: string;
  gre_code: string;
};

const LINK_MAINTENANCE_REQUEST_PATRIMONY_TARGETS_COMMAND = "maintenance.link_patrimony_targets";
const MAINTENANCE_REQUEST_PATRIMONY_TARGETS_LINKED_EVENT =
  "maintenance.request_patrimony_targets_linked";
const AUTHORIZED_TEAM_NAMES = ["Patrim\u00f4nio"];

export class PostgresMaintenanceRequestPatrimonyTargetLinker implements MaintenanceRequestPatrimonyTargetLinker {
  constructor(private readonly pool: Pool) {}

  async link(
    input: LinkMaintenanceRequestPatrimonyTargetsCommand
  ): Promise<LinkMaintenanceRequestPatrimonyTargetsResult> {
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

      const result = await this.linkInTransaction(client, input);
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
    input: LinkMaintenanceRequestPatrimonyTargetsCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashLinkMaintenanceRequestPatrimonyTargetsCommand(input);
    const idempotencyId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [
        idempotencyId,
        LINK_MAINTENANCE_REQUEST_PATRIMONY_TARGETS_COMMAND,
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
      [LINK_MAINTENANCE_REQUEST_PATRIMONY_TARGETS_COMMAND, input.commandId]
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
    result: LinkMaintenanceRequestPatrimonyTargetsResult
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

  private async linkInTransaction(
    client: PoolClient,
    input: LinkMaintenanceRequestPatrimonyTargetsCommand
  ): Promise<LinkMaintenanceRequestPatrimonyTargetsResult> {
    const request = await client.query<MaintenanceRequestRow>(
      `select "id", "status"::text as "status", "version"
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

    if (requestRow.status !== "EM_ANALISE") {
      return {
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
        maintenanceRequestId: input.maintenanceRequestId
      };
    }

    const patrimonies = await client.query<PatrimonyRow>(
      `select p."id", g."code" as "gre_code"
         from "patrimony" p
         join "entity" e on e."id" = p."responsible_entity_id"
         join "gre" g on g."id" = e."gre_id"
        where p."id" = any($1::uuid[])
        for share of p`,
      [input.patrimonyIds]
    );
    const patrimonyById = new Map(patrimonies.rows.map((patrimony) => [patrimony.id, patrimony]));
    const missingPatrimonyId = input.patrimonyIds.find(
      (patrimonyId) => !patrimonyById.has(patrimonyId)
    );

    if (missingPatrimonyId !== undefined) {
      return {
        ok: false,
        reason: "PATRIMONY_NOT_FOUND",
        patrimonyId: missingPatrimonyId
      };
    }

    if (!(await this.isAuthorized(client, input.actorUserId, input.patrimonyIds))) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED" };
    }

    const linked = await client.query<{ patrimony_id: string }>(
      `select "patrimony_id"
         from "maintenance_request_patrimony_target"
        where "maintenance_request_id" = $1
        for update`,
      [input.maintenanceRequestId]
    );
    const linkedPatrimonyIds = linked.rows.map((row) => row.patrimony_id);
    const linkedPatrimonyIdSet = new Set(linkedPatrimonyIds);
    const alreadyLinkedPatrimonyId = input.patrimonyIds.find((patrimonyId) =>
      linkedPatrimonyIdSet.has(patrimonyId)
    );

    if (alreadyLinkedPatrimonyId !== undefined) {
      return {
        ok: false,
        reason: "PATRIMONY_ALREADY_LINKED",
        patrimonyId: alreadyLinkedPatrimonyId
      };
    }

    for (const patrimonyId of input.patrimonyIds) {
      await client.query(
        `insert into "maintenance_request_patrimony_target" (
          "id", "maintenance_request_id", "patrimony_id", "linked_at", "linked_by_user_id",
          "correlation_id", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
        [
          randomUUID(),
          input.maintenanceRequestId,
          patrimonyId,
          input.linkedAt,
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

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        randomUUID(),
        input.linkedAt,
        input.actorUserId,
        input.teamContext,
        LINK_MAINTENANCE_REQUEST_PATRIMONY_TARGETS_COMMAND,
        "maintenance_request",
        input.maintenanceRequestId,
        JSON.stringify({
          status: requestRow.status,
          version: requestRow.version,
          patrimonyIds: linkedPatrimonyIds
        }),
        JSON.stringify({
          status: requestRow.status,
          version: requestRow.version + 1,
          patrimonyIds: [...linkedPatrimonyIds, ...input.patrimonyIds]
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
        MAINTENANCE_REQUEST_PATRIMONY_TARGETS_LINKED_EVENT,
        "maintenance_request",
        input.maintenanceRequestId,
        JSON.stringify({
          maintenanceRequestId: input.maintenanceRequestId,
          status: requestRow.status,
          patrimonyIds: input.patrimonyIds,
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      maintenanceRequestId: input.maintenanceRequestId,
      status: "EM_ANALISE",
      linkedPatrimonyIds: input.patrimonyIds,
      linkedCount: input.patrimonyIds.length
    };
  }

  private async isAuthorized(
    client: PoolClient,
    actorUserId: string,
    patrimonyIds: string[]
  ): Promise<boolean> {
    const authorization = await client.query<{ authorized_count: number }>(
      `select count(*)::int as "authorized_count"
         from "patrimony" p
         join "entity" e on e."id" = p."responsible_entity_id"
         join "gre" g on g."id" = e."gre_id"
        where p."id" = any($2::uuid[])
          and exists(
            select 1
              from "user_account" u
              join "team_membership" tm on tm."user_id" = u."id"
              join "team" t on t."id" = tm."team_id"
             where u."id" = $1
               and u."status" = 'ACTIVE'
               and tm."active" = true
               and t."name" = any($3::varchar[])
               and (
                 tm."scope_type" = 'GLOBAL'
                 or (tm."scope_type" = 'GRE' and tm."gre_code" = g."code")
               )
          )`,
      [actorUserId, patrimonyIds, AUTHORIZED_TEAM_NAMES]
    );

    return authorization.rows[0]?.authorized_count === patrimonyIds.length;
  }
}

function hashLinkMaintenanceRequestPatrimonyTargetsCommand(
  input: LinkMaintenanceRequestPatrimonyTargetsCommand
): string {
  const payload = {
    maintenanceRequestId: input.maintenanceRequestId,
    patrimonyIds: [...input.patrimonyIds].sort(),
    actorUserId: input.actorUserId
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): LinkMaintenanceRequestPatrimonyTargetsResult {
  if (isLinkMaintenanceRequestPatrimonyTargetsResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isLinkMaintenanceRequestPatrimonyTargetsResult(
  value: unknown
): value is LinkMaintenanceRequestPatrimonyTargetsResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { maintenanceRequestId?: unknown }).maintenanceRequestId === "string" &&
      (value as { status?: unknown }).status === "EM_ANALISE" &&
      Array.isArray((value as { linkedPatrimonyIds?: unknown }).linkedPatrimonyIds) &&
      typeof (value as { linkedCount?: unknown }).linkedCount === "number"
    );
  }

  return isLinkMaintenanceRequestPatrimonyTargetsFailureReason(
    (value as { reason?: unknown }).reason
  );
}

function isLinkMaintenanceRequestPatrimonyTargetsFailureReason(
  value: unknown
): value is LinkMaintenanceRequestPatrimonyTargetsFailureReason {
  return (
    typeof value === "string" &&
    new Set([
      "INVALID_COMMAND_ID",
      "INVALID_MAINTENANCE_REQUEST_ID",
      "EMPTY_PATRIMONY_TARGETS",
      "INVALID_PATRIMONY_ID",
      "DUPLICATE_PATRIMONY_TARGET",
      "INVALID_LINKED_AT",
      "INVALID_ACTOR_USER_ID",
      "INVALID_TEAM_CONTEXT",
      "IDEMPOTENCY_KEY_CONFLICT",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
      "PATRIMONY_NOT_FOUND",
      "PATRIMONY_ALREADY_LINKED",
      "ACTOR_NOT_AUTHORIZED"
    ]).has(value)
  );
}
