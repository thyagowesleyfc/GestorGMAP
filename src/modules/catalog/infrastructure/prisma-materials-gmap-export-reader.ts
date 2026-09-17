import type { PrismaClient } from "@prisma/client";

import type {
  ClasseMaterialGmapExportRow,
  ComponenteConfiguracaoMaterialGmapExportRow,
  ConfiguracaoMaterialGmapExportRow,
  MaterialsGmapExportData,
  MaterialsGmapExportReader,
  MaterialSingularGmapExportRow
} from "../application/materials-gmap-export-reader";

type PrismaMaterialsGmapExportClient = Pick<PrismaClient, "$queryRaw">;

export class PrismaMaterialsGmapExportReader implements MaterialsGmapExportReader {
  constructor(private readonly prisma: PrismaMaterialsGmapExportClient) {}

  async read(): Promise<MaterialsGmapExportData> {
    const [classes, materiaisSingulares, configuracoes, componentes] = await Promise.all([
      this.readClasses(),
      this.readMateriaisSingulares(),
      this.readConfiguracoes(),
      this.readComponentes()
    ]);

    return {
      classes,
      materiaisSingulares,
      configuracoes,
      componentes
    };
  }

  private async readClasses(): Promise<ClasseMaterialGmapExportRow[]> {
    return this.prisma.$queryRaw<ClasseMaterialGmapExportRow[]>`
      SELECT
        "code" AS "codigo_classe",
        "name" AS "nome_classe",
        "active" AS "ativo"
      FROM "material_class"
      ORDER BY "code" ASC
    `;
  }

  private async readMateriaisSingulares(): Promise<MaterialSingularGmapExportRow[]> {
    return this.prisma.$queryRaw<MaterialSingularGmapExportRow[]>`
      SELECT
        ms."code" AS "codigo_material",
        ms."name" AS "nome_material",
        mc."code" AS "codigo_classe",
        mc."name" AS "nome_classe",
        ms."control_type"::text AS "tipo_controle",
        ms."is_tombable" AS "tombavel",
        ms."patrimonial_group_code" AS "codigo_grupo_patrimonial",
        ms."allows_corrective_maintenance" AS "permite_manutencao_corretiva",
        ms."allows_preventive_maintenance" AS "permite_manutencao_preventiva",
        ms."allows_reconditioning" AS "permite_recondicionamento",
        ms."allows_replacement" AS "permite_substituicao",
        ms."active" AS "ativo"
      FROM "material_singular" ms
      JOIN "material_class" mc ON mc."id" = ms."class_id"
      ORDER BY ms."code" ASC
    `;
  }

  private async readConfiguracoes(): Promise<ConfiguracaoMaterialGmapExportRow[]> {
    return this.prisma.$queryRaw<ConfiguracaoMaterialGmapExportRow[]>`
      SELECT
        "code" AS "codigo_configuracao",
        "name" AS "nome_configuracao",
        "configuration_type"::text AS "tipo_configuracao",
        "active" AS "ativo"
      FROM "material_configuration"
      ORDER BY "code" ASC
    `;
  }

  private async readComponentes(): Promise<ComponenteConfiguracaoMaterialGmapExportRow[]> {
    return this.prisma.$queryRaw<ComponenteConfiguracaoMaterialGmapExportRow[]>`
      SELECT
        cfg."code" AS "codigo_configuracao",
        ms."code" AS "codigo_material_singular",
        component."quantity" AS "quantidade"
      FROM "material_configuration_component" component
      JOIN "material_configuration" cfg ON cfg."id" = component."configuration_id"
      JOIN "material_singular" ms ON ms."id" = component."material_singular_id"
      ORDER BY cfg."code" ASC, ms."code" ASC
    `;
  }
}
