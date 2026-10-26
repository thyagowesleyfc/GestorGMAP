import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  PatrimonyRecolhedor,
  RecolherPatrimonyCommand,
  RecolherPatrimonyResult
} from "../application/recolher-patrimony";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RecolherPatrimonyResult }
  | { kind: "CONFLICT" };

type PatrimonyRow = {
  id: string;
  responsible_entity_id: string;
  responsible_entity_code: string;
  source_gre_code: string;
};

type RecollectionRow = {
  id: string;
  status: "SOLICITADA" | "AUTORIZADA" | "EXECUTADA" | "CANCELADA";
  executed_at: Date | null;
  requesting_entity_id: string;
  receiving_entity_id: string;
  receiving_entity_code: string;
  receiving_entity_active: boolean;
  source_gre_code: string;
  destination_gre_code: string;
};

const RECOLHER_PATRIMONY_COMMAND = "patrimony.recolher";
const PATRIMONY_RECOLHIDO_EVENT = "patrimony.recolhido";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio", "Gerência"];

export class PostgresPatrimonyRecolhedor implements PatrimonyRecolhedor {
  constructor(private readonly pool: Pool) {}

  async recolher(input: RecolherPatrimonyCommand): Promise<RecolherPatrimonyResult> {
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

      const result = await this.recolherInTransaction(client, input);
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
    input: RecolherPatrimonyCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashRecolherCommand(input);
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [randomUUID(), RECOLHER_PATRIMONY_COMMAND, input.commandId, requestHash]
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
      [RECOLHER_PATRIMONY_COMMAND, input.commandId]
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
    result: RecolherPatrimonyResult
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

  private async recolherInTransaction(
    client: PoolClient,
    input: RecolherPatrimonyCommand
  ): Promise<RecolherPatrimonyResult> {
    const patrimonyResult = await client.query<PatrimonyRow>(
      `select p."id",
              p."responsible_entity_id",
              source."code" as "responsible_entity_code",
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

    const recollectionResult = await client.query<RecollectionRow>(
      `select r."id",
              r."status"::text as "status",
              r."executed_at",
              r."requesting_entity_id",
              r."receiving_entity_id",
              receiving."code" as "receiving_entity_code",
              receiving."active" as "receiving_entity_active",
              source_gre."code" as "source_gre_code",
              destination_gre."code" as "destination_gre_code"
         from "logistics_recollection" r
         join "entity" requesting on requesting."id" = r."requesting_entity_id"
         join "entity" receiving on receiving."id" = r."receiving_entity_id"
         join "gre" source_gre on source_gre."id" = requesting."gre_id"
         join "gre" destination_gre on destination_gre."id" = receiving."gre_id"
        where r."id" = $1
        for update of r`,
      [input.logisticsRecollectionId]
    );
    const recollection = recollectionResult.rows[0];

    if (recollection === undefined) {
      return {
        ok: false,
        reason: "LOGISTICS_RECOLLECTION_NOT_FOUND",
        patrimonyId: input.patrimonyId,
        recollectionId: input.logisticsRecollectionId
      };
    }

    if (recollection.status !== "EXECUTADA" || recollection.executed_at === null) {
      return {
        ok: false,
        reason: "LOGISTICS_RECOLLECTION_NOT_EXECUTED",
        patrimonyId: input.patrimonyId,
        recollectionId: input.logisticsRecollectionId
      };
    }

    const existingMovement = await client.query<{ exists: boolean }>(
      `select exists(
         select 1
           from "patrimony_movement"
          where "patrimony_id" = $1
            and "logistics_recollection_id" = $2
       ) as "exists"`,
      [input.patrimonyId, input.logisticsRecollectionId]
    );
    if (existingMovement.rows[0]?.exists === true) {
      return {
        ok: false,
        reason: "PATRIMONY_RECOLLECTION_ALREADY_REGISTERED",
        patrimonyId: input.patrimonyId,
        recollectionId: input.logisticsRecollectionId
      };
    }

    if (recollection.requesting_entity_id !== patrimony.responsible_entity_id) {
      return {
        ok: false,
        reason: "RECOLLECTION_SOURCE_MISMATCH",
        patrimonyId: input.patrimonyId,
        recollectionId: input.logisticsRecollectionId
      };
    }

    if (input.occurredAt < recollection.executed_at) {
      return {
        ok: false,
        reason: "RECOLLECTION_DATE_BEFORE_EXECUTION",
        patrimonyId: input.patrimonyId,
        recollectionId: input.logisticsRecollectionId
      };
    }

    if (!recollection.receiving_entity_active) {
      return {
        ok: false,
        reason: "DESTINATION_ENTITY_NOT_ACTIVE",
        patrimonyId: input.patrimonyId,
        recollectionId: input.logisticsRecollectionId
      };
    }

    if (recollection.receiving_entity_id === patrimony.responsible_entity_id) {
      return {
        ok: false,
        reason: "SAME_RESPONSIBLE_ENTITY",
        patrimonyId: input.patrimonyId,
        recollectionId: input.logisticsRecollectionId
      };
    }

    if (
      !(await this.isAuthorized(
        client,
        input.actorUserId,
        recollection.source_gre_code,
        recollection.destination_gre_code
      ))
    ) {
      return {
        ok: false,
        reason: "ACTOR_NOT_AUTHORIZED",
        patrimonyId: input.patrimonyId,
        recollectionId: input.logisticsRecollectionId
      };
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
        patrimonyId: input.patrimonyId,
        recollectionId: input.logisticsRecollectionId
      };
    }

    const movementId = randomUUID();
    await client.query(
      `update "patrimony"
          set "responsible_entity_id" = $2,
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.patrimonyId, recollection.receiving_entity_id]
    );

    await client.query(
      `insert into "patrimony_movement" (
        "id", "patrimony_id", "movement_type", "from_entity_id", "to_entity_id",
        "logistics_recollection_id", "occurred_at", "reason", "correlation_id"
      ) values ($1, $2, 'RECOLHA', $3, $4, $5, $6, $7, $8)`,
      [
        movementId,
        input.patrimonyId,
        patrimony.responsible_entity_id,
        recollection.receiving_entity_id,
        input.logisticsRecollectionId,
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
        RECOLHER_PATRIMONY_COMMAND,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          responsibleEntityId: patrimony.responsible_entity_id,
          responsibleEntityCode: patrimony.responsible_entity_code
        }),
        JSON.stringify({
          responsibleEntityId: recollection.receiving_entity_id,
          responsibleEntityCode: recollection.receiving_entity_code,
          logisticsRecollectionId: input.logisticsRecollectionId
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
        PATRIMONY_RECOLHIDO_EVENT,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          movementId,
          patrimonyId: input.patrimonyId,
          recollectionId: input.logisticsRecollectionId,
          fromEntityId: patrimony.responsible_entity_id,
          toEntityId: recollection.receiving_entity_id,
          occurredAt: input.occurredAt.toISOString(),
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      movementId,
      patrimonyId: input.patrimonyId,
      recollectionId: input.logisticsRecollectionId,
      fromEntityId: patrimony.responsible_entity_id,
      toEntityId: recollection.receiving_entity_id
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

function hashRecolherCommand(input: RecolherPatrimonyCommand): string {
  const payload = {
    patrimonyId: input.patrimonyId,
    logisticsRecollectionId: input.logisticsRecollectionId,
    occurredAt: input.occurredAtWasProvided ? input.occurredAt.toISOString() : null,
    reason: input.reason,
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RecolherPatrimonyResult {
  if (isRecolherPatrimonyResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isRecolherPatrimonyResult(value: unknown): value is RecolherPatrimonyResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { movementId?: unknown }).movementId === "string" &&
      typeof (value as { patrimonyId?: unknown }).patrimonyId === "string" &&
      typeof (value as { recollectionId?: unknown }).recollectionId === "string" &&
      typeof (value as { fromEntityId?: unknown }).fromEntityId === "string" &&
      typeof (value as { toEntityId?: unknown }).toEntityId === "string"
    );
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
