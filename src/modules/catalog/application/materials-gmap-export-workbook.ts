import {
  buildXlsxWorkbook,
  XLSX_CONTENT_TYPE,
  type XlsxColumn
} from "../../../shared/export/xlsx-workbook";
import type { MaterialsGmapExportData } from "./materials-gmap-export-reader";

export type GmapWorkbookExport = {
  filename: string;
  contentType: string;
  content: Buffer;
};

const CLASS_COLUMNS: XlsxColumn[] = [
  { key: "codigo_classe", header: "Código da classe" },
  { key: "nome_classe", header: "Nome da classe" },
  { key: "ativo", header: "Ativo" }
];

const MATERIAL_SINGULAR_COLUMNS: XlsxColumn[] = [
  { key: "codigo_material", header: "Código do material" },
  { key: "nome_material", header: "Nome do material" },
  { key: "codigo_classe", header: "Código da classe" },
  { key: "nome_classe", header: "Nome da classe" },
  { key: "tipo_controle", header: "Tipo de controle" },
  { key: "tombavel", header: "Tombável" },
  { key: "codigo_grupo_patrimonial", header: "Código do grupo patrimonial" },
  { key: "permite_manutencao_corretiva", header: "Permite manutenção corretiva" },
  { key: "permite_manutencao_preventiva", header: "Permite manutenção preventiva" },
  { key: "permite_recondicionamento", header: "Permite recondicionamento" },
  { key: "permite_substituicao", header: "Permite substituição" },
  { key: "ativo", header: "Ativo" }
];

const CONFIGURATION_COLUMNS: XlsxColumn[] = [
  { key: "codigo_configuracao", header: "Código da configuração" },
  { key: "nome_configuracao", header: "Nome da configuração" },
  { key: "tipo_configuracao", header: "Tipo de configuração" },
  { key: "ativo", header: "Ativo" }
];

const COMPONENT_COLUMNS: XlsxColumn[] = [
  { key: "codigo_configuracao", header: "Código da configuração" },
  { key: "codigo_material_singular", header: "Código do material singular" },
  { key: "quantidade", header: "Quantidade" }
];

export function buildMaterialsGmapWorkbook(data: MaterialsGmapExportData): GmapWorkbookExport {
  return {
    filename: "materiais_gmap.xlsx",
    contentType: XLSX_CONTENT_TYPE,
    content: buildXlsxWorkbook([
      {
        name: "Classes",
        columns: CLASS_COLUMNS,
        rows: data.classes
      },
      {
        name: "Materiais singulares",
        columns: MATERIAL_SINGULAR_COLUMNS,
        rows: data.materiaisSingulares
      },
      {
        name: "Configurações",
        columns: CONFIGURATION_COLUMNS,
        rows: data.configuracoes
      },
      {
        name: "Componentes",
        columns: COMPONENT_COLUMNS,
        rows: data.componentes
      }
    ])
  };
}
