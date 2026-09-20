import { describe, expect, it } from "vitest";

import { buildEntitiesGmapWorkbook } from "../../../src/modules/entities/application/entities-gmap-export-workbook";
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

describe("buildEntitiesGmapWorkbook", () => {
  it("creates entidades_gmap.xlsx with GRE, municipality and entity public-code sheets", () => {
    const workbook = buildEntitiesGmapWorkbook({
      gres: [
        {
          codigo_gre: "GRE-01",
          nome_gre: "1ª Gerência Regional de Educação",
          ativo: true
        }
      ],
      municipios: [
        {
          codigo_ibge_municipio: "2211001",
          nome_municipio: "Teresina",
          codigo_gre: "GRE-01",
          nome_gre: "1ª Gerência Regional de Educação",
          ativo: true
        }
      ],
      entidades: [
        {
          codigo_entidade: "ENT-ANX-001",
          nome_entidade: "Anexo Escolar Teste",
          tipo_entidade: "ANEXO",
          codigo_gre: "GRE-01",
          nome_gre: "1ª Gerência Regional de Educação",
          codigo_ibge_municipio: "2211001",
          nome_municipio: "Teresina",
          codigo_entidade_pai: "ENT-ESC-001",
          nome_entidade_pai: "Unidade Escolar Teste",
          ativo: true
        }
      ]
    });

    const entries = readStoredZipEntries(workbook.content);
    const workbookXml = entries.get("xl/workbook.xml") ?? "";
    const firstSheetXml = entries.get("xl/worksheets/sheet1.xml") ?? "";
    const thirdSheetXml = entries.get("xl/worksheets/sheet3.xml") ?? "";

    expect(workbook.filename).toBe("entidades_gmap.xlsx");
    expect(workbook.contentType).toBe(XLSX_CONTENT_TYPE);
    expect(workbookXml).toContain('name="GREs"');
    expect(workbookXml).toContain('name="Municípios"');
    expect(workbookXml).toContain('name="Entidades"');
    expect(firstSheetXml).toContain("Código da GRE");
    expect(firstSheetXml).toContain("GRE-01");
    expect(thirdSheetXml).toContain("Código da entidade pai");
    expect(thirdSheetXml).toContain("ENT-ANX-001");
    expect(thirdSheetXml).toContain("ENT-ESC-001");
    expect(`${firstSheetXml}${thirdSheetXml}`).not.toMatch(
      /\b(id|gre_id|municipality_id|parent_entity_id)\b/i
    );
  });
});
