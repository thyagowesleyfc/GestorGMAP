import { Pool } from "pg";

import type {
  GetPatrimonyCompositionHistoryResult,
  PatrimonyCompositionHistoryItem,
  PatrimonyCompositionHistoryReader,
  PatrimonyCompositionHistoryRevision,
  GetPatrimonyCompositionHistoryQuery
} from "../application/get-patrimony-composition-history";

type PatrimonyRow = {
  id: string;
  material_singular_id: string;
  material_code: string;
  material_name: string;
  responsible_entity_id: string;
  responsible_entity_code: string;
  responsible_entity_name: string;
  gre_code: string;
};

type RevisionRow = {
  composition_id: string;
  revision: number;
  material_configuration_id: string;
  configuration_code: string;
  configuration_name: string;
  configuration_type: "KIT" | "COMPOSTO";
  recorded_at: string;
  total: number;
};

type ItemRow = {
  composition_id: string;
  line_number: number;
  material_singular_id: string;
  component_patrimony_id: string | null;
  quantity: number;
  material_code: string;
  material_name: string;
  is_tombable: boolean;
  patrimonial_group_code: string | null;
};

const AUTHORIZED_TEAM_NAMES = ["Patrimônio", "Gerência"];

export class PostgresPatrimonyCompositionHistoryReader implements PatrimonyCompositionHistoryReader {
  constructor(private readonly pool: Pool) {}

  async get(
    input: GetPatrimonyCompositionHistoryQuery
  ): Promise<GetPatrimonyCompositionHistoryResult> {
    const patrimonyResult = await this.pool.query<PatrimonyRow>(
      `select p."id",
              p."material_singular_id",
              ms."code" as "material_code",
              ms."name" as "material_name",
              e."id" as "responsible_entity_id",
              e."code" as "responsible_entity_code",
              e."name" as "responsible_entity_name",
              g."code" as "gre_code"
         from "patrimony" p
         join "material_singular" ms on ms."id" = p."material_singular_id"
         join "entity" e on e."id" = p."responsible_entity_id"
         join "gre" g on g."id" = e."gre_id"
        where p."id" = $1`,
      [input.patrimonyId]
    );
    const patrimony = patrimonyResult.rows[0];

    if (patrimony === undefined) {
      return { ok: false, reason: "PATRIMONY_NOT_FOUND" };
    }

    if (!(await this.isAuthorized(input.actorUserId, patrimony.gre_code))) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED" };
    }

    const revisionsResult = await this.pool.query<RevisionRow>(
      `select pc."id" as "composition_id",
              pc."revision",
              pc."material_configuration_id",
              pc."configuration_code",
              pc."configuration_name",
              pc."configuration_type"::text as "configuration_type",
              pc."recorded_at"::text as "recorded_at",
              count(*) over()::int as "total"
         from "patrimony_composition" pc
        where pc."patrimony_id" = $1
        order by pc."revision" desc, pc."id" desc
        limit $2 offset $3`,
      [input.patrimonyId, input.limit, input.offset]
    );

    const revisionIds = revisionsResult.rows.map((revision) => revision.composition_id);
    const items = await this.loadItems(revisionIds);
    const itemsByCompositionId = new Map<string, PatrimonyCompositionHistoryItem[]>();

    for (const item of items) {
      const compositionItems = itemsByCompositionId.get(item.composition_id) ?? [];
      compositionItems.push(mapItemRow(item));
      itemsByCompositionId.set(item.composition_id, compositionItems);
    }

    const revisions = revisionsResult.rows.map<PatrimonyCompositionHistoryRevision>((revision) => ({
      compositionId: revision.composition_id,
      revision: revision.revision,
      materialConfigurationId: revision.material_configuration_id,
      configurationCode: revision.configuration_code,
      configurationName: revision.configuration_name,
      configurationType: revision.configuration_type,
      recordedAt: revision.recorded_at,
      items: itemsByCompositionId.get(revision.composition_id) ?? []
    }));

    return {
      ok: true,
      history: {
        patrimony: {
          id: patrimony.id,
          materialSingularId: patrimony.material_singular_id,
          materialCode: patrimony.material_code,
          materialName: patrimony.material_name,
          responsibleEntityId: patrimony.responsible_entity_id,
          responsibleEntityCode: patrimony.responsible_entity_code,
          responsibleEntityName: patrimony.responsible_entity_name
        },
        revisions,
        page: {
          limit: input.limit,
          offset: input.offset,
          returned: revisions.length,
          total: revisionsResult.rows[0]?.total ?? 0
        }
      }
    };
  }

  private async loadItems(compositionIds: string[]): Promise<ItemRow[]> {
    if (compositionIds.length === 0) {
      return [];
    }

    const result = await this.pool.query<ItemRow>(
      `select "composition_id",
              "line_number",
              "material_singular_id",
              "component_patrimony_id",
              "quantity",
              "material_code",
              "material_name",
              "is_tombable",
              "patrimonial_group_code"
         from "patrimony_composition_item"
        where "composition_id" = any($1::uuid[])
        order by "composition_id", "line_number", "id"`,
      [compositionIds]
    );
    return result.rows;
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

function mapItemRow(row: ItemRow): PatrimonyCompositionHistoryItem {
  return {
    lineNumber: row.line_number,
    materialSingularId: row.material_singular_id,
    componentPatrimonyId: row.component_patrimony_id,
    quantity: row.quantity,
    materialCode: row.material_code,
    materialName: row.material_name,
    isTombable: row.is_tombable,
    patrimonialGroupCode: row.patrimonial_group_code
  };
}
