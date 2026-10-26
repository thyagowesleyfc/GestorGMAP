import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  PatrimonyRemanejador,
  RemanejarPatrimonyCommand,
  RemanejarPatrimonyResult
} from "../application/remanejar-patrimony";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RemanejarPatrimonyResult }
  | { kind: "CONFLICT" };

type PatrimonyRow = {
  id: string;
  responsible_entity_id: string;
  responsible_entity_code: string;
  responsible_entity_name: string;
  source_gre_code: string;
};

type EntityRow = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  gre_code: string;
};

const REMANEJAR_PATRIMONY_COMMAND = "patrimony.remanejar";
const PATRIMONY_REMANEJADO_EVENT = "patrimony.remanejado";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio", "Gerência"];

export class PostgresPatrimonyRemanejador implements PatrimonyRemanejador {
  constructor(private readonly pool: Pool) {}

  async remanejar(input: RemanejarPatrimonyCommand): Promise<RemanejarPatrimonyResult> {
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
        return { ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT", patrimonyId: input.patrimonyId };
      }

      const result = await this.remanejarInTransaction(client, input);
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
    input: RemanejarPatrimonyCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashRemanejarCommand(input);
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [randomUUID(), REMANEJAR_PATRIMONY_COMMAND, input.commandId, requestHash]
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
      [REMANEJAR_PATRIMONY_COMMAND, input.commandId]
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
    result: RemanejarPatrimonyResult
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

  private async remanejarInTransaction(
    client: PoolClient,
    input: RemanejarPatrimonyCommand
  ): Promise<RemanejarPatrimonyResult> {
    const patrimonyResult = await client.query<PatrimonyRow>(
      `select p."id",
              p."responsible_entity_id",
              source."code" as "responsible_entity_code",
              source."name" as "responsible_entity_name",
              source_gre."code" as "source_gre_code"
         from "patrimony" p
         join "entity" source on source."id" = p."responsible_entity_id"
         join "gre" source_gre on source_gre."id" = source."gre_id"
        where p."id" = $1
        for update of p`,
      [input.patrimonyId]
    );
    const patrimony = patrimonyResult.rows[0];

    if (patrimony === undefined) {
      return { ok: false, reason: "PATRIMONY_NOT_FOUND", patrimonyId: input.patrimonyId };
    }

    const destinationResult = await client.query<EntityRow>(
      `select e."id", e."code", e."name", e."active", g."code" as "gre_code"
         from "entity" e
         join "gre" g on g."id" = e."gre_id"
        where e."id" = $1
        for share of e`,
      [input.destinationEntityId]
    );
    const destination = destinationResult.rows[0];

    if (destination === undefined) {
      return {
        ok: false,
        reason: "DESTINATION_ENTITY_NOT_FOUND",
        patrimonyId: input.patrimonyId
      };
    }

    if (!destination.active) {
      return {
        ok: false,
        reason: "DESTINATION_ENTITY_NOT_ACTIVE",
        patrimonyId: input.patrimonyId
      };
    }

    if (destination.id === patrimony.responsible_entity_id) {
      return { ok: false, reason: "SAME_RESPONSIBLE_ENTITY", patrimonyId: input.patrimonyId };
    }

    if (
      !(await this.isAuthorized(
        client,
        input.actorUserId,
        patrimony.source_gre_code,
        destination.gre_code
      ))
    ) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED", patrimonyId: input.patrimonyId };
    }

    const compositionResult = await client.query<{ exists: boolean }>(
      `select exists(
         select 1
           from "patrimony_composition"
          where "patrimony_id" = $1
         union all
         select 1
           from "patrimony_composition_item"
          where "component_patrimony_id" = $1
       ) as "exists"`,
      [input.patrimonyId]
    );
    if (compositionResult.rows[0]?.exists === true) {
      return {
        ok: false,
        reason: "PATRIMONY_COMPOSITION_MOVEMENT_NOT_SUPPORTED",
        patrimonyId: input.patrimonyId
      };
    }

    const movementId = randomUUID();
    await client.query(
      `update "patrimony"
          set "responsible_entity_id" = $2,
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.patrimonyId, destination.id]
    );

    await client.query(
      `insert into "patrimony_movement" (
        "id", "patrimony_id", "movement_type", "from_entity_id", "to_entity_id",
        "occurred_at", "reason", "correlation_id"
      ) values ($1, $2, 'REMANEJAMENTO', $3, $4, $5, $6, $7)`,
      [
        movementId,
        input.patrimonyId,
        patrimony.responsible_entity_id,
        destination.id,
        input.occurredAt,
        input.reason,
        input.correlationId
      ]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.occurredAt,
        input.actorUserId,
        input.teamContext,
        REMANEJAR_PATRIMONY_COMMAND,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          responsibleEntityId: patrimony.responsible_entity_id,
          responsibleEntityCode: patrimony.responsible_entity_code
        }),
        JSON.stringify({
          responsibleEntityId: destination.id,
          responsibleEntityCode: destination.code
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
        PATRIMONY_REMANEJADO_EVENT,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          movementId,
          patrimonyId: input.patrimonyId,
          fromEntityId: patrimony.responsible_entity_id,
          toEntityId: destination.id,
          occurredAt: input.occurredAt.toISOString(),
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      movementId,
      patrimonyId: input.patrimonyId,
      fromEntityId: patrimony.responsible_entity_id,
      toEntityId: destination.id
    };
  }

  private async isAuthorized(
    client: PoolClient,
    actorUserId: string,
    sourceGreCode: string,
    destinationGreCode: string
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
              or (
                tm."scope_type" = 'GRE'
                and tm."gre_code" = $3
                and $3 = $4
              )
            )
       ) as "authorized"`,
      [actorUserId, AUTHORIZED_TEAM_NAMES, sourceGreCode, destinationGreCode]
    );

    return authorization.rows[0]?.authorized === true;
  }
}

function hashRemanejarCommand(input: RemanejarPatrimonyCommand): string {
  const payload = {
    patrimonyId: input.patrimonyId,
    destinationEntityId: input.destinationEntityId,
    occurredAt: input.occurredAtWasProvided ? input.occurredAt.toISOString() : null,
    reason: input.reason,
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RemanejarPatrimonyResult {
  if (isRemanejarPatrimonyResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isRemanejarPatrimonyResult(value: unknown): value is RemanejarPatrimonyResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { movementId?: unknown }).movementId === "string" &&
      typeof (value as { patrimonyId?: unknown }).patrimonyId === "string" &&
      typeof (value as { fromEntityId?: unknown }).fromEntityId === "string" &&
      typeof (value as { toEntityId?: unknown }).toEntityId === "string"
    );
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
