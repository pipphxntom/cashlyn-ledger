import { LedgerError } from "./errors.ts";

/** RFC-style CSV. Strips a UTF-8 BOM. Semicolons win when the header has more of them than commas. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const splitOn = delimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === splitOn) {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell.trim());
      cell = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  if (inQuotes) throw new LedgerError("BAD_CSV", "Unclosed quote in CSV");
  row.push(cell.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  if (rows.length < 2) throw new LedgerError("BAD_CSV", "CSV needs a header and at least one row");
  return rows;
}

function delimiter(src: string): "," | ";" {
  const line = src.split(/\r?\n/, 1)[0] ?? "";
  let commas = 0;
  let semis = 0;
  for (const char of line) {
    if (char === ",") commas += 1;
    else if (char === ";") semis += 1;
  }
  return semis > commas ? ";" : ",";
}
