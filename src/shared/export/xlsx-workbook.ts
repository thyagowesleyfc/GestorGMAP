export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type XlsxCellValue = string | number | boolean | null | undefined;

export type XlsxColumn = {
  key: string;
  header: string;
};

export type XlsxSheet = {
  name: string;
  columns: readonly XlsxColumn[];
  rows: readonly object[];
};

type ZipEntry = {
  path: string;
  data: Buffer;
};

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const EMPTY_DOS_TIME = 0;
const EMPTY_DOS_DATE = 0;

const CRC32_TABLE = new Uint32Array(256);

for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let crc = index;

  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }

  CRC32_TABLE[index] = crc >>> 0;
}

export function buildXlsxWorkbook(sheets: readonly XlsxSheet[]): Buffer {
  if (sheets.length === 0) {
    throw new Error("XLSX workbook requires at least one sheet.");
  }

  sheets.forEach(validateSheet);

  const entries: ZipEntry[] = [
    createTextEntry("[Content_Types].xml", buildContentTypesXml(sheets.length)),
    createTextEntry("_rels/.rels", buildRootRelationshipsXml()),
    createTextEntry("xl/workbook.xml", buildWorkbookXml(sheets)),
    createTextEntry("xl/_rels/workbook.xml.rels", buildWorkbookRelationshipsXml(sheets.length)),
    ...sheets.map((sheet, index) =>
      createTextEntry(`xl/worksheets/sheet${index + 1}.xml`, buildWorksheetXml(sheet))
    )
  ];

  return buildStoredZip(entries);
}

function validateSheet(sheet: XlsxSheet): void {
  if (sheet.columns.length === 0) {
    throw new Error(`XLSX sheet "${sheet.name}" requires at least one column.`);
  }

  sanitizeSheetName(sheet.name);
}

function buildContentTypesXml(sheetCount: number): string {
  const worksheetOverrides = Array.from({ length: sheetCount }, (_, index) => {
    const sheetNumber = index + 1;

    return `<Override PartName="/xl/worksheets/sheet${sheetNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  }).join("");

  return `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${worksheetOverrides}</Types>`;
}

function buildRootRelationshipsXml(): string {
  return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function buildWorkbookXml(sheets: readonly XlsxSheet[]): string {
  const sheetXml = sheets
    .map((sheet, index) => {
      const sheetNumber = index + 1;

      return `<sheet name="${escapeXmlAttribute(sanitizeSheetName(sheet.name))}" sheetId="${sheetNumber}" r:id="rId${sheetNumber}"/>`;
    })
    .join("");

  return `${XML_DECLARATION}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetXml}</sheets></workbook>`;
}

function buildWorkbookRelationshipsXml(sheetCount: number): string {
  const relationships = Array.from({ length: sheetCount }, (_, index) => {
    const sheetNumber = index + 1;

    return `<Relationship Id="rId${sheetNumber}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetNumber}.xml"/>`;
  }).join("");

  return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

function buildWorksheetXml(sheet: XlsxSheet): string {
  const rows = [
    buildRowXml(
      1,
      sheet.columns.map((column) => column.header)
    )
  ];

  sheet.rows.forEach((row, rowIndex) => {
    const values = sheet.columns.map((column) => readCellValue(row, column.key));
    rows.push(buildRowXml(rowIndex + 2, values));
  });

  const lastColumn = getColumnName(sheet.columns.length);
  const lastRow = Math.max(sheet.rows.length + 1, 1);

  return `${XML_DECLARATION}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${lastRow}"/><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

function buildRowXml(rowNumber: number, values: readonly XlsxCellValue[]): string {
  const cells = values
    .map((value, columnIndex) =>
      buildCellXml(`${getColumnName(columnIndex + 1)}${rowNumber}`, value)
    )
    .join("");

  return `<row r="${rowNumber}">${cells}</row>`;
}

function buildCellXml(reference: string, value: XlsxCellValue): string {
  if (value === null || value === undefined) {
    return `<c r="${reference}"/>`;
  }

  if (typeof value === "boolean") {
    return `<c r="${reference}" t="b"><v>${value ? "1" : "0"}</v></c>`;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`XLSX cell ${reference} received a non-finite number.`);
    }

    return `<c r="${reference}"><v>${value}</v></c>`;
  }

  return `<c r="${reference}" t="inlineStr"><is><t>${escapeXmlText(value)}</t></is></c>`;
}

function readCellValue(row: object, key: string): XlsxCellValue {
  const value = (row as Record<string, unknown>)[key];

  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  throw new Error(`XLSX column "${key}" received an unsupported value.`);
}

function getColumnName(columnNumber: number): string {
  let remaining = columnNumber;
  let columnName = "";

  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    columnName = String.fromCharCode(65 + remainder) + columnName;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return columnName;
}

function sanitizeSheetName(sheetName: string): string {
  const trimmedName = sheetName.trim();

  if (trimmedName.length === 0) {
    throw new Error("XLSX sheet name cannot be blank.");
  }

  if (trimmedName.length > 31) {
    throw new Error(`XLSX sheet name "${sheetName}" exceeds 31 characters.`);
  }

  if (/[\\/?*:[\]]/.test(trimmedName)) {
    throw new Error(`XLSX sheet name "${sheetName}" contains an invalid character.`);
  }

  return trimmedName;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function createTextEntry(path: string, text: string): ZipEntry {
  return {
    path,
    data: Buffer.from(text, "utf8")
  };
}

function buildStoredZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  entries.forEach((entry) => {
    const fileName = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.data);
    const localHeader = createLocalFileHeader(fileName, entry.data, crc);

    localParts.push(localHeader, entry.data);
    centralParts.push(createCentralDirectoryHeader(fileName, entry.data, crc, offset));
    offset += localHeader.length + entry.data.length;
  });

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = createEndOfCentralDirectoryRecord(
    entries.length,
    centralDirectory.length,
    offset
  );

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function createLocalFileHeader(fileName: Buffer, data: Buffer, crc: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(EMPTY_DOS_TIME, 10);
  header.writeUInt16LE(EMPTY_DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(fileName.length, 26);
  header.writeUInt16LE(0, 28);

  return Buffer.concat([header, fileName]);
}

function createCentralDirectoryHeader(
  fileName: Buffer,
  data: Buffer,
  crc: number,
  localHeaderOffset: number
): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(EMPTY_DOS_TIME, 12);
  header.writeUInt16LE(EMPTY_DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(fileName.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localHeaderOffset, 42);

  return Buffer.concat([header, fileName]);
}

function createEndOfCentralDirectoryRecord(
  entryCount: number,
  centralDirectorySize: number,
  centralDirectoryOffset: number
): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralDirectorySize, 12);
  record.writeUInt32LE(centralDirectoryOffset, 16);
  record.writeUInt16LE(0, 20);

  return record;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}
