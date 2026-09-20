import { describe, expect, it } from "vitest";

import { buildXlsxWorkbook } from "../../../src/shared/export/xlsx-workbook";

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

describe("buildXlsxWorkbook", () => {
  it("creates a minimal XLSX package with escaped values and typed cells", () => {
    const workbook = buildXlsxWorkbook([
      {
        name: "Dados",
        columns: [
          { key: "codigo", header: "Código" },
          { key: "ativo", header: "Ativo" },
          { key: "quantidade", header: "Quantidade" },
          { key: "observacao", header: "Observação" }
        ],
        rows: [
          {
            codigo: "A&B<1>",
            ativo: true,
            quantidade: 3,
            observacao: null
          }
        ]
      }
    ]);

    const entries = readStoredZipEntries(workbook);

    expect(workbook.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(entries.get("[Content_Types].xml")).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
    );
    expect(entries.get("xl/workbook.xml")).toContain('name="Dados"');
    expect(entries.get("xl/worksheets/sheet1.xml")).toContain("Código");
    expect(entries.get("xl/worksheets/sheet1.xml")).toContain("A&amp;B&lt;1&gt;");
    expect(entries.get("xl/worksheets/sheet1.xml")).toContain('<c r="B2" t="b"><v>1</v></c>');
    expect(entries.get("xl/worksheets/sheet1.xml")).toContain('<c r="C2"><v>3</v></c>');
    expect(entries.get("xl/worksheets/sheet1.xml")).toContain('<c r="D2"/>');
  });

  it("rejects invalid sheet definitions", () => {
    expect(() => buildXlsxWorkbook([])).toThrow(/at least one sheet/);
    expect(() =>
      buildXlsxWorkbook([
        {
          name: "",
          columns: [{ key: "codigo", header: "Código" }],
          rows: []
        }
      ])
    ).toThrow(/cannot be blank/);
    expect(() =>
      buildXlsxWorkbook([
        {
          name: "Dados",
          columns: [],
          rows: []
        }
      ])
    ).toThrow(/requires at least one column/);
  });
});
