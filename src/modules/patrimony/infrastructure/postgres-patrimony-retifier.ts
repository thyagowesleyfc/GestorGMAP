import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  PatrimonyRetifier,
  RetificarPatrimonyCommand,
  RetificarPatrimonyResult
} from "../application/retificar-patrimony";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RetificarPatrimonyResult }
  | { kind: "CONFLICT" };

type PatrimonyRow = {
  id: string;
  material_singular_id: string;
  material_code: string;
  material_name: string;
  gre_code: string;
};

type MaterialRow = {
  id: string;
  code: string;
  name: string;
  is_tombable: boolean;
  patrimonial_group_code: string | null;
  active: boolean;
};

type ActiveTomboRow = {
  tombo: string;
  patrimonial_group_code: string;
};

const RETIFICAR_PATRIMONY_COMMAND = "patrimony.retificar";
const PATRIMONY_RECTIFIED_EVENT = "patrimony.rectified";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio", "Gerência"];

export class PostgresPatrimonyRetifier implements PatrimonyRetifier {
  constructor(private readonly pool: Pool) {}

  async retificar(input: RetificarPatrimonyCommand): Promise<RetificarPatrimonyResult> {
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

      const result = await this.retificarInTransaction(client, input);
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
    input: RetificarPatrimonyCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashRetificarCommand(input);
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [randomUUID(), RETIFICAR_PATRIMONY_COMMAND, input.commandId, requestHash]
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
      [RETIFICAR_PATRIMONY_COMMAND, input.commandId]
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
    result: RetificarPatrimonyResult
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

  private async retificarInTransaction(
    client: PoolClient,
    input: RetificarPatrimonyCommand
  ): Promise<RetificarPatrimonyResult> {
    const patrimonyResult = await client.query<PatrimonyRow>(
      `select p."id",
              p."material_singular_id",
              ms."code" as "material_code",
              ms."name" as "material_name",
              g."code" as "gre_code"
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

    if (patrimony.material_singular_id === input.correctedMaterialSingularId) {
      return { ok: false, reason: "NO_CHANGES", patrimonyId: input.patrimonyId };
    }

    const materialResult = await client.query<MaterialRow>(
      `select "id", "code", "name", "is_tombable", "patrimonial_group_code", "active"
         from "material_singular"
        where "id" = $1
        for share`,
      [input.correctedMaterialSingularId]
    );
    const correctedMaterial = materialResult.rows[0];

    if (correctedMaterial === undefined) {
      return { ok: false, reason: "MATERIAL_SINGULAR_NOT_FOUND", patrimonyId: input.patrimonyId };
    }

    if (!correctedMaterial.active) {
      return {
        ok: false,
        reason: "MATERIAL_SINGULAR_NOT_ACTIVE",
        patrimonyId: input.patrimonyId
      };
    }

    const activeTomboResult = await client.query<ActiveTomboRow>(
      `select "tombo", "patrimonial_group_code"
         from "patrimony_tombo"
        where "patrimony_id" = $1
          and "status" = 'ATIVO'
          and "retired_at" is null
        for share`,
      [input.patrimonyId]
    );
    const activeTombo = activeTomboResult.rows[0];

    if (activeTombo !== undefined && !correctedMaterial.is_tombable) {
      return {
        ok: false,
        reason: "TOMBO_INCOMPATIBLE_WITH_MATERIAL",
        patrimonyId: input.patrimonyId
      };
    }

    if (activeTombo === undefined && correctedMaterial.is_tombable) {
      return {
        ok: false,
        reason: "TOMBO_REQUIRED_FOR_TOMBABLE_MATERIAL",
        patrimonyId: input.patrimonyId
      };
    }

    if (
      activeTombo !== undefined &&
      correctedMaterial.patrimonial_group_code !== activeTombo.patrimonial_group_code
    ) {
      return {
        ok: false,
        reason: "PATRIMONIAL_GROUP_MISMATCH",
        patrimonyId: input.patrimonyId
      };
    }

    await client.query(
      `update "patrimony"
          set "material_singular_id" = $2,
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.patrimonyId, correctedMaterial.id]
    );

    const previousValue = {
      materialSingularId: patrimony.material_singular_id,
      materialCode: patrimony.material_code,
      materialName: patrimony.material_name,
      tombo: activeTombo?.tombo ?? null
    };
    const nextValue = {
      materialSingularId: correctedMaterial.id,
      materialCode: correctedMaterial.code,
      materialName: correctedMaterial.name,
      tombo: activeTombo?.tombo ?? null
    };

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.correctedAt,
        input.actorUserId,
        input.teamContext,
        RETIFICAR_PATRIMONY_COMMAND,
        "patrimony",
        input.patrimonyId,
        JSON.stringify(previousValue),
        JSON.stringify(nextValue),
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
        PATRIMONY_RECTIFIED_EVENT,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          patrimonyId: input.patrimonyId,
          previousMaterialSingularId: patrimony.material_singular_id,
          materialSingularId: correctedMaterial.id,
          tombo: activeTombo?.tombo ?? null,
          correctedAt: input.correctedAt.toISOString(),
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      patrimonyId: input.patrimonyId,
      previousMaterialSingularId: patrimony.material_singular_id,
      materialSingularId: correctedMaterial.id,
      tombo: activeTombo?.tombo ?? null
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

function hashRetificarCommand(input: RetificarPatrimonyCommand): string {
  const payload = {
    patrimonyId: input.patrimonyId,
    correctedMaterialSingularId: input.correctedMaterialSingularId,
    correctedAt: input.correctedAtWasProvided ? input.correctedAt.toISOString() : null,
    reason: input.reason,
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RetificarPatrimonyResult {
  if (isRetificarPatrimonyResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isRetificarPatrimonyResult(value: unknown): value is RetificarPatrimonyResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { patrimonyId?: unknown }).patrimonyId === "string" &&
      typeof (value as { previousMaterialSingularId?: unknown }).previousMaterialSingularId ===
        "string" &&
      typeof (value as { materialSingularId?: unknown }).materialSingularId === "string" &&
      ((value as { tombo?: unknown }).tombo === null ||
        typeof (value as { tombo?: unknown }).tombo === "string")
    );
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
