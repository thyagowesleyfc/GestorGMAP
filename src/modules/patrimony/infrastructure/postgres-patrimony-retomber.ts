import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import { allocateTomboSequenceInTransaction } from "./postgres-tombo-sequence-allocator";
import type {
  PatrimonyRetomber,
  RetombarPatrimonyCommand,
  RetombarPatrimonyResult
} from "../application/retombar-patrimony";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RetombarPatrimonyResult }
  | { kind: "CONFLICT" };

type PatrimonyRow = {
  id: string;
  is_tombable: boolean;
  gre_code: string;
};

type ActiveTomboRow = {
  id: string;
  tombo: string;
  patrimonial_group_code: string;
  issued_at: Date;
};

const RETOMBAR_PATRIMONY_COMMAND = "patrimony.retombar";
const PATRIMONY_RETOMBED_EVENT = "patrimony.retombed";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio", "Gerência"];

export class PostgresPatrimonyRetomber implements PatrimonyRetomber {
  constructor(private readonly pool: Pool) {}

  async retombar(input: RetombarPatrimonyCommand): Promise<RetombarPatrimonyResult> {
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

      const result = await this.retombarInTransaction(client, input);
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
    input: RetombarPatrimonyCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashRetombarCommand(input);
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [randomUUID(), RETOMBAR_PATRIMONY_COMMAND, input.commandId, requestHash]
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
      [RETOMBAR_PATRIMONY_COMMAND, input.commandId]
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
    result: RetombarPatrimonyResult
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

  private async retombarInTransaction(
    client: PoolClient,
    input: RetombarPatrimonyCommand
  ): Promise<RetombarPatrimonyResult> {
    const patrimonyResult = await client.query<PatrimonyRow>(
      `select p."id", ms."is_tombable", g."code" as "gre_code"
         from "patrimony" p
         join "material_singular" ms on ms."id" = p."material_singular_id"
         join "entity" e on e."id" = p."responsible_entity_id"
         join "gre" g on g."id" = e."gre_id"
        where p."id" = $1
        for update of p`,
      [input.patrimonyId]
    );
    const patrimony = patrimonyResult.rows[0];

    if (patrimony === undefined) {
      return { ok: false, reason: "PATRIMONY_NOT_FOUND", patrimonyId: input.patrimonyId };
    }

    if (!(await this.isAuthorized(client, input.actorUserId, patrimony.gre_code))) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED", patrimonyId: input.patrimonyId };
    }

    if (!patrimony.is_tombable) {
      return { ok: false, reason: "PATRIMONY_NOT_TOMBABLE", patrimonyId: input.patrimonyId };
    }

    const activeTomboResult = await client.query<ActiveTomboRow>(
      `select "id", "tombo", "patrimonial_group_code", "issued_at"
         from "patrimony_tombo"
        where "patrimony_id" = $1
          and "status" = 'ATIVO'
          and "retired_at" is null
        for update`,
      [input.patrimonyId]
    );
    const activeTombo = activeTomboResult.rows[0];

    if (activeTombo === undefined) {
      return { ok: false, reason: "ACTIVE_TOMBO_NOT_FOUND", patrimonyId: input.patrimonyId };
    }

    if (!/^[0-9]{2}$/.test(activeTombo.patrimonial_group_code)) {
      return {
        ok: false,
        reason: "PATRIMONIAL_GROUP_INVALID",
        patrimonyId: input.patrimonyId
      };
    }

    if (input.retombedAt.getTime() < activeTombo.issued_at.getTime()) {
      return {
        ok: false,
        reason: "RETOMBED_AT_BEFORE_ISSUED_AT",
        patrimonyId: input.patrimonyId
      };
    }

    const allocation = await allocateTomboSequenceInTransaction(client, {
      patrimonialGroupCode: activeTombo.patrimonial_group_code
    });

    await client.query(
      `update "patrimony_tombo"
          set "status" = 'ENCERRADO',
              "retired_at" = $2,
              "retirement_reason" = $3,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [activeTombo.id, input.retombedAt, input.reason]
    );

    await client.query(
      `insert into "patrimony_tombo" (
        "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
      ) values ($1, $2, $3, $4, $5, current_timestamp)`,
      [
        randomUUID(),
        input.patrimonyId,
        allocation.tombo,
        allocation.patrimonialGroupCode,
        input.retombedAt
      ]
    );

    await client.query(
      `update "patrimony"
          set "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.patrimonyId]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.retombedAt,
        input.actorUserId,
        input.teamContext,
        RETOMBAR_PATRIMONY_COMMAND,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          tombo: activeTombo.tombo,
          status: "ATIVO",
          issuedAt: activeTombo.issued_at.toISOString(),
          patrimonialGroupCode: activeTombo.patrimonial_group_code
        }),
        JSON.stringify({
          tombo: allocation.tombo,
          status: "ATIVO",
          issuedAt: input.retombedAt.toISOString(),
          patrimonialGroupCode: allocation.patrimonialGroupCode
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
        PATRIMONY_RETOMBED_EVENT,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          patrimonyId: input.patrimonyId,
          previousTombo: activeTombo.tombo,
          tombo: allocation.tombo,
          patrimonialGroupCode: allocation.patrimonialGroupCode,
          retombedAt: input.retombedAt.toISOString(),
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      patrimonyId: input.patrimonyId,
      previousTombo: activeTombo.tombo,
      tombo: allocation.tombo,
      patrimonialGroupCode: allocation.patrimonialGroupCode
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
            and (tm."scope_type" = 'GLOBAL' or (tm."scope_type" = 'GRE' and tm."gre_code" = $3))
       ) as "authorized"`,
      [actorUserId, AUTHORIZED_TEAM_NAMES, greCode]
    );

    return authorization.rows[0]?.authorized === true;
  }
}

function hashRetombarCommand(input: RetombarPatrimonyCommand): string {
  const payload = {
    patrimonyId: input.patrimonyId,
    retombedAt: input.retombedAtWasProvided ? input.retombedAt.toISOString() : null,
    reason: input.reason,
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RetombarPatrimonyResult {
  if (isRetombarPatrimonyResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isRetombarPatrimonyResult(value: unknown): value is RetombarPatrimonyResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { patrimonyId?: unknown }).patrimonyId === "string" &&
      typeof (value as { previousTombo?: unknown }).previousTombo === "string" &&
      typeof (value as { tombo?: unknown }).tombo === "string" &&
      typeof (value as { patrimonialGroupCode?: unknown }).patrimonialGroupCode === "string"
    );
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
