export type GreGmapExportRow = {
  codigo_gre: string;
  nome_gre: string;
  ativo: boolean;
};

export type MunicipioGmapExportRow = {
  codigo_ibge_municipio: string;
  nome_municipio: string;
  codigo_gre: string;
  nome_gre: string;
  ativo: boolean;
};

export type EntidadeGmapExportRow = {
  codigo_entidade: string;
  nome_entidade: string;
  tipo_entidade:
    | "ESCOLA"
    | "ANEXO"
    | "SALA_ESCOLAR_AVULSA"
    | "SECRETARIA"
    | "SUPERINTENDENCIA"
    | "DIRETORIA"
    | "GERENCIA"
    | "COORDENACAO"
    | "UNIDADE"
    | "REGIONAL_GRE"
    | "SETOR"
    | "PREFEITURA"
    | "ASSOCIACAO"
    | "INSTITUICAO_FILANTROPICA";
  codigo_gre: string;
  nome_gre: string;
  codigo_ibge_municipio: string | null;
  nome_municipio: string | null;
  codigo_entidade_pai: string | null;
  nome_entidade_pai: string | null;
  ativo: boolean;
};

export type EntitiesGmapExportData = {
  gres: GreGmapExportRow[];
  municipios: MunicipioGmapExportRow[];
  entidades: EntidadeGmapExportRow[];
};

export type EntitiesGmapExportReader = {
  read(): Promise<EntitiesGmapExportData>;
};
