import { describe, expect, it } from "vitest";

import { buildMaterialsGmapWorkbook } from "../../../src/modules/catalog/application/materials-gmap-export-workbook";
import { XLSX_CONTENT_TYPE } from "../../../src/shared/export/xlsx-workbook";

function readStoredZipEntries(content: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;

  while (content.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = content.readUInt32LE(offset + 18);
    const fileNameLength = content.readUInt16LE(offset + 26);
    const extraLength = content.readUInt16LE(offset + 28);
    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    const dataStart = fileNameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;

    entries.set(
      content.subarray(fileNameStart, fileNameEnd).toString("utf8"),
      content.subarray(dataStart, dataEnd).toString("utf8")
    );

    offset = dataEnd;
  }

  return entries;
}

describe("buildMaterialsGmapWorkbook", () => {
  it("creates materiais_gmap.xlsx with catalog sheets and public-code columns", () => {
    const workbook = buildMaterialsGmapWorkbook({
      classes: [
        {
          codigo_classe: "INFORMATICA",
          nome_classe: "Informática",
          ativo: true
        }
      ],
      materiaisSingulares: [
        {
          codigo_material: "MAT-MONITOR",
          nome_material: "Monitor",
          codigo_classe: "INFORMATICA",
          nome_classe: "Informática",
          tipo_controle: "INDIVIDUAL",
          tombavel: true,
          codigo_grupo_patrimonial: "EQUIPAMENTO",
          permite_manutencao_corretiva: true,
          permite_manutencao_preventiva: false,
          permite_recondicionamento: false,
          permite_substituicao: true,
          ativo: true
        }
      ],
      configuracoes: [
        {
          codigo_configuracao: "CFG-MICRO",
          nome_configuracao: "Microcomputador",
          tipo_configuracao: "COMPOSTO",
          ativo: true
        }
      ],
      componentes: [
        {
          codigo_configuracao: "CFG-MICRO",
          codigo_material_singular: "MAT-MONITOR",
          quantidade: 1
        }
      ]
    });

    const entries = readStoredZipEntries(workbook.content);
    const workbookXml = entries.get("xl/workbook.xml") ?? "";
    const firstSheetXml = entries.get("xl/worksheets/sheet1.xml") ?? "";
    const secondSheetXml = entries.get("xl/worksheets/sheet2.xml") ?? "";

    expect(workbook.filename).toBe("materiais_gmap.xlsx");
    expect(workbook.contentType).toBe(XLSX_CONTENT_TYPE);
    expect(workbookXml).toContain('name="Classes"');
    expect(workbookXml).toContain('name="Materiais singulares"');
    expect(workbookXml).toContain('name="Configurações"');
    expect(workbookXml).toContain('name="Componentes"');
    expect(firstSheetXml).toContain("Código da classe");
    expect(firstSheetXml).toContain("INFORMATICA");
    expect(secondSheetXml).toContain("Código do grupo patrimonial");
    expect(secondSheetXml).toContain("MAT-MONITOR");
    expect(`${firstSheetXml}${secondSheetXml}`).not.toMatch(
      /\b(id|class_id|material_singular_id)\b/i
    );
  });
});
