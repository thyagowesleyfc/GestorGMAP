import { Pool } from "pg";

import type {
  GetPatrimonyTimelineResult,
  PatrimonyTimelineEvent,
  PatrimonyTimelineEventType,
  PatrimonyTimelineReader,
  GetPatrimonyTimelineQuery
} from "../application/get-patrimony-timeline";

type PatrimonyRow = {
  id: string;
  material_singular_id: string;
  material_code: string;
  material_name: string;
  responsible_entity_id: string;
  responsible_entity_code: string;
  responsible_entity_name: string;
  operational_state: "EM_USO" | "RECOLHIDO" | "EM_MANUTENCAO" | "BAIXADO";
  gre_code: string;
};

type TimelineRow = {
  event_id: string;
  occurred_at: string;
  event_type: PatrimonyTimelineEventType;
  reference_id: string;
  correlation_id: string | null;
  details: Record<string, unknown>;
  total: number;
};

const AUTHORIZED_TEAM_NAMES = ["Patrimônio", "Gerência"];

export class PostgresPatrimonyTimelineReader implements PatrimonyTimelineReader {
  constructor(private readonly pool: Pool) {}

  async get(input: GetPatrimonyTimelineQuery): Promise<GetPatrimonyTimelineResult> {
    const patrimonyResult = await this.pool.query<PatrimonyRow>(
      `select p."id",
              p."material_singular_id",
              ms."code" as "material_code",
              ms."name" as "material_name",
              e."id" as "responsible_entity_id",
              e."code" as "responsible_entity_code",
              e."name" as "responsible_entity_name",
              p."operational_state"::text as "operational_state",
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

    const timelineResult = await this.pool.query<TimelineRow>(
      `with timeline_events as (
        select 'incorporacao:' || p."id" as "event_id",
               p."incorporated_at" as "occurred_at",
               'INCORPORACAO'::text as "event_type",
               p."id"::text as "reference_id",
               incorporation_audit."correlation_id",
               jsonb_build_object(
                 'sourceDeliveryId', p."source_delivery_id",
                 'sourceShipmentItemId', p."source_shipment_item_id"
               ) as "details"
          from "patrimony" p
          left join lateral (
            select ae."correlation_id"
              from "audit_entry" ae
             where ae."object_type" = 'patrimony'
               and ae."object_id" = p."id"::text
               and ae."action" = 'patrimony.incorporate_from_delivery'
             order by ae."occurred_at" desc, ae."id" desc
             limit 1
          ) incorporation_audit on true
         where p."id" = $1
           and p."incorporated_at" is not null

        union all

        select 'tombo-gerado:' || pt."id" as "event_id",
               pt."issued_at" as "occurred_at",
               'TOMBO_GERADO'::text as "event_type",
               pt."id"::text as "reference_id",
               null::varchar as "correlation_id",
               jsonb_build_object(
                 'tombo', pt."tombo",
                 'patrimonialGroupCode', pt."patrimonial_group_code"
               ) as "details"
          from "patrimony_tombo" pt
         where pt."patrimony_id" = $1

        union all

        select 'tombo-encerrado:' || pt."id" as "event_id",
               pt."retired_at" as "occurred_at",
               'TOMBO_ENCERRADO'::text as "event_type",
               pt."id"::text as "reference_id",
               null::varchar as "correlation_id",
               jsonb_build_object(
                 'tombo', pt."tombo",
                 'retirementReason', pt."retirement_reason"
               ) as "details"
          from "patrimony_tombo" pt
         where pt."patrimony_id" = $1
           and pt."retired_at" is not null

        union all

        select 'composicao:' || pc."id" as "event_id",
               pc."recorded_at" as "occurred_at",
               'COMPOSICAO_REGISTRADA'::text as "event_type",
               pc."id"::text as "reference_id",
               composition_audit."correlation_id",
               jsonb_build_object(
                 'revision', pc."revision",
                 'configurationCode', pc."configuration_code",
                 'configurationName', pc."configuration_name",
                 'configurationType', pc."configuration_type"::text
               ) as "details"
          from "patrimony_composition" pc
          left join lateral (
            select ae."correlation_id"
              from "audit_entry" ae
             where ae."object_type" = 'patrimony_composition'
               and ae."object_id" = pc."id"::text
               and ae."action" = 'patrimony.register_composition'
             order by ae."occurred_at" desc, ae."id" desc
             limit 1
          ) composition_audit on true
         where pc."patrimony_id" = $1

        union all

        select 'movimento:' || pm."id" as "event_id",
               pm."occurred_at" as "occurred_at",
               'MOVIMENTO'::text as "event_type",
               pm."id"::text as "reference_id",
               pm."correlation_id",
               jsonb_build_object(
                 'movementType', pm."movement_type"::text,
                 'reason', pm."reason",
                 'fromEntity', jsonb_build_object(
                   'id', from_entity."id",
                   'code', from_entity."code",
                   'name', from_entity."name"
                 ),
                 'toEntity', jsonb_build_object(
                   'id', to_entity."id",
                   'code', to_entity."code",
                   'name', to_entity."name"
                 ),
                 'logisticsRecollectionId', pm."logistics_recollection_id"
               ) as "details"
          from "patrimony_movement" pm
          join "entity" from_entity on from_entity."id" = pm."from_entity_id"
          join "entity" to_entity on to_entity."id" = pm."to_entity_id"
         where pm."patrimony_id" = $1

        union all

        select 'baixa:' || pwo."id" as "event_id",
               pwo."occurred_at" as "occurred_at",
               'BAIXA'::text as "event_type",
               pwo."id"::text as "reference_id",
               pwo."correlation_id",
               jsonb_build_object(
                 'reason', pwo."reason"::text,
                 'justification', pwo."justification",
                 'procedureOrReportReference', pwo."procedure_or_report_reference",
                 'authorizationReference', pwo."authorization_reference"
               ) as "details"
          from "patrimony_write_off" pwo
         where pwo."patrimony_id" = $1

        union all

        select 'retificacao:' || ae."id" as "event_id",
               ae."occurred_at" as "occurred_at",
               'RETIFICACAO'::text as "event_type",
               ae."id"::text as "reference_id",
               ae."correlation_id",
               jsonb_build_object(
                 'reason', ae."reason",
                 'previous', ae."previous_value",
                 'next', ae."next_value"
               ) as "details"
          from "audit_entry" ae
         where ae."object_type" = 'patrimony'
           and ae."object_id" = $1::text
           and ae."action" = 'patrimony.retificar'
      )
      select "event_id", "occurred_at"::text, "event_type", "reference_id",
             "correlation_id", "details", count(*) over()::int as "total"
        from timeline_events
       order by "occurred_at" desc, "event_id" desc
       limit $2 offset $3`,
      [input.patrimonyId, input.limit, input.offset]
    );

    const entries = timelineResult.rows.map<PatrimonyTimelineEvent>((row) => ({
      id: row.event_id,
      occurredAt: row.occurred_at,
      eventType: row.event_type,
      referenceId: row.reference_id,
      correlationId: row.correlation_id,
      details: row.details
    }));

    return {
      ok: true,
      timeline: {
        patrimony: {
          id: patrimony.id,
          materialSingularId: patrimony.material_singular_id,
          materialCode: patrimony.material_code,
          materialName: patrimony.material_name,
          responsibleEntityId: patrimony.responsible_entity_id,
          responsibleEntityCode: patrimony.responsible_entity_code,
          responsibleEntityName: patrimony.responsible_entity_name,
          operationalState: patrimony.operational_state
        },
        entries,
        page: {
          limit: input.limit,
          offset: input.offset,
          returned: entries.length,
          total: timelineResult.rows[0]?.total ?? 0
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
