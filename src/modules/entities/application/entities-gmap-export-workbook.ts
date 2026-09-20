import {
  buildXlsxWorkbook,
  XLSX_CONTENT_TYPE,
  type XlsxColumn
} from "../../../shared/export/xlsx-workbook";
import type { EntitiesGmapExportData } from "./entities-gmap-export-reader";

export type GmapWorkbookExport = {
  filename: string;
  contentType: string;
  content: Buffer;
};

const GRE_COLUMNS: XlsxColumn[] = [
  { key: "codigo_gre", header: "Código da GRE" },
  { key: "nome_gre", header: "Nome da GRE" },
  { key: "ativo", header: "Ativo" }
];

const MUNICIPALITY_COLUMNS: XlsxColumn[] = [
  { key: "codigo_ibge_municipio", header: "Código IBGE do município" },
  { key: "nome_municipio", header: "Nome do município" },
  { key: "codigo_gre", header: "Código da GRE" },
  { key: "nome_gre", header: "Nome da GRE" },
  { key: "ativo", header: "Ativo" }
];

const ENTITY_COLUMNS: XlsxColumn[] = [
  { key: "codigo_entidade", header: "Código da entidade" },
  { key: "nome_entidade", header: "Nome da entidade" },
  { key: "tipo_entidade", header: "Tipo da entidade" },
  { key: "codigo_gre", header: "Código da GRE" },
  { key: "nome_gre", header: "Nome da GRE" },
  { key: "codigo_ibge_municipio", header: "Código IBGE do município" },
  { key: "nome_municipio", header: "Nome do município" },
  { key: "codigo_entidade_pai", header: "Código da entidade pai" },
  { key: "nome_entidade_pai", header: "Nome da entidade pai" },
  { key: "ativo", header: "Ativo" }
];

export function buildEntitiesGmapWorkbook(data: EntitiesGmapExportData): GmapWorkbookExport {
  return {
    filename: "entidades_gmap.xlsx",
    contentType: XLSX_CONTENT_TYPE,
    content: buildXlsxWorkbook([
      {
        name: "GREs",
        columns: GRE_COLUMNS,
        rows: data.gres
      },
      {
        name: "Municípios",
        columns: MUNICIPALITY_COLUMNS,
        rows: data.municipios
      },
      {
        name: "Entidades",
        columns: ENTITY_COLUMNS,
        rows: data.entidades
      }
    ])
  };
}
