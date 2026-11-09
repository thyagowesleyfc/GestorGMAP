import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  BaixarPatrimonyCommand,
  BaixarPatrimonyResult,
  PatrimonyBaixador
} from "../application/baixar-patrimony";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: BaixarPatrimonyResult }
  | { kind: "CONFLICT" };

type PatrimonyRow = {
  id: string;
  operational_state: "EM_USO" | "RECOLHIDO" | "EM_MANUTENCAO" | "BAIXADO";
  responsible_entity_id: string;
  responsible_entity_code: string;
  source_gre_code: string;
  is_tombable: boolean;
};

type ActiveTomboRow = {
  id: string;
  tombo: string;
  issued_at: Date;
};

const BAIXAR_PATRIMONY_COMMAND = "patrimony.baixar";
const PATRIMONY_BAIXADO_EVENT = "patrimony.baixado";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio", "Gerência"];

export class PostgresPatrimonyBaixador implements PatrimonyBaixador {
  constructor(private readonly pool: Pool) {}

  async baixar(input: BaixarPatrimonyCommand): Promise<BaixarPatrimonyResult> {
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

      const result = await this.baixarInTransaction(client, input);
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
    input: BaixarPatrimonyCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashBaixarCommand(input);
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [randomUUID(), BAIXAR_PATRIMONY_COMMAND, input.commandId, requestHash]
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
      [BAIXAR_PATRIMONY_COMMAND, input.commandId]
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
    result: BaixarPatrimonyResult
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

  private async baixarInTransaction(
    client: PoolClient,
    input: BaixarPatrimonyCommand
  ): Promise<BaixarPatrimonyResult> {
    const patrimonyResult = await client.query<PatrimonyRow>(
      `select p."id",
              p."operational_state"::text as "operational_state",
              p."responsible_entity_id",
              source."code" as "responsible_entity_code",
              source_gre."code" as "source_gre_code",
              material."is_tombable"
         from "patrimony" p
         join "entity" source on source."id" = p."responsible_entity_id"
         join "gre" source_gre on source_gre."id" = source."gre_id"
         join "material_singular" material on material."id" = p."material_singular_id"
        where p."id" = $1
        for update of p`,
      [input.patrimonyId]
    );
    const patrimony = patrimonyResult.rows[0];

    if (patrimony === undefined) {
      return { ok: false, reason: "PATRIMONY_NOT_FOUND", patrimonyId: input.patrimonyId };
    }

    if (!(await this.isAuthorized(client, input.actorUserId, patrimony.source_gre_code))) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED", patrimonyId: input.patrimonyId };
    }

    if (patrimony.operational_state === "BAIXADO") {
      return { ok: false, reason: "PATRIMONY_ALREADY_WRITTEN_OFF", patrimonyId: input.patrimonyId };
    }

    if (
      input.reason === "INSERVIBILIDADE" &&
      patrimony.is_tombable &&
      (input.procedureOrReportReference === undefined || input.authorizationReference === undefined)
    ) {
      return {
        ok: false,
        reason:
          input.procedureOrReportReference === undefined
            ? "INVALID_PROCEDURE_OR_REPORT_REFERENCE"
            : "INVALID_AUTHORIZATION_REFERENCE",
        patrimonyId: input.patrimonyId
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
        reason: "PATRIMONY_COMPOSITION_WRITE_OFF_NOT_SUPPORTED",
        patrimonyId: input.patrimonyId
      };
    }

    const tomboResult = await client.query<ActiveTomboRow>(
      `select "id", "tombo", "issued_at"
         from "patrimony_tombo"
        where "patrimony_id" = $1
          and "status" = 'ATIVO'
          and "retired_at" is null
        for update`,
      [input.patrimonyId]
    );
    const activeTombo = tomboResult.rows[0];

    if (patrimony.is_tombable && activeTombo === undefined) {
      return { ok: false, reason: "TOMBO_NOT_ACTIVE", patrimonyId: input.patrimonyId };
    }

    if (activeTombo !== undefined && input.occurredAt < activeTombo.issued_at) {
      return {
        ok: false,
        reason: "WRITEOFF_DATE_BEFORE_TOMBO_ISSUANCE",
        patrimonyId: input.patrimonyId
      };
    }

    const writeOffId = randomUUID();
    await client.query(
      `update "patrimony"
          set "operational_state" = 'BAIXADO',
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.patrimonyId]
    );

    if (activeTombo !== undefined) {
      await client.query(
        `update "patrimony_tombo"
            set "status" = 'ENCERRADO',
                "retired_at" = $2,
                "retirement_reason" = $3,
                "updated_at" = current_timestamp
          where "id" = $1`,
        [activeTombo.id, input.occurredAt, input.justification]
      );
    }

    await client.query(
      `insert into "patrimony_write_off" (
        "id", "patrimony_id", "reason", "occurred_at", "justification",
        "procedure_or_report_reference", "authorization_reference", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        writeOffId,
        input.patrimonyId,
        input.reason,
        input.occurredAt,
        input.justification,
        input.procedureOrReportReference ?? null,
        input.authorizationReference ?? null,
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
        BAIXAR_PATRIMONY_COMMAND,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          operationalState: patrimony.operational_state,
          responsibleEntityId: patrimony.responsible_entity_id,
          tombo: activeTombo?.tombo ?? null
        }),
        JSON.stringify({
          operationalState: "BAIXADO",
          responsibleEntityId: patrimony.responsible_entity_id,
          tombo: activeTombo?.tombo ?? null,
          tomboStatus: activeTombo === undefined ? null : "ENCERRADO",
          reason: input.reason
        }),
        input.justification,
        input.correlationId
      ]
    );

    await client.query(
      `insert into "outbox_event" (
        "id", "event_type", "aggregate_type", "aggregate_id", "payload", "updated_at"
      ) values ($1, $2, $3, $4, $5::jsonb, current_timestamp)`,
      [
        randomUUID(),
        PATRIMONY_BAIXADO_EVENT,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          writeOffId,
          patrimonyId: input.patrimonyId,
          status: "BAIXADO",
          reason: input.reason,
          occurredAt: input.occurredAt.toISOString(),
          tombo: activeTombo?.tombo ?? null,
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      writeOffId,
      patrimonyId: input.patrimonyId,
      status: "BAIXADO",
      activeTomboRetired: activeTombo !== undefined
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

function hashBaixarCommand(input: BaixarPatrimonyCommand): string {
  const payload = {
    patrimonyId: input.patrimonyId,
    reason: input.reason,
    occurredAt: input.occurredAtWasProvided ? input.occurredAt.toISOString() : null,
    justification: input.justification,
    procedureOrReportReference: input.procedureOrReportReference ?? null,
    authorizationReference: input.authorizationReference ?? null,
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): BaixarPatrimonyResult {
  if (isBaixarPatrimonyResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isBaixarPatrimonyResult(value: unknown): value is BaixarPatrimonyResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { writeOffId?: unknown }).writeOffId === "string" &&
      typeof (value as { patrimonyId?: unknown }).patrimonyId === "string" &&
      (value as { status?: unknown }).status === "BAIXADO" &&
      typeof (value as { activeTomboRetired?: unknown }).activeTomboRetired === "boolean"
    );
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
