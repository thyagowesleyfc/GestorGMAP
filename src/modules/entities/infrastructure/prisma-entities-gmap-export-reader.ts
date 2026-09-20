import type { PrismaClient } from "@prisma/client";

import type {
  EntidadeGmapExportRow,
  EntitiesGmapExportData,
  EntitiesGmapExportReader,
  GreGmapExportRow,
  MunicipioGmapExportRow
} from "../application/entities-gmap-export-reader";

type PrismaEntitiesGmapExportClient = Pick<PrismaClient, "$queryRaw">;

export class PrismaEntitiesGmapExportReader implements EntitiesGmapExportReader {
  constructor(private readonly prisma: PrismaEntitiesGmapExportClient) {}

  async read(): Promise<EntitiesGmapExportData> {
    const [gres, municipios, entidades] = await Promise.all([
      this.readGres(),
      this.readMunicipios(),
      this.readEntidades()
    ]);

    return {
      gres,
      municipios,
      entidades
    };
  }

  private async readGres(): Promise<GreGmapExportRow[]> {
    return this.prisma.$queryRaw<GreGmapExportRow[]>`
      SELECT
        "code" AS "codigo_gre",
        "name" AS "nome_gre",
        "active" AS "ativo"
      FROM "gre"
      ORDER BY "code" ASC
    `;
  }

  private async readMunicipios(): Promise<MunicipioGmapExportRow[]> {
    return this.prisma.$queryRaw<MunicipioGmapExportRow[]>`
      SELECT
        municipality."ibge_code" AS "codigo_ibge_municipio",
        municipality."name" AS "nome_municipio",
        gre."code" AS "codigo_gre",
        gre."name" AS "nome_gre",
        municipality."active" AS "ativo"
      FROM "municipality" municipality
      JOIN "gre" gre ON gre."id" = municipality."gre_id"
      ORDER BY municipality."ibge_code" ASC
    `;
  }

  private async readEntidades(): Promise<EntidadeGmapExportRow[]> {
    return this.prisma.$queryRaw<EntidadeGmapExportRow[]>`
      SELECT
        entity."code" AS "codigo_entidade",
        entity."name" AS "nome_entidade",
        entity."entity_type"::text AS "tipo_entidade",
        gre."code" AS "codigo_gre",
        gre."name" AS "nome_gre",
        municipality."ibge_code" AS "codigo_ibge_municipio",
        municipality."name" AS "nome_municipio",
        parent."code" AS "codigo_entidade_pai",
        parent."name" AS "nome_entidade_pai",
        entity."active" AS "ativo"
      FROM "entity" entity
      JOIN "gre" gre ON gre."id" = entity."gre_id"
      LEFT JOIN "municipality" municipality ON municipality."id" = entity."municipality_id"
      LEFT JOIN "entity" parent ON parent."id" = entity."parent_entity_id"
      ORDER BY entity."code" ASC
    `;
  }
}
