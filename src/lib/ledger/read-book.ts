import type { LedgerPayload } from "./aggregate.ts";
import { LedgerError } from "./errors.ts";
import { mapColumns, type ErpType } from "./mapping.ts";
import { runDiagnostic, type DiagnosticInput, type DiagnosticResult } from "./pipeline.ts";
import { toTeaser, type BookTeaser } from "./gate.ts";

const PROFILES: ErpType[] = ["excel", "zoho", "tally"];

function rowMaps(row: string[]): ErpType | null {
  for (const erp of PROFILES) {
    try {
      mapColumns(row, erp);
      return erp;
    } catch (error) {
      if (error instanceof LedgerError && error.code === "MAPPING_INCOMPLETE") continue;
      throw error;
    }
  }
  return null;
}

/** Which profile to try first. A saved Zoho client can still upload an Excel aging file. */
export function detectErpOrder(table: string[][], preferred?: ErpType): ErpType[] {
  let guess: ErpType = "zoho";
  const limit = Math.min(table.length, 20);
  for (let i = 0; i < limit; i += 1) {
    const line = (table[i] ?? []).join(" ").toLowerCase();
    if (/company name|document number|invoice balance due|balance due|open balance|amount due/.test(line)) {
      guess = "excel";
      break;
    }
    if (/party name|voucher number|cost centre|cost center|godown/.test(line)) {
      guess = "tally";
      break;
    }
    if (rowMaps(table[i] ?? [])) break;
  }
  const order: ErpType[] = [];
  for (const erp of [preferred, guess, ...PROFILES]) {
    if (erp && !order.includes(erp)) order.push(erp);
  }
  return order;
}

export function chooseTable(sheets: string[][][]): string[][] {
  for (const sheet of sheets) {
    const limit = Math.min(sheet.length, 25);
    for (let i = 0; i < limit; i += 1) {
      if (rowMaps(sheet[i] ?? [])) return sheet;
    }
  }
  const fallback = sheets.find((sheet) => sheet.length > 1);
  if (!fallback) throw new LedgerError("BAD_XLSX", "Workbook has no sheets");
  return fallback;
}

export function diagnoseTable(input: Omit<DiagnosticInput, "erpType"> & { erpType?: ErpType }): DiagnosticResult {
  if (input.mapping) {
    return runDiagnostic({ ...input, erpType: input.erpType ?? "zoho" });
  }
  const order = detectErpOrder(input.table, input.erpType);
  let last: unknown;
  for (const erp of order) {
    try {
      return runDiagnostic({ ...input, erpType: erp });
    } catch (error) {
      if (error instanceof LedgerError && error.code === "MAPPING_INCOMPLETE") {
        last = error;
        continue;
      }
      throw error;
    }
  }
  throw last instanceof Error ? last : new LedgerError("MAPPING_INCOMPLETE", "Required columns could not be mapped");
}

export function analyzeTable(input: {
  filename: string;
  table: string[][];
  clientName: string;
  standardTermsDays: number;
  topAccounts: string[];
  asOf: string;
}): LedgerPayload {
  return diagnoseTable({
    erpType: undefined,
    clientName: input.clientName,
    config: {
      standardTermsDays: input.standardTermsDays,
      topAccountExternalIds: input.topAccounts,
      asOf: input.asOf,
      multiEntity: true,
    },
    table: input.table,
    runId: "preview",
  }).payload;
}

export function teaserFromTable(input: Parameters<typeof analyzeTable>[0]): BookTeaser {
  return toTeaser(analyzeTable(input));
}