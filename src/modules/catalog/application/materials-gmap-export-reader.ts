export type ClasseMaterialGmapExportRow = {
  codigo_classe: string;
  nome_classe: string;
  ativo: boolean;
};

export type MaterialSingularGmapExportRow = {
  codigo_material: string;
  nome_material: string;
  codigo_classe: string;
  nome_classe: string;
  tipo_controle: "INDIVIDUAL" | "QUANTITATIVO" | "CONSUMO";
  tombavel: boolean;
  codigo_grupo_patrimonial: string | null;
  permite_manutencao_corretiva: boolean;
  permite_manutencao_preventiva: boolean;
  permite_recondicionamento: boolean;
  permite_substituicao: boolean;
  ativo: boolean;
};

export type ConfiguracaoMaterialGmapExportRow = {
  codigo_configuracao: string;
  nome_configuracao: string;
  tipo_configuracao: "KIT" | "COMPOSTO";
  ativo: boolean;
};

export type ComponenteConfiguracaoMaterialGmapExportRow = {
  codigo_configuracao: string;
  codigo_material_singular: string;
  quantidade: number;
};

export type MaterialsGmapExportData = {
  classes: ClasseMaterialGmapExportRow[];
  materiaisSingulares: MaterialSingularGmapExportRow[];
  configuracoes: ConfiguracaoMaterialGmapExportRow[];
  componentes: ComponenteConfiguracaoMaterialGmapExportRow[];
};

export type MaterialsGmapExportReader = {
  read(): Promise<MaterialsGmapExportData>;
};
