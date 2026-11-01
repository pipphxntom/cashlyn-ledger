import { addDays, daysBetween, parseDate } from "./dates.ts";
import { LedgerError } from "./errors.ts";
import { mapColumns, normalizeHeader, type ColumnMap, type ErpType, type LogicalField } from "./mapping.ts";
import { minorToInrPaise, parseAmountToMinor } from "./money.ts";

export const DEFAULT_FX: Record<string, number> = {
  INR: 1,
  USD: 83.5,
  EUR: 90.1,
  GBP: 105.2,
  AED: 22.74,
  SGD: 62.4,
  CAD: 61.5,
};

export type ClientConfig = {
  standardTermsDays: number;
  topAccountExternalIds: string[];
  fxRates?: Record<string, number>;
  asOf?: string;
  multiEntity?: boolean;
};

export type NormalizedInvoice = {
  externalId: string;
  customerExternalId: string;
  customerName: string;
  currency: string;
  sourceMinor: number;
  amountInrPaise: number;
  invoiceDate: string;
  dueDate: string;
  status: string;
  poNumber: string | null;
  poColumn: boolean;
  gstin: string;
  branch: string;
  disputeFlag: boolean;
  contact: string | null;
  contactColumn: boolean;
  lastActionAt: string | null;
  lastActionColumn: boolean;
};

export type NormalizedBook = {
  invoices: NormalizedInvoice[];
  asOf: string;
  fxRatesSnapshot: Record<string, number>;
};

function cell(row: string[], map: ColumnMap, field: LogicalField): string {
  const index = map[field];
  if (index === undefined) return "";
  return row[index] ?? "";
}

function truthyFlag(raw: string): boolean {
  return /^(y|yes|true|1|dispute|disputed|possible issue)$/i.test(raw.trim());
}

function cleanGstin(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

function usableContact(raw: string): string | null {
  const value = raw.trim();
  return value ? value : null;
}

function columnIndex(headers: string[], names: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const name of names) {
    const index = normalized.indexOf(normalizeHeader(name));
    if (index >= 0) return index;
  }
  return -1;
}

function tableFromHeader(
  table: string[][],
  erp: ErpType,
  override?: Partial<Record<LogicalField, string>>,
): string[][] {
  const limit = Math.min(table.length, 25);
  let missing: LedgerError | null = null;
  for (let i = 0; i < limit; i += 1) {
    try {
      mapColumns(table[i] ?? [], erp, override);
      return table.slice(i);
    } catch (error) {
      if (error instanceof LedgerError && error.code === "MAPPING_INCOMPLETE") {
        missing = error;
        continue;
      }
      throw error;
    }
  }
  if (missing) throw missing;
  throw new LedgerError("MAPPING_INCOMPLETE", "Required columns could not be mapped");
}

/** Placeholders that collectors type when there is no purchase order. */
function cleanPo(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^(0+|need po|n\/a|na|none|nil|-|—|tbd|pending)$/i.test(value)) return null;
  if (/closed|retired/i.test(value)) return null;
  return value;
}

/** Collector notes are written month/day. Invoice dates stay on the India-first parser. */
function latestUsDate(text: string): string | null {
  const re = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
  let best = "";
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) continue;
    const utc = new Date(Date.UTC(year, month - 1, day));
    if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) continue;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!best || iso > best) best = iso;
  }
  return best || null;
}

function excelContact(raw: string): string | null {
  const parts = raw.split(/[,;]/).map((part) => part.trim()).filter((part) => part.includes("@"));
  const external = parts.filter((part) => !/@cvent\.com$/i.test(part) && !/@on24\.com$/i.test(part));
  return external[0] ?? null;
}

export function resolveFx(config: ClientConfig): Record<string, number> {
  const rates: Record<string, number> = { ...DEFAULT_FX };
  for (const [code, rate] of Object.entries(config.fxRates ?? {})) {
    const key = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(key)) throw new LedgerError("BAD_FX", `Bad currency code "${code}"`);
    if (!Number.isFinite(rate) || rate <= 0) throw new LedgerError("BAD_FX", `Bad FX rate for ${key}`);
    rates[key] = rate;
  }
  rates.INR = 1;
  return rates;
}

export function assertClientConfig(config: ClientConfig | null | undefined): asserts config is ClientConfig {
  if (!config) throw new LedgerError("CONFIG_REQUIRED", "client_config is required before a run");
  if (!Number.isInteger(config.standardTermsDays) || config.standardTermsDays < 1 || config.standardTermsDays > 365) {
    throw new LedgerError("CONFIG_REQUIRED", "standard_terms_days must be an integer from 1 to 365");
  }
  if (!Array.isArray(config.topAccountExternalIds)) {
    throw new LedgerError("CONFIG_REQUIRED", "top_account_external_ids is required (it may be empty)");
  }
}

export function normalizeRows(
  table: string[][],
  erp: ErpType,
  config: ClientConfig,
  override?: Partial<Record<LogicalField, string>>,
): NormalizedBook {
  assertClientConfig(config);
  const loose = erp === "excel";
  const [header, ...body] = tableFromHeader(table, erp, override);
  const map = mapColumns(header, erp, override);
  const rates = resolveFx(config);
  const seen = new Set<string>();
  const invoices: NormalizedInvoice[] = [];
  const usedCurrencies = new Set<string>(["INR"]);
  const usdIndex = loose ? columnIndex(header, ["usd conversion total", "balance usd", "usd balance"]) : -1;
  const formIndex = loose ? columnIndex(header, ["form", "document type"]) : -1;

  const skip = () => undefined;

  body.forEach((row, index) => {
    const line = index + 2;
    const fail = (error: LedgerError) => {
      if (loose) return skip();
      throw new LedgerError(error.code, `Row ${line}: ${error.message}`);
    };

    const externalId = cell(row, map, "external_id").trim();
    if (!externalId) {
      if (loose) return;
      throw new LedgerError("BAD_ROW", `Row ${line} has no invoice id`);
    }
    if (seen.has(externalId)) {
      if (loose) return;
      throw new LedgerError("DUPLICATE_INVOICE", `Duplicate invoice id ${externalId}`);
    }

    const form = formIndex >= 0 ? (row[formIndex] ?? "") : "";
    if (loose && /credit memo|customer payment/i.test(form)) return;

    const customerName = cell(row, map, "customer_name") || cell(row, map, "customer_external_id");
    const customerExternalId = cell(row, map, "customer_external_id") || customerName;
    if (!customerExternalId) {
      if (loose) return;
      throw new LedgerError("BAD_ROW", `Row ${line} has no customer`);
    }

    let amountRaw = cell(row, map, "amount");
    let currency = (cell(row, map, "currency") || (loose ? "" : "INR")).trim().toUpperCase();
    if (loose && usdIndex >= 0) {
      const usdRaw = (row[usdIndex] ?? "").trim();
      if (usdRaw && usdRaw !== "0") {
        amountRaw = usdRaw;
        currency = "USD";
      }
    }
    if (!currency) currency = "INR";

    let sourceMinor: number;
    try {
      sourceMinor = parseAmountToMinor(amountRaw || "0");
    } catch (error) {
      if (error instanceof LedgerError) return fail(error);
      throw error;
    }
    if (loose && sourceMinor <= 0) return;

    if (!/^[A-Z]{3}$/.test(currency)) return fail(new LedgerError("BAD_FX", `bad currency "${currency}"`));
    const rate = rates[currency];
    if (rate === undefined) return fail(new LedgerError("BAD_FX", `no INR rate for ${currency}. Add it to client config.`));

    let invoiceDate: string;
    let dueDate: string;
    try {
      invoiceDate = parseDate(cell(row, map, "invoice_date"));
      const dueRaw = cell(row, map, "due_date");
      if (dueRaw) {
        dueDate = parseDate(dueRaw);
      } else {
        const creditRaw = cell(row, map, "credit_days");
        if (!creditRaw) throw new LedgerError("BAD_DATE", "Due date missing");
        const credit = Number(creditRaw);
        if (!Number.isInteger(credit) || credit < 0 || credit > 365) {
          throw new LedgerError("BAD_DATE", `Bad credit days "${creditRaw}"`);
        }
        dueDate = addDays(invoiceDate, credit);
      }
    } catch (error) {
      if (error instanceof LedgerError) return fail(error);
      throw error;
    }
    if (daysBetween(invoiceDate, dueDate) < 0) {
      return fail(new LedgerError("BAD_DATE", "due date is before invoice date"));
    }

    const contactColumn = map.contact !== undefined;
    const lastActionColumn = map.last_action !== undefined;
    let lastActionAt: string | null = null;
    if (lastActionColumn) {
      const rawAction = cell(row, map, "last_action");
      if (rawAction) {
        try {
          lastActionAt = parseDate(rawAction);
        } catch (error) {
          if (!loose) {
            if (error instanceof LedgerError) return fail(error);
            throw error;
          }
          lastActionAt = latestUsDate(rawAction);
        }
      }
    }

    const contact = contactColumn
      ? loose
        ? excelContact(cell(row, map, "contact"))
        : usableContact(cell(row, map, "contact"))
      : null;

    seen.add(externalId);
    usedCurrencies.add(currency);
    invoices.push({
      externalId,
      customerExternalId,
      customerName: customerName || customerExternalId,
      currency,
      sourceMinor,
      amountInrPaise: minorToInrPaise(sourceMinor, rate),
      invoiceDate,
      dueDate,
      status: cell(row, map, "status"),
      poNumber: cleanPo(cell(row, map, "po_number")),
      poColumn: map.po_number !== undefined,
      gstin: cleanGstin(cell(row, map, "gstin")),
      branch: cell(row, map, "branch").trim(),
      disputeFlag: truthyFlag(cell(row, map, "dispute")),
      contact,
      contactColumn,
      lastActionAt,
      lastActionColumn,
    });
  });

  if (invoices.length === 0) {
    throw new LedgerError("EMPTY_BOOK", "That file has no open invoices with an amount and a due date.");
  }

  const asOf =
    config.asOf ??
    invoices.reduce((max, invoice) => {
      const candidate = invoice.dueDate > invoice.invoiceDate ? invoice.dueDate : invoice.invoiceDate;
      return candidate > max ? candidate : max;
    }, "1970-01-01");
  if (config.asOf) parseDate(config.asOf);

  const fxRatesSnapshot: Record<string, number> = {};
  for (const code of [...usedCurrencies].sort()) fxRatesSnapshot[code] = rates[code];

  return { invoices, asOf, fxRatesSnapshot };
}
