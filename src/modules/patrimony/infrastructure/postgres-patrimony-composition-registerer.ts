import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  PatrimonyCompositionRegisterer,
  RegisterPatrimonyCompositionCommand,
  RegisterPatrimonyCompositionResult
} from "../application/register-patrimony-composition";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RegisterPatrimonyCompositionResult }
  | { kind: "CONFLICT" };

type PatrimonyRow = {
  id: string;
  responsible_entity_id: string;
  gre_code: string;
};

type ConfigurationRow = {
  id: string;
  code: string;
  name: string;
  configuration_type: "KIT" | "COMPOSTO";
  active: boolean;
};

type ConfigurationComponentRow = {
  material_singular_id: string;
  quantity: number;
  material_code: string;
  material_name: string;
  is_tombable: boolean;
  patrimonial_group_code: string | null;
};

type ComponentPatrimonyRow = {
  id: string;
  material_singular_id: string;
  responsible_entity_id: string;
  has_active_tombo: boolean;
};

const REGISTER_COMPOSITION_COMMAND = "patrimony.register_composition";
const COMPOSITION_REGISTERED_EVENT = "patrimony.composition_registered";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio", "Gerência"];

export class PostgresPatrimonyCompositionRegisterer implements PatrimonyCompositionRegisterer {
  constructor(private readonly pool: Pool) {}

  async register(
    input: RegisterPatrimonyCompositionCommand
  ): Promise<RegisterPatrimonyCompositionResult> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      await client.query(`select pg_advisory_xact_lock(874610321)`);

      const reservation = await this.reserveIdempotency(client, input);
      if (reservation.kind === "REPLAY") {
        await client.query("commit");
        return reservation.result;
      }

      if (reservation.kind === "CONFLICT") {
        await client.query("commit");
        return { ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT", patrimonyId: input.patrimonyId };
      }

      const result = await this.registerInTransaction(client, input);
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
    input: RegisterPatrimonyCompositionCommand
  ): Promise<IdempotencyReservation> {
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [randomUUID(), REGISTER_COMPOSITION_COMMAND, input.commandId, hashRegisterCommand(input)]
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
      [REGISTER_COMPOSITION_COMMAND, input.commandId]
    );
    const row = existing.rows[0];

    if (row === undefined || row.request_hash !== hashRegisterCommand(input)) {
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
    result: RegisterPatrimonyCompositionResult
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

  private async registerInTransaction(
    client: PoolClient,
    input: RegisterPatrimonyCompositionCommand
  ): Promise<RegisterPatrimonyCompositionResult> {
    const patrimonyResult = await client.query<PatrimonyRow>(
      `select p."id", p."responsible_entity_id", g."code" as "gre_code"
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

    if (!(await this.isAuthorized(client, input.actorUserId, patrimony.gre_code))) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED", patrimonyId: input.patrimonyId };
    }

    const configurationResult = await client.query<ConfigurationRow>(
      `select "id", "code", "name", "configuration_type"::text as "configuration_type", "active"
         from "material_configuration"
        where "id" = $1
        for share`,
      [input.materialConfigurationId]
    );
    const configuration = configurationResult.rows[0];

    if (configuration === undefined) {
      return {
        ok: false,
        reason: "MATERIAL_CONFIGURATION_NOT_FOUND",
        patrimonyId: input.patrimonyId
      };
    }

    if (!configuration.active) {
      return {
        ok: false,
        reason: "MATERIAL_CONFIGURATION_NOT_ACTIVE",
        patrimonyId: input.patrimonyId
      };
    }

    const componentResult = await client.query<ConfigurationComponentRow>(
      `select mcc."material_singular_id",
              mcc."quantity",
              ms."code" as "material_code",
              ms."name" as "material_name",
              ms."is_tombable",
              ms."patrimonial_group_code"
         from "material_configuration_component" mcc
         join "material_singular" ms on ms."id" = mcc."material_singular_id"
        where mcc."configuration_id" = $1
        order by mcc."id"
        for share of mcc, ms`,
      [configuration.id]
    );
    const configurationComponents = componentResult.rows;

    if (configurationComponents.length === 0) {
      return {
        ok: false,
        reason: "MATERIAL_CONFIGURATION_WITHOUT_COMPONENTS",
        patrimonyId: input.patrimonyId
      };
    }

    const requestedByMaterialId = new Map(
      input.components.map((component) => [component.materialSingularId, component])
    );
    if (
      requestedByMaterialId.size !== configurationComponents.length ||
      configurationComponents.some(
        (component) => !requestedByMaterialId.has(component.material_singular_id)
      )
    ) {
      return { ok: false, reason: "COMPONENT_SET_MISMATCH", patrimonyId: input.patrimonyId };
    }

    const componentPatrimonyIds = input.components
      .map((component) => component.componentPatrimonyId)
      .filter((id): id is string => id !== undefined);

    const componentPatrimonies = await this.loadComponentPatrimonies(client, componentPatrimonyIds);
    const componentPatrimonyById = new Map(
      componentPatrimonies.map((component) => [component.id, component])
    );

    for (const component of configurationComponents) {
      const requested = requestedByMaterialId.get(component.material_singular_id);
      if (requested === undefined) {
        return { ok: false, reason: "COMPONENT_SET_MISMATCH", patrimonyId: input.patrimonyId };
      }

      if (component.is_tombable && component.quantity !== 1) {
        return {
          ok: false,
          reason: "TOMBABLE_COMPONENT_QUANTITY_UNSUPPORTED",
          patrimonyId: input.patrimonyId,
          materialSingularId: component.material_singular_id
        };
      }

      if (component.is_tombable && requested.componentPatrimonyId === undefined) {
        return {
          ok: false,
          reason: "TOMBABLE_COMPONENT_REQUIRES_PATRIMONY",
          patrimonyId: input.patrimonyId,
          materialSingularId: component.material_singular_id
        };
      }

      if (!component.is_tombable && requested.componentPatrimonyId !== undefined) {
        return {
          ok: false,
          reason: "NON_TOMBABLE_COMPONENT_CANNOT_HAVE_PATRIMONY",
          patrimonyId: input.patrimonyId,
          materialSingularId: component.material_singular_id
        };
      }

      if (requested.componentPatrimonyId === undefined) {
        continue;
      }

      const componentPatrimony = componentPatrimonyById.get(requested.componentPatrimonyId);
      if (componentPatrimony === undefined) {
        return {
          ok: false,
          reason: "COMPONENT_PATRIMONY_NOT_FOUND",
          patrimonyId: input.patrimonyId,
          materialSingularId: component.material_singular_id
        };
      }

      if (componentPatrimony.material_singular_id !== component.material_singular_id) {
        return {
          ok: false,
          reason: "COMPONENT_PATRIMONY_MATERIAL_MISMATCH",
          patrimonyId: input.patrimonyId,
          materialSingularId: component.material_singular_id
        };
      }

      if (componentPatrimony.responsible_entity_id !== patrimony.responsible_entity_id) {
        return {
          ok: false,
          reason: "COMPONENT_PATRIMONY_ENTITY_MISMATCH",
          patrimonyId: input.patrimonyId,
          materialSingularId: component.material_singular_id
        };
      }

      if (!componentPatrimony.has_active_tombo) {
        return {
          ok: false,
          reason: "COMPONENT_PATRIMONY_WITHOUT_ACTIVE_TOMBO",
          patrimonyId: input.patrimonyId,
          materialSingularId: component.material_singular_id
        };
      }
    }

    if (componentPatrimonyIds.includes(input.patrimonyId)) {
      return {
        ok: false,
        reason: "COMPONENT_PATRIMONY_SELF_REFERENCE",
        patrimonyId: input.patrimonyId
      };
    }

    const nestedComposition = await client.query<{ exists: boolean }>(
      `select exists(
         select 1
           from "patrimony_composition"
          where "patrimony_id" = any($1::uuid[])
       ) as "exists"`,
      [componentPatrimonyIds]
    );
    if (nestedComposition.rows[0]?.exists === true) {
      return {
        ok: false,
        reason: "NESTED_COMPONENT_COMPOSITION_NOT_SUPPORTED",
        patrimonyId: input.patrimonyId
      };
    }

    const attachedComponent = await client.query<{ exists: boolean }>(
      `select exists(
         select 1
           from "patrimony_composition_item" pci
           join "patrimony_composition" pc on pc."id" = pci."composition_id"
          where pci."component_patrimony_id" = any($1::uuid[])
            and pc."patrimony_id" <> $2
       ) as "exists"`,
      [componentPatrimonyIds, input.patrimonyId]
    );
    if (attachedComponent.rows[0]?.exists === true) {
      return {
        ok: false,
        reason: "COMPONENT_PATRIMONY_ALREADY_ATTACHED",
        patrimonyId: input.patrimonyId
      };
    }

    const revisionResult = await client.query<{ revision: number }>(
      `select coalesce(max("revision"), 0) + 1 as "revision"
         from "patrimony_composition"
        where "patrimony_id" = $1`,
      [input.patrimonyId]
    );
    const revision = revisionResult.rows[0]?.revision;
    if (revision === undefined) {
      throw new Error("Could not calculate patrimony composition revision.");
    }

    const compositionId = randomUUID();
    await client.query(
      `insert into "patrimony_composition" (
        "id", "patrimony_id", "revision", "material_configuration_id",
        "configuration_code", "configuration_name", "configuration_type",
        "recorded_at", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, $7::"MaterialConfigurationType", $8, current_timestamp)`,
      [
        compositionId,
        input.patrimonyId,
        revision,
        configuration.id,
        configuration.code,
        configuration.name,
        configuration.configuration_type,
        input.recordedAt
      ]
    );

    for (const [index, component] of configurationComponents.entries()) {
      const requested = requestedByMaterialId.get(component.material_singular_id);
      if (requested === undefined) {
        throw new Error("Component set changed during composition registration.");
      }

      await client.query(
        `insert into "patrimony_composition_item" (
          "id", "composition_id", "line_number", "material_singular_id",
          "component_patrimony_id", "quantity", "material_code", "material_name",
          "is_tombable", "patrimonial_group_code", "updated_at"
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, current_timestamp)`,
        [
          randomUUID(),
          compositionId,
          index + 1,
          component.material_singular_id,
          requested.componentPatrimonyId ?? null,
          component.quantity,
          component.material_code,
          component.material_name,
          component.is_tombable,
          component.patrimonial_group_code
        ]
      );
    }

    const nextValue = {
      compositionId,
      patrimonyId: input.patrimonyId,
      revision,
      materialConfigurationId: configuration.id,
      configurationCode: configuration.code,
      configurationType: configuration.configuration_type,
      itemCount: configurationComponents.length,
      recordedAt: input.recordedAt.toISOString(),
      correlationId: input.correlationId
    };

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, null, $8::jsonb, $9, $10)`,
      [
        randomUUID(),
        input.recordedAt,
        input.actorUserId,
        input.teamContext,
        REGISTER_COMPOSITION_COMMAND,
        "patrimony_composition",
        compositionId,
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
        COMPOSITION_REGISTERED_EVENT,
        "patrimony",
        input.patrimonyId,
        JSON.stringify({
          compositionId,
          patrimonyId: input.patrimonyId,
          revision,
          itemCount: configurationComponents.length,
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      compositionId,
      patrimonyId: input.patrimonyId,
      revision,
      itemCount: configurationComponents.length
    };
  }

  private async loadComponentPatrimonies(
    client: PoolClient,
    ids: string[]
  ): Promise<ComponentPatrimonyRow[]> {
    if (ids.length === 0) {
      return [];
    }

    const result = await client.query<ComponentPatrimonyRow>(
      `select p."id", p."material_singular_id", p."responsible_entity_id",
              exists(
                select 1 from "patrimony_tombo" pt
                 where pt."patrimony_id" = p."id"
                   and pt."status" = 'ATIVO'
              ) as "has_active_tombo"
         from "patrimony" p
        where p."id" = any($1::uuid[])
        for update of p`,
      [ids]
    );
    return result.rows;
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

function hashRegisterCommand(input: RegisterPatrimonyCompositionCommand): string {
  const payload = {
    patrimonyId: input.patrimonyId,
    materialConfigurationId: input.materialConfigurationId,
    components: input.components,
    reason: input.reason,
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RegisterPatrimonyCompositionResult {
  if (isRegisterPatrimonyCompositionResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isRegisterPatrimonyCompositionResult(
  value: unknown
): value is RegisterPatrimonyCompositionResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return (
      typeof (value as { compositionId?: unknown }).compositionId === "string" &&
      typeof (value as { patrimonyId?: unknown }).patrimonyId === "string" &&
      typeof (value as { revision?: unknown }).revision === "number" &&
      typeof (value as { itemCount?: unknown }).itemCount === "number"
    );
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
