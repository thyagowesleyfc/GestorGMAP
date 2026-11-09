import { Pool } from "pg";

import type {
  EntityPatrimonyInventoryEntry,
  EntityPatrimonyInventoryReader,
  GetEntityPatrimonyInventoryQuery,
  GetEntityPatrimonyInventoryResult
} from "../application/get-entity-patrimony-inventory";

type EntityRow = {
  id: string;
  code: string;
  name: string;
  gre_code: string;
};

type InventoryRow = {
  patrimony_id: string;
  material_singular_id: string;
  material_code: string;
  material_name: string;
  control_type: "INDIVIDUAL" | "QUANTITATIVO" | "CONSUMO";
  is_tombable: boolean;
  operational_state: EntityPatrimonyInventoryEntry["operationalState"];
  incorporated_at: string | null;
  active_tombo_id: string | null;
  active_tombo: string | null;
  active_tombo_group_code: string | null;
  active_tombo_issued_at: string | null;
  composition_revision: number | null;
  composition_code: string | null;
  composition_name: string | null;
  composition_type: "KIT" | "COMPOSTO" | null;
  composition_recorded_at: string | null;
  total: number;
};

const AUTHORIZED_TEAM_NAMES = ["Patrimônio", "Gerência"];

export class PostgresEntityPatrimonyInventoryReader implements EntityPatrimonyInventoryReader {
  constructor(private readonly pool: Pool) {}

  async get(input: GetEntityPatrimonyInventoryQuery): Promise<GetEntityPatrimonyInventoryResult> {
    const entityResult = await this.pool.query<EntityRow>(
      `select e."id", e."code", e."name", g."code" as "gre_code"
         from "entity" e
         join "gre" g on g."id" = e."gre_id"
        where e."id" = $1`,
      [input.entityId]
    );
    const entity = entityResult.rows[0];

    if (entity === undefined) {
      return { ok: false, reason: "ENTITY_NOT_FOUND" };
    }

    if (!(await this.isAuthorized(input.actorUserId, entity.gre_code))) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED" };
    }

    const inventoryResult = await this.pool.query<InventoryRow>(
      `select p."id" as "patrimony_id",
              p."material_singular_id",
              ms."code" as "material_code",
              ms."name" as "material_name",
              ms."control_type"::text as "control_type",
              ms."is_tombable",
              p."operational_state"::text as "operational_state",
              p."incorporated_at"::text as "incorporated_at",
              active_tombo."id" as "active_tombo_id",
              active_tombo."tombo" as "active_tombo",
              active_tombo."patrimonial_group_code" as "active_tombo_group_code",
              active_tombo."issued_at"::text as "active_tombo_issued_at",
              latest_composition."revision" as "composition_revision",
              latest_composition."configuration_code" as "composition_code",
              latest_composition."configuration_name" as "composition_name",
              latest_composition."configuration_type"::text as "composition_type",
              latest_composition."recorded_at"::text as "composition_recorded_at",
              count(*) over()::int as "total"
         from "patrimony" p
         join "material_singular" ms on ms."id" = p."material_singular_id"
         left join lateral (
           select pt."id", pt."tombo", pt."patrimonial_group_code", pt."issued_at"
             from "patrimony_tombo" pt
            where pt."patrimony_id" = p."id"
              and pt."status" = 'ATIVO'
              and pt."retired_at" is null
            order by pt."issued_at" desc, pt."id" desc
            limit 1
         ) active_tombo on true
         left join lateral (
           select pc."revision", pc."configuration_code", pc."configuration_name",
                  pc."configuration_type", pc."recorded_at", pc."id"
             from "patrimony_composition" pc
            where pc."patrimony_id" = p."id"
            order by pc."revision" desc, pc."id" desc
            limit 1
         ) latest_composition on true
        where p."responsible_entity_id" = $1
          and ($2::boolean or p."operational_state" <> 'BAIXADO')
          and ($3::varchar is null or ms."code" = $3)
          and (
            cardinality($4::text[]) = 0
            or p."operational_state"::text = any($4::text[])
          )
        order by ms."code" asc, active_tombo."tombo" asc nulls last, p."id" asc
        limit $5 offset $6`,
      [
        input.entityId,
        input.includeWrittenOff,
        input.materialCode,
        input.operationalStates,
        input.limit,
        input.offset
      ]
    );

    const entries = inventoryResult.rows.map(mapInventoryRow);

    return {
      ok: true,
      inventory: {
        entity: {
          id: entity.id,
          code: entity.code,
          name: entity.name,
          greCode: entity.gre_code
        },
        entries,
        page: {
          limit: input.limit,
          offset: input.offset,
          returned: entries.length,
          total: inventoryResult.rows[0]?.total ?? 0
        }
      }
    };
  }

  private async isAuthorized(actorUserId: string, greCode: string): Promise<boolean> {
    const authorization = await this.pool.query<{ authorized: boolean }>(
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

function mapInventoryRow(row: InventoryRow): EntityPatrimonyInventoryEntry {
  return {
    patrimonyId: row.patrimony_id,
    materialSingularId: row.material_singular_id,
    materialCode: row.material_code,
    materialName: row.material_name,
    controlType: row.control_type,
    isTombable: row.is_tombable,
    operationalState: row.operational_state,
    incorporatedAt: row.incorporated_at,
    activeTombo:
      row.active_tombo_id === null ||
      row.active_tombo === null ||
      row.active_tombo_group_code === null ||
      row.active_tombo_issued_at === null
        ? null
        : {
            id: row.active_tombo_id,
            tombo: row.active_tombo,
            patrimonialGroupCode: row.active_tombo_group_code,
            issuedAt: row.active_tombo_issued_at
          },
    latestComposition:
      row.composition_revision === null ||
      row.composition_code === null ||
      row.composition_name === null ||
      row.composition_type === null ||
      row.composition_recorded_at === null
        ? null
        : {
            revision: row.composition_revision,
            configurationCode: row.composition_code,
            configurationName: row.composition_name,
            configurationType: row.composition_type,
            recordedAt: row.composition_recorded_at
          }
  };
}
