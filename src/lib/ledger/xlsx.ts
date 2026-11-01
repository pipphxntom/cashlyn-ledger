import { LedgerError } from "./errors.ts";

type WorkbookCell = { text?: string; value: unknown };

/** Every worksheet that has rows, in workbook order. */
export async function parseXlsxSheets(bytes: Uint8Array): Promise<string[][][]> {
  const loaded = await import("exceljs");
  const ExcelJS = loaded.default ?? loaded;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return workbook.worksheets.map(sheetToRows).filter((rows) => rows.length > 0);
}

/** First worksheet → string table. ExcelJS is loaded only for .xlsx uploads. */
export async function parseXlsx(bytes: Uint8Array): Promise<string[][]> {
  const sheets = await parseXlsxSheets(bytes);
  const sheet = sheets[0];
  if (!sheet || sheet.length < 2) throw new LedgerError("BAD_XLSX", "Sheet needs a header and at least one row");
  return sheet;
}

function sheetToRows(sheet: {
  columnCount: number;
  rowCount: number;
  eachRow: (
    opts: { includeEmpty: boolean },
    fn: (row: { cellCount: number; hidden?: boolean; getCell: (col: number) => WorkbookCell }, rowNumber: number) => void,
  ) => void;
}): string[][] {
  if (sheet.rowCount > 50_000) {
    throw new LedgerError("TOO_BIG", "That sheet has more than 50,000 rows. Split it and read one aging at a time.");
  }
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (row.hidden) return;
    const values: string[] = [];
    const width = Math.max(sheet.columnCount, row.cellCount);
    for (let col = 1; col <= width; col += 1) values.push(cellText(row.getCell(col)));
    while (values.length > 0 && values[values.length - 1] === "") values.pop();
    if (values.some((value) => value !== "")) rows.push(values);
  });
  return rows;
}

function isoDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function cellText(cell: WorkbookCell): string {
  const value = cell.value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return isoDate(value);
  if (typeof value === "object" && value && "result" in value) {
    const result = (value as { result: unknown }).result;
    if (result instanceof Date && !Number.isNaN(result.getTime())) return isoDate(result);
    if (result !== null && result !== undefined && String(result).trim()) return String(result).trim();
  }
  if (typeof value === "object" && value && "richText" in value) {
    const rich = (value as { richText: Array<{ text: string }> }).richText;
    return rich.map((part) => part.text).join("").trim();
  }
  if (typeof cell.text === "string" && cell.text.trim()) return cell.text.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}