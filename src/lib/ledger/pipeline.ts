import { buildPayload, type LedgerPayload } from "./aggregate.ts";
import { parseCsv } from "./csv.ts";
import { LedgerError } from "./errors.ts";
import type { LogicalField, ErpType } from "./mapping.ts";
import { assertClientConfig, normalizeRows, type ClientConfig, type NormalizedInvoice } from "./normalize.ts";
import { classifyBook, RULESET_VERSION, type Classification } from "./rules.ts";

export type DiagnosticInput = {
  erpType: ErpType;
  clientName: string;
  config: ClientConfig | null | undefined;
  table: string[][];
  runId: string;
  mapping?: Partial<Record<LogicalField, string>>;
};

export type DiagnosticResult = {
  rulesetVersion: string;
  payload: LedgerPayload;
  classifications: Classification[];
  invoices: NormalizedInvoice[];
  audit: Array<{ invoiceId: string; ruleId: string; message: string }>;
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function runDiagnostic(input: DiagnosticInput): DiagnosticResult {
  assertClientConfig(input.config);
  if (!input.clientName.trim()) throw new LedgerError("BAD_CLIENT", "Client name is required");
  if (!input.runId.trim()) throw new LedgerError("BAD_RUN", "run_id is required");
  const book = normalizeRows(input.table, input.erpType, input.config, input.mapping);
  const classifications = classifyBook(
    book.invoices,
    book.asOf,
    input.config.standardTermsDays,
    input.config.topAccountExternalIds,
  );
  const payload = buildPayload({
    runId: input.runId,
    clientName: input.clientName.trim(),
    erpType: input.erpType,
    standardTermsDays: input.config.standardTermsDays,
    asOf: book.asOf,
    fxRatesSnapshot: book.fxRatesSnapshot,
    invoices: book.invoices,
    classifications,
  });
  return {
    rulesetVersion: RULESET_VERSION,
    payload,
    classifications,
    invoices: book.invoices,
    audit: classifications.map((row) => ({
      invoiceId: row.externalId,
      ruleId: row.ruleIds[0] ?? "R008",
      message: row.message,
    })),
  };
}

export function runCsvDiagnostic(
  csv: string,
  input: Omit<DiagnosticInput, "table">,
): DiagnosticResult {
  return runDiagnostic({ ...input, table: parseCsv(csv) });
}
