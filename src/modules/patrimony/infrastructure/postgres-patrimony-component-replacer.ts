import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import { allocateTomboSequenceInTransaction } from "./postgres-tombo-sequence-allocator";
import type {
  PatrimonialComponentReplacer,
  ReplacePatrimonialComponentCommand,
  ReplacePatrimonialComponentFailureReason,
  ReplacePatrimonialComponentResult
} from "../application/replace-patrimonial-component";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: ReplacePatrimonialComponentResult }
  | { kind: "CONFLICT" };

type PatrimonyRow = {
  id: string;
  responsible_entity_id: string;
  source_gre_code: string;
  operational_state: "EM_USO" | "RECOLHIDO" | "EM_MANUTENCAO" | "BAIXADO";
  closed_at: Date | null;
};

type MaintenanceRequestRow = {
  id: string;
  authorized_at: Date | null;
  authorized_by_user_id: string | null;
};

type StrategyRow = {
  strategy_type: "UTD" | "CERME" | "CONTRATO_SERVICO" | "GARANTIA" | "AVALIACAO_BAIXA";
};

type CompositionRow = {
  id: string;
  revision: number;
  material_configuration_id: string;
  configuration_code: string;
  configuration_name: string;
  configuration_type: "KIT" | "COMPOSTO";
};

type CompositionItemRow = {
  id: string;
  line_number: number;
  material_singular_id: string;
  component_patrimony_id: string | null;
  quantity: number;
  material_code: string;
  material_name: string;
  is_tombable: boolean;
  patrimonial_group_code: string | null;
};

type MaterialRow = {
  id: string;
  class_id: string;
  code: string;
  name: string;
  active: boolean;
  is_tombable: boolean;
  patrimonial_group_code: string | null;
};

type ComponentPatrimonyRow = {
  id: string;
  material_singular_id: string;
  serial_number: string | null;
  responsible_entity_id: string;
  component_status: "REMOVIDO_EM_MANUTENCAO" | null;
  operational_state: "EM_USO" | "RECOLHIDO" | "EM_MANUTENCAO" | "BAIXADO";
};

type ActiveTomboRow = {
  id: string;
  tombo: string;
  issued_at: Date;
};

const REPLACE_COMPONENT_COMMAND = "patrimony.replace_component";
const COMPONENT_REPLACED_EVENT = "patrimony.component_replaced";
const AUTHORIZED_TEAM_NAME = "Patrimônio";

export class PostgresPatrimonyComponentReplacer implements PatrimonialComponentReplacer {
  constructor(private readonly pool: Pool) {}

  async replace(
    input: ReplacePatrimonialComponentCommand
  ): Promise<ReplacePatrimonialComponentResult> {
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
          maintenanceRequestId: input.maintenanceRequestId,
          compositionItemId: input.compositionItemId
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
    input: ReplacePatrimonialComponentCommand
  ): Promise<IdempotencyReservation> {
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [randomUUID(), REPLACE_COMPONENT_COMMAND, input.commandId, hashCommand(input)]
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
      [REPLACE_COMPONENT_COMMAND, input.commandId]
    );
    const row = existing.rows[0];

    if (row === undefined || row.request_hash !== hashCommand(input)) {
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
    result: ReplacePatrimonialComponentResult
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
    input: ReplacePatrimonialComponentCommand
  ): Promise<ReplacePatrimonialComponentResult> {
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
      `select p."id", p."responsible_entity_id", g."code" as "source_gre_code",
              p."operational_state"::text as "operational_state", p."closed_at"
         from "patrimony" p
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

    const resolvedTeamContext = await this.resolveAuthorizedTeamContext(
      client,
      input.actorUserId,
      patrimony.source_gre_code
    );
    if (resolvedTeamContext === null) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED", patrimonyId: input.patrimonyId };
    }

    if (input.teamContext !== resolvedTeamContext) {
      return {
        ok: false,
        reason: "TEAM_CONTEXT_NOT_AUTHORIZED",
        patrimonyId: input.patrimonyId
      };
    }

    if (patrimony.closed_at !== null) {
      return { ok: false, reason: "PATRIMONY_CLOSED", patrimonyId: input.patrimonyId };
    }

    if (patrimony.operational_state === "BAIXADO") {
      return { ok: false, reason: "PATRIMONY_WRITTEN_OFF", patrimonyId: input.patrimonyId };
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

    const strategyResult = await client.query<StrategyRow>(
      `select "strategy_type"::text as "strategy_type"
         from "maintenance_request_patrimony_strategy"
        where "maintenance_request_id" = $1
          and "patrimony_id" = $2
        for share`,
      [input.maintenanceRequestId, input.patrimonyId]
    );
    const strategy = strategyResult.rows[0];

    if (strategy === undefined) {
      return {
        ok: false,
        reason: "MAINTENANCE_STRATEGY_NOT_FOUND",
        patrimonyId: input.patrimonyId,
        maintenanceRequestId: input.maintenanceRequestId
      };
    }

    if (strategy.strategy_type === "CONTRATO_SERVICO") {
      const serviceOrder = await client.query<{ exists: boolean }>(
        `select exists(
           select 1
             from "maintenance_service_order_patrimony" msop
             join "maintenance_service_order" mso on mso."id" = msop."service_order_id"
            where msop."maintenance_request_id" = $1
              and msop."patrimony_id" = $2
              and mso."status" <> 'CANCELADA'
         ) as "exists"`,
        [input.maintenanceRequestId, input.patrimonyId]
      );
      if (serviceOrder.rows[0]?.exists !== true) {
        return {
          ok: false,
          reason: "MAINTENANCE_SERVICE_ORDER_REQUIRED",
          patrimonyId: input.patrimonyId,
          maintenanceRequestId: input.maintenanceRequestId
        };
      }
    }

    const compositionResult = await client.query<CompositionRow>(
      `select "id", "revision", "material_configuration_id", "configuration_code",
              "configuration_name", "configuration_type"::text as "configuration_type"
         from "patrimony_composition"
        where "patrimony_id" = $1
        order by "revision" desc
        limit 1
        for update`,
      [input.patrimonyId]
    );
    const composition = compositionResult.rows[0];

    if (composition === undefined) {
      return { ok: false, reason: "COMPOSITION_NOT_FOUND", patrimonyId: input.patrimonyId };
    }

    if (composition.revision !== input.expectedRevision) {
      return {
        ok: false,
        reason: "COMPOSITION_VERSION_CONFLICT",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    const itemsResult = await client.query<CompositionItemRow>(
      `select "id", "line_number", "material_singular_id", "component_patrimony_id", "quantity",
              "material_code", "material_name", "is_tombable", "patrimonial_group_code"
         from "patrimony_composition_item"
        where "composition_id" = $1
        order by "line_number"
        for update`,
      [composition.id]
    );
    const items = itemsResult.rows;
    const item = items.find((current) => current.id === input.compositionItemId);

    if (item === undefined) {
      return {
        ok: false,
        reason: "COMPOSITION_ITEM_NOT_FOUND",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    const replacementMaterialResult = await client.query<MaterialRow>(
      `select "id", "class_id", "code", "name", "active", "is_tombable", "patrimonial_group_code"
         from "material_singular"
        where "id" = $1
        for share`,
      [input.replacementMaterialSingularId]
    );
    const replacementMaterial = replacementMaterialResult.rows[0];

    if (replacementMaterial === undefined) {
      return {
        ok: false,
        reason: "REPLACEMENT_MATERIAL_NOT_FOUND",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (!replacementMaterial.active) {
      return {
        ok: false,
        reason: "REPLACEMENT_MATERIAL_NOT_ACTIVE",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (replacementMaterial.id === item.material_singular_id) {
      return {
        ok: false,
        reason: "REPLACEMENT_MATERIAL_SAME_AS_PREVIOUS",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (
      items.some(
        (current) =>
          current.id !== item.id && current.material_singular_id === replacementMaterial.id
      )
    ) {
      return {
        ok: false,
        reason: "REPLACEMENT_MATERIAL_ALREADY_PRESENT",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    const previousMaterialResult = await client.query<{
      class_id: string;
      is_tombable: boolean;
    }>(
      `select "class_id", "is_tombable"
         from "material_singular"
        where "id" = $1
        for share`,
      [item.material_singular_id]
    );
    const previousMaterial = previousMaterialResult.rows[0];

    if (previousMaterial === undefined) {
      return {
        ok: false,
        reason: "REPLACEMENT_MATERIAL_NOT_FOUND",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (previousMaterial.class_id !== replacementMaterial.class_id) {
      return {
        ok: false,
        reason: "REPLACEMENT_MATERIAL_CLASS_MISMATCH",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (previousMaterial.is_tombable !== item.is_tombable) {
      return {
        ok: false,
        reason: "COMPOSITION_ITEM_INCONSISTENT",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (item.is_tombable && item.component_patrimony_id === null) {
      return {
        ok: false,
        reason: "TOMBABLE_COMPONENT_REQUIRES_PATRIMONY",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (!item.is_tombable && item.component_patrimony_id !== null) {
      return {
        ok: false,
        reason: "NON_TOMBABLE_COMPONENT_HAS_PATRIMONY",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (
      replacementMaterial.is_tombable &&
      (replacementMaterial.patrimonial_group_code === null ||
        !/^\d{2}$/.test(replacementMaterial.patrimonial_group_code))
    ) {
      return {
        ok: false,
        reason: "REPLACEMENT_MATERIAL_GROUP_INVALID",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    const previousComponent = await this.loadComponentPatrimony(
      client,
      item.component_patrimony_id
    );

    if (item.component_patrimony_id !== null && previousComponent === undefined) {
      return {
        ok: false,
        reason: "COMPONENT_NOT_FOUND",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (previousComponent?.component_status === "REMOVIDO_EM_MANUTENCAO") {
      return {
        ok: false,
        reason: "COMPONENT_ALREADY_REMOVED",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (
      previousComponent !== undefined &&
      previousComponent.material_singular_id !== item.material_singular_id
    ) {
      return {
        ok: false,
        reason: "COMPONENT_MATERIAL_MISMATCH",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (
      previousComponent !== undefined &&
      previousComponent.responsible_entity_id !== patrimony.responsible_entity_id
    ) {
      return {
        ok: false,
        reason: "COMPONENT_ENTITY_MISMATCH",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    if (previousComponent?.operational_state === "BAIXADO") {
      return {
        ok: false,
        reason: "COMPONENT_NOT_AVAILABLE",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    const previousTombo = item.component_patrimony_id
      ? await this.loadActiveTombo(client, item.component_patrimony_id)
      : undefined;

    if (previousMaterial.is_tombable && previousTombo === undefined) {
      return {
        ok: false,
        reason: "TOMBABLE_COMPONENT_REQUIRES_PATRIMONY",
        patrimonyId: input.patrimonyId,
        compositionItemId: input.compositionItemId
      };
    }

    const replacementComponentPatrimonyId = replacementMaterial.is_tombable ? randomUUID() : null;
    let replacementTombo: string | null = null;

    if (replacementComponentPatrimonyId !== null) {
      await client.query(
        `insert into "patrimony" (
          "id", "material_singular_id", "responsible_entity_id", "operational_state",
          "serial_number", "origin", "updated_at"
        ) values ($1, $2, $3, 'EM_USO', $4, 'MANUTENCAO', current_timestamp)`,
        [
          replacementComponentPatrimonyId,
          replacementMaterial.id,
          patrimony.responsible_entity_id,
          input.replacementSerialNumber ?? null
        ]
      );

      const allocation = await allocateTomboSequenceInTransaction(client, {
        patrimonialGroupCode: replacementMaterial.patrimonial_group_code as string
      });
      replacementTombo = allocation.tombo;

      await client.query(
        `insert into "patrimony_tombo" (
          "id", "patrimony_id", "tombo", "patrimonial_group_code", "issued_at", "updated_at"
        ) values ($1, $2, $3, $4, $5, current_timestamp)`,
        [
          randomUUID(),
          replacementComponentPatrimonyId,
          allocation.tombo,
          allocation.patrimonialGroupCode,
          input.occurredAt
        ]
      );
    }

    if (previousComponent !== undefined) {
      await client.query(
        `update "patrimony"
            set "component_status" = 'REMOVIDO_EM_MANUTENCAO',
                "operational_state" = 'EM_MANUTENCAO',
                "version" = "version" + 1,
                "updated_at" = current_timestamp
          where "id" = $1`,
        [previousComponent.id]
      );
    }

    const replacementRevision = composition.revision + 1;
    const replacementCompositionId = randomUUID();
    await client.query(
      `insert into "patrimony_composition" (
        "id", "patrimony_id", "revision", "material_configuration_id",
        "configuration_code", "configuration_name", "configuration_type",
        "recorded_at", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, $7::"MaterialConfigurationType", $8, current_timestamp)`,
      [
        replacementCompositionId,
        input.patrimonyId,
        replacementRevision,
        composition.material_configuration_id,
        composition.configuration_code,
        composition.configuration_name,
        composition.configuration_type,
        input.occurredAt
      ]
    );

    for (const current of items) {
      const isReplacedItem = current.id === item.id;
      await client.query(
        `insert into "patrimony_composition_item" (
          "id", "composition_id", "line_number", "material_singular_id",
          "component_patrimony_id", "quantity", "material_code", "material_name",
          "is_tombable", "patrimonial_group_code", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, current_timestamp)`,
        [
          randomUUID(),
          replacementCompositionId,
          current.line_number,
          isReplacedItem ? replacementMaterial.id : current.material_singular_id,
          isReplacedItem ? replacementComponentPatrimonyId : current.component_patrimony_id,
          current.quantity,
          isReplacedItem ? replacementMaterial.code : current.material_code,
          isReplacedItem ? replacementMaterial.name : current.material_name,
          isReplacedItem ? replacementMaterial.is_tombable : current.is_tombable,
          isReplacedItem
            ? replacementMaterial.patrimonial_group_code
            : current.patrimonial_group_code
        ]
      );
    }

    const replacementId = randomUUID();
    await client.query(
      `insert into "patrimony_component_replacement" (
        "id", "patrimony_id", "maintenance_request_id", "previous_composition_id",
        "replacement_composition_id", "previous_composition_item_id",
        "previous_component_patrimony_id", "replacement_component_patrimony_id",
        "previous_material_singular_id", "replacement_material_singular_id", "replacement_origin",
        "removed_status", "previous_identification", "replacement_identification",
        "service_unit_reference", "supplier_reference", "document_reference",
        "occurred_at", "justification", "executed_by_user_id", "correlation_id", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                'MANUTENCAO', 'REMOVIDO_EM_MANUTENCAO', $11, $12, $13, $14, $15, $16, $17, $18, $19, current_timestamp)`,
      [
        replacementId,
        input.patrimonyId,
        input.maintenanceRequestId,
        composition.id,
        replacementCompositionId,
        item.id,
        item.component_patrimony_id,
        replacementComponentPatrimonyId,
        item.material_singular_id,
        replacementMaterial.id,
        input.previousIdentification ?? previousComponent?.serial_number ?? null,
        input.replacementIdentification ?? input.replacementSerialNumber ?? null,
        input.serviceUnitReference ?? null,
        input.supplierReference ?? null,
        input.documentReference ?? null,
        input.occurredAt,
        input.justification,
        input.actorUserId,
        input.correlationId
      ]
    );

    for (const evidence of input.evidences) {
      await client.query(
        `insert into "patrimony_component_replacement_evidence" (
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
        REPLACE_COMPONENT_COMMAND,
        "patrimony_component_replacement",
        replacementId,
        JSON.stringify({
          patrimonyId: input.patrimonyId,
          compositionId: composition.id,
          revision: composition.revision,
          compositionItemId: item.id,
          previousMaterialSingularId: item.material_singular_id,
          previousComponentPatrimonyId: item.component_patrimony_id,
          previousTombo: previousTombo?.tombo ?? null
        }),
        JSON.stringify({
          patrimonyId: input.patrimonyId,
          compositionId: replacementCompositionId,
          revision: replacementRevision,
          replacementMaterialSingularId: replacementMaterial.id,
          replacementComponentPatrimonyId,
          replacementTombo,
          removedStatus: "REMOVIDO_EM_MANUTENCAO",
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
        COMPONENT_REPLACED_EVENT,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          replacementId,
          patrimonyId: input.patrimonyId,
          maintenanceRequestId: input.maintenanceRequestId,
          previousCompositionId: composition.id,
          replacementCompositionId,
          previousComponentPatrimonyId: item.component_patrimony_id,
          replacementComponentPatrimonyId,
          replacementTombo,
          occurredAt: input.occurredAt.toISOString(),
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      replacementId,
      patrimonyId: input.patrimonyId,
      previousCompositionId: composition.id,
      replacementCompositionId,
      previousRevision: composition.revision,
      replacementRevision,
      previousComponentPatrimonyId: item.component_patrimony_id,
      replacementComponentPatrimonyId,
      replacementTombo
    };
  }

  private async loadComponentPatrimony(
    client: PoolClient,
    patrimonyId: string | null
  ): Promise<ComponentPatrimonyRow | undefined> {
    if (patrimonyId === null) {
      return undefined;
    }

    const result = await client.query<ComponentPatrimonyRow>(
      `select "id", "material_singular_id", "serial_number", "responsible_entity_id",
              "component_status"::text as "component_status",
              "operational_state"::text as "operational_state"
         from "patrimony"
        where "id" = $1
        for update`,
      [patrimonyId]
    );
    return result.rows[0];
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

  private async resolveAuthorizedTeamContext(
    client: PoolClient,
    actorUserId: string,
    greCode: string
  ): Promise<string | null> {
    const authorization = await client.query<{ team_name: string }>(
      `select t."name" as "team_name"
         from "user_account" u
         join "team_membership" tm on tm."user_id" = u."id"
         join "team" t on t."id" = tm."team_id"
        where u."id" = $1
          and u."status" = 'ACTIVE'
          and tm."active" = true
          and t."name" = $2
          and (tm."scope_type" = 'GLOBAL' or (tm."scope_type" = 'GRE' and tm."gre_code" = $3))
        order by case when tm."scope_type" = 'GRE' then 0 else 1 end
        limit 1`,
      [actorUserId, AUTHORIZED_TEAM_NAME, greCode]
    );
    return authorization.rows[0]?.team_name ?? null;
  }
}

function hashCommand(input: ReplacePatrimonialComponentCommand): string {
  const payload = {
    patrimonyId: input.patrimonyId,
    maintenanceRequestId: input.maintenanceRequestId,
    compositionItemId: input.compositionItemId,
    expectedRevision: input.expectedRevision,
    replacementMaterialSingularId: input.replacementMaterialSingularId,
    replacementSerialNumber: input.replacementSerialNumber ?? null,
    previousIdentification: input.previousIdentification ?? null,
    replacementIdentification: input.replacementIdentification ?? null,
    serviceUnitReference: input.serviceUnitReference ?? null,
    supplierReference: input.supplierReference ?? null,
    documentReference: input.documentReference ?? null,
    evidences: input.evidences,
    justification: input.justification,
    occurredAt: input.occurredAt.toISOString(),
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): ReplacePatrimonialComponentResult {
  if (isReplacePatrimonialComponentResult(value)) {
    return value;
  }
  throw new Error("Stored idempotency result is invalid.");
}

function isReplacePatrimonialComponentResult(
  value: unknown
): value is ReplacePatrimonialComponentResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { replacementId?: unknown }).replacementId === "string" &&
      typeof (value as { patrimonyId?: unknown }).patrimonyId === "string" &&
      typeof (value as { previousCompositionId?: unknown }).previousCompositionId === "string" &&
      typeof (value as { replacementCompositionId?: unknown }).replacementCompositionId ===
        "string" &&
      typeof (value as { previousRevision?: unknown }).previousRevision === "number" &&
      typeof (value as { replacementRevision?: unknown }).replacementRevision === "number"
    );
  }

  return isFailureReason((value as { reason?: unknown }).reason);
}

function isFailureReason(value: unknown): value is ReplacePatrimonialComponentFailureReason {
  return (
    typeof value === "string" &&
    new Set<ReplacePatrimonialComponentFailureReason>([
      "INVALID_COMMAND_ID",
      "INVALID_PATRIMONY_ID",
      "INVALID_MAINTENANCE_REQUEST_ID",
      "INVALID_COMPOSITION_ITEM_ID",
      "INVALID_EXPECTED_REVISION",
      "INVALID_REPLACEMENT_MATERIAL_ID",
      "INVALID_IDENTIFICATION",
      "INVALID_SERIAL_NUMBER",
      "REPLACEMENT_TOMBO_NOT_ALLOWED",
      "INVALID_EVIDENCE",
      "INVALID_JUSTIFICATION",
      "INVALID_OCCURRED_AT",
      "INVALID_ACTOR_USER_ID",
      "INVALID_TEAM_CONTEXT",
      "IDEMPOTENCY_KEY_CONFLICT",
      "ACTOR_NOT_AUTHORIZED",
      "TEAM_CONTEXT_NOT_AUTHORIZED",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
      "MAINTENANCE_REQUEST_NOT_LINKED_TO_PATRIMONY",
      "MAINTENANCE_STRATEGY_NOT_FOUND",
      "MAINTENANCE_SERVICE_ORDER_REQUIRED",
      "PATRIMONY_NOT_FOUND",
      "PATRIMONY_CLOSED",
      "PATRIMONY_WRITTEN_OFF",
      "COMPOSITION_NOT_FOUND",
      "COMPOSITION_VERSION_CONFLICT",
      "COMPOSITION_ITEM_NOT_FOUND",
      "COMPOSITION_ITEM_INCONSISTENT",
      "COMPONENT_NOT_FOUND",
      "COMPONENT_ALREADY_REMOVED",
      "COMPONENT_MATERIAL_MISMATCH",
      "COMPONENT_ENTITY_MISMATCH",
      "COMPONENT_NOT_AVAILABLE",
      "REPLACEMENT_MATERIAL_NOT_FOUND",
      "REPLACEMENT_MATERIAL_NOT_ACTIVE",
      "REPLACEMENT_MATERIAL_SAME_AS_PREVIOUS",
      "REPLACEMENT_MATERIAL_ALREADY_PRESENT",
      "REPLACEMENT_MATERIAL_CLASS_MISMATCH",
      "REPLACEMENT_MATERIAL_GROUP_INVALID",
      "TOMBABLE_COMPONENT_REQUIRES_PATRIMONY",
      "NON_TOMBABLE_COMPONENT_HAS_PATRIMONY"
    ]).has(value as ReplacePatrimonialComponentFailureReason)
  );
}
