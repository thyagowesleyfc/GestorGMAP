import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import { allocateTomboSequenceInTransaction } from "./postgres-tombo-sequence-allocator";
import type {
  PatrimonyWarrantyReplacer,
  ReplacePatrimonyUnderWarrantyCommand,
  ReplacePatrimonyUnderWarrantyFailureReason,
  ReplacePatrimonyUnderWarrantyResult
} from "../application/replace-patrimony-under-warranty";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: ReplacePatrimonyUnderWarrantyResult }
  | { kind: "CONFLICT" };

type PatrimonyRow = {
  id: string;
  operational_state: "EM_USO" | "RECOLHIDO" | "EM_MANUTENCAO" | "BAIXADO";
  responsible_entity_id: string;
  source_gre_code: string;
  closed_at: Date | null;
  is_tombable: boolean;
};

type MaintenanceRequestRow = {
  id: string;
  authorized_at: Date | null;
  authorized_by_user_id: string | null;
};

type StrategyRow = {
  strategy_type: "UTD" | "CERME" | "CONTRATO_SERVICO" | "GARANTIA" | "AVALIACAO_BAIXA";
};

type MaterialRow = {
  id: string;
  active: boolean;
  is_tombable: boolean;
  patrimonial_group_code: string | null;
};

type ActiveTomboRow = {
  id: string;
  tombo: string;
  issued_at: Date;
};

const REPLACE_PATRIMONY_UNDER_WARRANTY_COMMAND = "patrimony.replace_under_warranty";
const PATRIMONY_REPLACED_UNDER_WARRANTY_EVENT = "patrimony.replaced_under_warranty";
const AUTHORIZED_TEAM_NAME = "Patrimônio";

export class PostgresPatrimonyWarrantyReplacer implements PatrimonyWarrantyReplacer {
  constructor(private readonly pool: Pool) {}

  async replace(
    input: ReplacePatrimonyUnderWarrantyCommand
  ): Promise<ReplacePatrimonyUnderWarrantyResult> {
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
        return {
          ok: false,
          reason: "IDEMPOTENCY_KEY_CONFLICT",
          patrimonyId: input.patrimonyId,
          maintenanceRequestId: input.maintenanceRequestId
        };
      }

      const result = await this.replaceInTransaction(client, input);
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
    input: ReplacePatrimonyUnderWarrantyCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashCommand(input);
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [randomUUID(), REPLACE_PATRIMONY_UNDER_WARRANTY_COMMAND, input.commandId, requestHash]
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
      [REPLACE_PATRIMONY_UNDER_WARRANTY_COMMAND, input.commandId]
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
    result: ReplacePatrimonyUnderWarrantyResult
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

  private async replaceInTransaction(
    client: PoolClient,
    input: ReplacePatrimonyUnderWarrantyCommand
  ): Promise<ReplacePatrimonyUnderWarrantyResult> {
    const request = await client.query<MaintenanceRequestRow>(
      `select "id", "authorized_at", "authorized_by_user_id"
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
        patrimonyId: input.patrimonyId,
        maintenanceRequestId: input.maintenanceRequestId
      };
    }

    if (requestRow.authorized_at === null || requestRow.authorized_by_user_id === null) {
      return {
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
        patrimonyId: input.patrimonyId,
        maintenanceRequestId: input.maintenanceRequestId
      };
    }

    const patrimonyResult = await client.query<PatrimonyRow>(
      `select p."id",
              p."operational_state"::text as "operational_state",
              p."responsible_entity_id",
              g."code" as "source_gre_code",
              p."closed_at",
              ms."is_tombable"
         from "patrimony" p
         join "entity" e on e."id" = p."responsible_entity_id"
         join "gre" g on g."id" = e."gre_id"
         join "material_singular" ms on ms."id" = p."material_singular_id"
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

    const target = await client.query<{ patrimony_id: string }>(
      `select "patrimony_id"
         from "maintenance_request_patrimony_target"
        where "maintenance_request_id" = $1
          and "patrimony_id" = $2
        for update`,
      [input.maintenanceRequestId, input.patrimonyId]
    );
    if (target.rows[0] === undefined) {
      return {
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_LINKED_TO_PATRIMONY",
        patrimonyId: input.patrimonyId,
        maintenanceRequestId: input.maintenanceRequestId
      };
    }

    const strategy = await client.query<StrategyRow>(
      `select "strategy_type"::text as "strategy_type"
         from "maintenance_request_patrimony_strategy"
        where "maintenance_request_id" = $1
          and "patrimony_id" = $2
        for share`,
      [input.maintenanceRequestId, input.patrimonyId]
    );
    if (strategy.rows[0] === undefined || strategy.rows[0].strategy_type !== "GARANTIA") {
      return {
        ok: false,
        reason: "MAINTENANCE_STRATEGY_NOT_GARANTIA",
        patrimonyId: input.patrimonyId,
        maintenanceRequestId: input.maintenanceRequestId
      };
    }

    if (patrimony.closed_at !== null) {
      return { ok: false, reason: "PATRIMONY_ALREADY_CLOSED", patrimonyId: input.patrimonyId };
    }

    if (patrimony.operational_state === "BAIXADO") {
      return { ok: false, reason: "PATRIMONY_ALREADY_WRITTEN_OFF", patrimonyId: input.patrimonyId };
    }

    const existingReplacement = await client.query<{ id: string }>(
      `select "id"
         from "patrimony_warranty_replacement"
        where "previous_patrimony_id" = $1
        for share`,
      [input.patrimonyId]
    );
    if (existingReplacement.rows[0] !== undefined) {
      return { ok: false, reason: "PATRIMONY_ALREADY_REPLACED", patrimonyId: input.patrimonyId };
    }

    const materialResult = await client.query<MaterialRow>(
      `select "id", "active", "is_tombable", "patrimonial_group_code"
         from "material_singular"
        where "id" = $1
        for share`,
      [input.replacementMaterialSingularId]
    );
    const material = materialResult.rows[0];

    if (material === undefined) {
      return {
        ok: false,
        reason: "REPLACEMENT_MATERIAL_NOT_FOUND",
        patrimonyId: input.patrimonyId
      };
    }

    if (!material.active) {
      return {
        ok: false,
        reason: "REPLACEMENT_MATERIAL_NOT_ACTIVE",
        patrimonyId: input.patrimonyId
      };
    }

    if (
      material.is_tombable &&
      (material.patrimonial_group_code === null || !/^\d{2}$/.test(material.patrimonial_group_code))
    ) {
      return {
        ok: false,
        reason: "REPLACEMENT_MATERIAL_GROUP_INVALID",
        patrimonyId: input.patrimonyId
      };
    }

    const activeTombo = await this.loadActiveTombo(client, input.patrimonyId);
    if (patrimony.is_tombable && activeTombo === undefined) {
      return {
        ok: false,
        reason: "PATRIMONY_WITHOUT_ACTIVE_TOMBO",
        patrimonyId: input.patrimonyId
      };
    }

    if (activeTombo !== undefined && input.occurredAt < activeTombo.issued_at) {
      return {
        ok: false,
        reason: "OCCURRED_AT_BEFORE_TOMBO_ISSUANCE",
        patrimonyId: input.patrimonyId
      };
    }

    const replacementPatrimonyId = randomUUID();
    const replacementId = randomUUID();
    let replacementTombo: string | null = null;

    await client.query(
      `update "patrimony"
          set "closed_at" = $2,
              "closure_reason" = 'SUBSTITUICAO_EM_GARANTIA',
              "closed_by_user_id" = $3,
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.patrimonyId, input.occurredAt, input.actorUserId]
    );

    if (activeTombo !== undefined) {
      await client.query(
        `update "patrimony_tombo"
            set "status" = 'ENCERRADO',
                "retired_at" = $2,
                "retirement_reason" = 'SUBSTITUICAO_EM_GARANTIA',
                "updated_at" = current_timestamp
          where "id" = $1`,
        [activeTombo.id, input.occurredAt]
      );
    }

    await client.query(
      `insert into "patrimony" (
        "id", "material_singular_id", "responsible_entity_id", "operational_state",
        "serial_number", "origin", "updated_at"
      ) values ($1, $2, $3, 'EM_USO', $4, 'SUBSTITUICAO_EM_GARANTIA', current_timestamp)`,
      [
        replacementPatrimonyId,
        input.replacementMaterialSingularId,
        patrimony.responsible_entity_id,
        input.serialNumber ?? null
      ]
    );

    if (material.is_tombable) {
      const allocation = await allocateTomboSequenceInTransaction(client, {
        patrimonialGroupCode: material.patrimonial_group_code as string
      });
      replacementTombo = allocation.tombo;

      await client.query(
        `insert into "patrimony_tombo" (
          "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
        ) values ($1, $2, $3, $4, $5, current_timestamp)`,
        [
          randomUUID(),
          replacementPatrimonyId,
          allocation.tombo,
          allocation.patrimonialGroupCode,
          input.occurredAt
        ]
      );
    }

    await client.query(
      `insert into "patrimony_warranty_replacement" (
        "id", "previous_patrimony_id", "replacement_patrimony_id", "maintenance_request_id",
        "authorized_by_user_id", "authorized_at", "executed_by_user_id", "occurred_at",
        "warranty_reference", "serial_number", "justification", "correlation_id", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, current_timestamp)`,
      [
        replacementId,
        input.patrimonyId,
        replacementPatrimonyId,
        input.maintenanceRequestId,
        requestRow.authorized_by_user_id,
        requestRow.authorized_at,
        input.actorUserId,
        input.occurredAt,
        input.warrantyReference,
        input.serialNumber ?? null,
        input.justification,
        input.correlationId
      ]
    );

    for (const evidence of input.evidences) {
      await client.query(
        `insert into "patrimony_warranty_replacement_evidence" (
          "id", "replacement_id", "evidence_type", "reference", "updated_at"
        ) values ($1, $2, $3, $4, current_timestamp)`,
        [randomUUID(), replacementId, evidence.type, evidence.reference]
      );
    }

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
        REPLACE_PATRIMONY_UNDER_WARRANTY_COMMAND,
        "patrimony_warranty_replacement",
        replacementId,
        JSON.stringify({
          previousPatrimonyId: input.patrimonyId,
          previousOperationalState: patrimony.operational_state,
          previousTombo: activeTombo?.tombo ?? null,
          maintenanceRequestId: input.maintenanceRequestId
        }),
        JSON.stringify({
          previousPatrimonyId: input.patrimonyId,
          replacementPatrimonyId,
          closureReason: "SUBSTITUICAO_EM_GARANTIA",
          replacementOrigin: "SUBSTITUICAO_EM_GARANTIA",
          replacementTombo,
          evidenceCount: input.evidences.length,
          maintenanceRequestId: input.maintenanceRequestId
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
        PATRIMONY_REPLACED_UNDER_WARRANTY_EVENT,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          replacementId,
          previousPatrimonyId: input.patrimonyId,
          replacementPatrimonyId,
          maintenanceRequestId: input.maintenanceRequestId,
          replacementTombo,
          occurredAt: input.occurredAt.toISOString(),
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      replacementId,
      previousPatrimonyId: input.patrimonyId,
      replacementPatrimonyId,
      replacementTombo
    };
  }

  private async loadActiveTombo(
    client: PoolClient,
    patrimonyId: string
  ): Promise<ActiveTomboRow | undefined> {
    const result = await client.query<ActiveTomboRow>(
      `select "id", "tombo", "issued_at"
         from "patrimony_tombo"
        where "patrimony_id" = $1
          and "status" = 'ATIVO'
          and "retired_at" is null
        for update`,
      [patrimonyId]
    );
    return result.rows[0];
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
            and t."name" = $2
            and (tm."scope_type" = 'GLOBAL' or (tm."scope_type" = 'GRE' and tm."gre_code" = $3))
       ) as "authorized"`,
      [actorUserId, AUTHORIZED_TEAM_NAME, greCode]
    );

    return authorization.rows[0]?.authorized === true;
  }
}

function hashCommand(input: ReplacePatrimonyUnderWarrantyCommand): string {
  const payload = {
    patrimonyId: input.patrimonyId,
    maintenanceRequestId: input.maintenanceRequestId,
    replacementMaterialSingularId: input.replacementMaterialSingularId,
    warrantyReference: input.warrantyReference,
    evidences: input.evidences,
    justification: input.justification,
    serialNumber: input.serialNumber ?? null,
    occurredAt: input.occurredAt.toISOString(),
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): ReplacePatrimonyUnderWarrantyResult {
  if (isReplacePatrimonyUnderWarrantyResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isReplacePatrimonyUnderWarrantyResult(
  value: unknown
): value is ReplacePatrimonyUnderWarrantyResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { replacementId?: unknown }).replacementId === "string" &&
      typeof (value as { previousPatrimonyId?: unknown }).previousPatrimonyId === "string" &&
      typeof (value as { replacementPatrimonyId?: unknown }).replacementPatrimonyId === "string" &&
      ((value as { replacementTombo?: unknown }).replacementTombo === null ||
        typeof (value as { replacementTombo?: unknown }).replacementTombo === "string")
    );
  }

  return isFailureReason((value as { reason?: unknown }).reason);
}

function isFailureReason(value: unknown): value is ReplacePatrimonyUnderWarrantyFailureReason {
  return (
    typeof value === "string" &&
    new Set<ReplacePatrimonyUnderWarrantyFailureReason>([
      "INVALID_COMMAND_ID",
      "INVALID_PATRIMONY_ID",
      "INVALID_MAINTENANCE_REQUEST_ID",
      "INVALID_REPLACEMENT_MATERIAL_ID",
      "INVALID_WARRANTY_REFERENCE",
      "INVALID_EVIDENCE",
      "INVALID_JUSTIFICATION",
      "INVALID_SERIAL_NUMBER",
      "INVALID_OCCURRED_AT",
      "INVALID_ACTOR_USER_ID",
      "INVALID_TEAM_CONTEXT",
      "IDEMPOTENCY_KEY_CONFLICT",
      "ACTOR_NOT_AUTHORIZED",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
      "MAINTENANCE_REQUEST_NOT_LINKED_TO_PATRIMONY",
      "MAINTENANCE_STRATEGY_NOT_GARANTIA",
      "PATRIMONY_NOT_FOUND",
      "PATRIMONY_ALREADY_CLOSED",
      "PATRIMONY_ALREADY_WRITTEN_OFF",
      "REPLACEMENT_MATERIAL_NOT_FOUND",
      "REPLACEMENT_MATERIAL_NOT_ACTIVE",
      "REPLACEMENT_MATERIAL_GROUP_INVALID",
      "PATRIMONY_WITHOUT_ACTIVE_TOMBO",
      "PATRIMONY_ALREADY_REPLACED",
      "OCCURRED_AT_BEFORE_TOMBO_ISSUANCE"
    ]).has(value as ReplacePatrimonyUnderWarrantyFailureReason)
  );
}
