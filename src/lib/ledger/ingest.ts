import { addDays, daysBetween, parseDate } from "./dates.ts";
import { LedgerError } from "./errors.ts";
import { normalizeHeader, type ColumnMap, type ErpType, type LogicalField } from "./mapping.ts";
import { parseAmountToMinor } from "./money.ts";
import { diagnoseTable } from "./read-book.ts";
import { isOpen, isOverdue } from "./rules.ts";
import { toPublicBook, type PublicBook } from "./gate.ts";

export const MAX_DETAIL_ROWS = 50_000;

const ALIAS: Record<LogicalField, string[]> = {
  external_id: ["document number", "invoice number", "invoice no", "invoice id", "bill name", "bill no", "ref no", "voucher number", "voucher no"],
  customer_external_id: ["customer id", "customer number", "party id", "cust", "ledger id"],
  customer_name: ["party name", "company name", "customer name", "customer", "ledger name", "account name"],
  amount: ["pending amount", "invoice balance due", "balance due", "outstanding", "outstanding amount", "amount due", "pending", "balance", "closing balance"],
  currency: ["currency", "currency code"],
  invoice_date: ["bill date", "invoice date", "document date", "date"],
  due_date: ["due date", "due on", "due"],
  status: ["payment status", "status"],
  po_number: ["po number", "purchase order", "order no", "po no"],
  gstin: ["gstin", "party gstin", "gst number"],
  branch: ["cost centre", "cost center", "branch", "state", "godown"],
  dispute: ["dispute", "disputed"],
  contact: ["billing contact email", "email", "party email", "e-mail"],
  last_action: ["last follow up", "last follow-up", "last action"],
  credit_days: ["credit days", "credit period"],
};

export const FIELD_LABEL: Record<LogicalField, string> = {
  external_id: "Invoice number",
  customer_external_id: "Customer code",
  customer_name: "Customer name",
  amount: "Amount due",
  currency: "Currency",
  invoice_date: "Invoice date",
  due_date: "Due date",
  status: "Status",
  po_number: "Purchase order",
  gstin: "GSTIN",
  branch: "Branch",
  dispute: "Dispute flag",
  contact: "Billing email",
  last_action: "Last follow-up",
  credit_days: "Credit days",
};

const REQUIRED: LogicalField[] = ["customer_name", "amount", "invoice_date", "due_date", "external_id"];

export type FieldSuggestion = {
  field: LogicalField;
  label: string;
  required: boolean;
  column: string;
  confidence: "high" | "none";
};

export type Skipped = { groupHeaders: number; subtotals: number; onAccount: number; blank: number; bad: number };

export type Reconciliation = {
  status: "matched" | "blocked" | "unconfirmed";
  invoiceCount: number;
  currency: string;
  outstandingMinor: number;
  tieOutMinor: number;
  grandTotalMinor: number | null;
  message: string;
};

export type BucketName = "current" | "d30" | "d60" | "d90" | "d90plus";

export type DrillRow = {
  id: string;
  party: string;
  partyKey: string;
  minor: number;
  currency: string;
  due: string;
  bucket: BucketName;
  overdue: boolean;
  cause: string;
  evidence: "data" | "hypothesis" | "none";
};

export type BucketTotal = { bucket: BucketName; label: string; count: number; minor: number };

export type PartyTotal = { key: string; name: string; count: number; minor: number };

export type LocalRead = {
  ok: true;
  book: PublicBook;
  reconcile: Reconciliation;
  rows: DrillRow[];
  buckets: BucketTotal[];
  parties: PartyTotal[];
  dso: number | null;
  blindSpots: string[];
  warnings: string[];
};

export type BlockedRead = {
  ok: false;
  reconcile: Reconciliation;
  warnings: string[];
};

export function partyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(private|pvt|limited|ltd|llp|incorporated|inc|company|co)\b/g, " ")
    .replace(/[^a-z0-9\u0900-\u097F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function bucketOf(due: string, asOf: string): BucketName {
  const age = daysBetween(due, asOf);
  if (age <= 0) return "current";
  if (age <= 30) return "d30";
  if (age <= 60) return "d60";
  if (age <= 90) return "d90";
  return "d90plus";
}

const BUCKET_LABEL: Record<BucketName, string> = {
  current: "Not yet due",
  d30: "1–30 days",
  d60: "31–60 days",
  d90: "61–90 days",
  d90plus: "91+ days",
};

export function dsoDays(openMinor: number, revenueMinor: number, periodDays: number): number | null {
  if (!(revenueMinor > 0) || !(periodDays > 0) || openMinor < 0) return null;
  if (openMinor === 0) return 0;
  return Math.round((openMinor / revenueMinor) * periodDays);
}

/** A formula in a name must stay a name if it ever lands in a spreadsheet. */
export function excelSafe(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

export function headerSignature(headers: string[]): string {
  return headers.map((header) => normalizeHeader(header)).join("|");
}

export function findHeaderIndex(table: string[][]): number {
  let best = 0;
  let score = -1;
  const limit = Math.min(table.length, 25);
  for (let i = 0; i < limit; i += 1) {
    const hits = suggestColumns(table[i] ?? []).filter((field) => field.confidence === "high").length;
    if (hits > score) {
      score = hits;
      best = i;
    }
  }
  return best;
}

export function suggestColumns(headers: string[]): FieldSuggestion[] {
  const normalized = headers.map(normalizeHeader);
  return (Object.keys(ALIAS) as LogicalField[]).map((field) => {
    let column = "";
    for (const alias of ALIAS[field]) {
      const index = normalized.indexOf(alias);
      if (index >= 0) {
        column = headers[index] ?? "";
        break;
      }
    }
    return {
      field,
      label: FIELD_LABEL[field],
      required: REQUIRED.includes(field),
      column,
      confidence: column ? "high" : "none",
    };
  });
}

export function refuseWrongFile(headers: string[]): string | null {
  const line = headers.map(normalizeHeader).join(" ");
  const ledger = /\bparticulars\b/.test(line) && /\bdebit\b/.test(line) && /\bcredit\b/.test(line);
  const aging = /due|pending|bill|invoice|outstanding|balance/.test(line);
  if (ledger && !aging) {
    return "This looks like a ledger or a profit-and-loss, not an open-invoice aging. Export bills receivable or the outstanding invoices.";
  }
  return null;
}

export function mapFromLabels(headers: string[], labels: Partial<Record<LogicalField, string>>): ColumnMap {
  const map: ColumnMap = {};
  for (const field of Object.keys(labels) as LogicalField[]) {
    const label = labels[field]?.trim();
    if (!label) continue;
    const index = headers.findIndex((header) => header === label);
    if (index >= 0) map[field] = index;
  }
  return map;
}

type Detail = {
  kind: "invoice" | "credit" | "onAccount";
  id: string;
  party: string;
  minor: number;
  currency: string;
  invoiceDate: string;
  dueDate: string;
  po: string;
  dispute: string;
  contact: string;
  lastAction: string;
  branch: string;
  gstin: string;
  badDate: boolean;
};

function cell(row: string[], index: number | undefined): string {
  if (index === undefined) return "";
  return (row[index] ?? "").trim();
}

function isGrand(text: string): boolean {
  return /grand\s*total|closing\s*total/.test(text);
}

function isSubtotal(text: string): boolean {
  return /sub\s*total|group\s*total|party\s*total/.test(text);
}

function isOnAccount(text: string): boolean {
  return /on\s*account|unallocated|advance received/.test(text);
}

export function readSheet(
  table: string[][],
  headerIndex: number,
  map: ColumnMap,
): { details: Detail[]; grandTotalMinor: number | null; skipped: Skipped; warnings: string[]; currency: string } {
  if (table.length > MAX_DETAIL_ROWS + 30) {
    throw new LedgerError("TOO_BIG", "More than 50,000 rows. Split the export and read one aging at a time.");
  }
  const body = table.slice(headerIndex + 1);
  const skipped: Skipped = { groupHeaders: 0, subtotals: 0, onAccount: 0, blank: 0, bad: 0 };
  const warnings: string[] = [];
  const details: Detail[] = [];
  let carry = "";
  let grandTotalMinor: number | null = null;
  const seen = new Map<string, number>();
  const currencies = new Set<string>();

  for (const row of body) {
    const text = row.join(" ").toLowerCase();
    if (!text.trim()) {
      skipped.blank += 1;
      continue;
    }
    if (isGrand(text)) {
      try {
        grandTotalMinor = parseAmountToMinor(cell(row, map.amount));
      } catch {
        warnings.push("A grand total row was found, but the amount in it could not be read.");
      }
      continue;
    }
    if (isSubtotal(text)) {
      skipped.subtotals += 1;
      continue;
    }
    const partyCell = cell(row, map.customer_name) || cell(row, map.customer_external_id);
    const amountCell = cell(row, map.amount);
    const idCell = cell(row, map.external_id);
    if (!amountCell && partyCell && !idCell) {
      carry = partyCell;
      skipped.groupHeaders += 1;
      continue;
    }
    if (!amountCell) {
      skipped.blank += 1;
      continue;
    }
    let minor: number;
    try {
      minor = parseAmountToMinor(amountCell);
    } catch {
      skipped.bad += 1;
      warnings.push(`Could not read an amount (“${amountCell.slice(0, 40)}”). That row is not in the total.`);
      continue;
    }
    const party = partyCell || carry;
    const currency = (cell(row, map.currency) || "INR").toUpperCase();
    if (/^[A-Z]{3}$/.test(currency)) currencies.add(currency);
    if (isOnAccount(`${idCell} ${party}`)) {
      skipped.onAccount += 1;
      details.push(blankDetail("onAccount", idCell || "On account", party || "On account", minor, currency));
      continue;
    }
    if (!party) {
      skipped.bad += 1;
      warnings.push("A row has an amount and no customer name. It is not in the read.");
      continue;
    }
    let invoiceDate = "";
    let dueDate = "";
    let badDate = false;
    try {
      invoiceDate = parseDate(cell(row, map.invoice_date));
      const dueRaw = cell(row, map.due_date);
      if (dueRaw) dueDate = parseDate(dueRaw);
      else if (map.credit_days !== undefined) {
        const credit = Number(cell(row, map.credit_days));
        if (!Number.isInteger(credit) || credit < 0 || credit > 3650) throw new LedgerError("BAD_DATE", "bad credit days");
        dueDate = addDays(invoiceDate, credit);
      } else throw new LedgerError("BAD_DATE", "no due date");
      if (daysBetween(invoiceDate, dueDate) < 0) {
        badDate = true;
        warnings.push(`${idCell || party}: the due date is before the invoice date. Counted in the total, left out of the aging.`);
      }
    } catch {
      badDate = true;
      warnings.push(`${idCell || party}: a date could not be read. Counted in the total, left out of the aging.`);
    }
    const rawId = idCell || `${party}-${invoiceDate || "row"}`;
    const count = (seen.get(rawId) ?? 0) + 1;
    seen.set(rawId, count);
    const id = count === 1 ? rawId : `${rawId}~${count}`;
    details.push({
      kind: minor > 0 ? "invoice" : "credit",
      id,
      party,
      minor,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : "INR",
      invoiceDate,
      dueDate,
      po: cell(row, map.po_number),
      dispute: cell(row, map.dispute),
      contact: cell(row, map.contact),
      lastAction: cell(row, map.last_action),
      branch: cell(row, map.branch),
      gstin: cell(row, map.gstin),
      badDate,
    });
  }

  if (currencies.size > 1) {
    warnings.push("More than one currency. A single grand total cannot prove the rupee number.");
  }
  return {
    details,
    grandTotalMinor,
    skipped,
    warnings: warnings.slice(0, 8),
    currency: currencies.size === 1 ? [...currencies][0] : "INR",
  };
}

function blankDetail(kind: Detail["kind"], id: string, party: string, minor: number, currency: string): Detail {
  return {
    kind,
    id,
    party,
    minor,
    currency,
    invoiceDate: "",
    dueDate: "",
    po: "",
    dispute: "",
    contact: "",
    lastAction: "",
    branch: "",
    gstin: "",
    badDate: true,
  };
}

function moneyLabel(minor: number, currency: string): string {
  const formatted = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(minor) / 100);
  return `${minor < 0 ? "−" : ""}${currency} ${formatted}`;
}

export function reconcile(details: Detail[], grandTotalMinor: number | null, currency: string, multiCurrency: boolean): Reconciliation {
  const tieOutMinor = details.reduce((sum, row) => sum + row.minor, 0);
  const invoices = details.filter((row) => row.kind === "invoice" && !row.badDate);
  const outstandingMinor = invoices.reduce((sum, row) => sum + row.minor, 0);
  const base = {
    invoiceCount: invoices.length,
    currency,
    outstandingMinor,
    tieOutMinor,
    grandTotalMinor,
  };
  if (multiCurrency) {
    return {
      ...base,
      status: "unconfirmed",
      message: `Read ${invoices.length} invoices. More than one currency, so this does not claim to match a grand total.`,
    };
  }
  if (grandTotalMinor === null) {
    return {
      ...base,
      status: "unconfirmed",
      message: `Read ${invoices.length} invoices. Detail rows sum to ${moneyLabel(tieOutMinor, currency)}. The file has no grand total to match.`,
    };
  }
  if (tieOutMinor !== grandTotalMinor) {
    return {
      ...base,
      status: "blocked",
      message: `Detail rows sum to ${moneyLabel(tieOutMinor, currency)}. The file’s grand total is ${moneyLabel(grandTotalMinor, currency)}. Difference ${moneyLabel(tieOutMinor - grandTotalMinor, currency)}. No headline until this ties.`,
    };
  }
  return {
    ...base,
    status: "matched",
    message: `Read ${invoices.length} invoices, ${moneyLabel(outstandingMinor, currency)} outstanding. Detail rows sum to ${moneyLabel(tieOutMinor, currency)}, which matches the file’s grand total.`,
  };
}

function cleanTable(details: Detail[], map: ColumnMap): string[][] {
  const header = ["Invoice ID", "Customer Name", "Balance", "Currency", "Invoice Date", "Due Date"];
  if (map.po_number !== undefined) header.push("Purchase Order");
  if (map.dispute !== undefined) header.push("Dispute");
  if (map.contact !== undefined) header.push("Email");
  if (map.last_action !== undefined) header.push("Last Follow Up");
  if (map.branch !== undefined) header.push("Branch");
  if (map.gstin !== undefined) header.push("GSTIN");
  const rows = [header];
  for (const row of details) {
    if (row.kind !== "invoice" || row.badDate || row.minor <= 0) continue;
    const line = [
      row.id,
      row.party,
      (row.minor / 100).toFixed(2),
      row.currency,
      row.invoiceDate,
      row.dueDate,
    ];
    if (map.po_number !== undefined) line.push(row.po);
    if (map.dispute !== undefined) line.push(row.dispute);
    if (map.contact !== undefined) line.push(row.contact);
    if (map.last_action !== undefined) line.push(row.lastAction);
    if (map.branch !== undefined) line.push(row.branch);
    if (map.gstin !== undefined) line.push(row.gstin);
    rows.push(line);
  }
  return rows;
}

export function blindSpots(map: ColumnMap): string[] {
  const gaps: string[] = [];
  if (map.dispute === undefined) gaps.push("Disputes are not in this file. An overdue invoice is not a dispute.");
  if (map.contact === undefined) gaps.push("Billing contacts are not in this file. We cannot say the inbox is wrong.");
  if (map.last_action === undefined) gaps.push("Follow-up is not in this file. We cannot see who was chased.");
  if (map.po_number === undefined) gaps.push("Purchase orders are not in this file. A blank we never saw is not a missing PO.");
  gaps.push("What is stuck is in the file. Why it is stuck, when the columns are missing, is the diagnostic.");
  return gaps;
}

export function assembleRead(input: {
  table: string[][];
  headerIndex: number;
  map: ColumnMap;
  clientName: string;
  asOf: string;
  standardTermsDays: number;
  topAccounts: string[];
  revenueInr?: number | null;
  periodDays?: number;
}): LocalRead | BlockedRead {
  const parsed = readSheet(input.table, input.headerIndex, input.map);
  const multi = new Set(parsed.details.map((row) => row.currency)).size > 1;
  const check = reconcile(parsed.details, parsed.grandTotalMinor, parsed.currency, multi);
  if (check.status === "blocked" || check.invoiceCount === 0) {
    return {
      ok: false,
      reconcile: check.invoiceCount === 0 && check.status !== "blocked"
        ? { ...check, status: "blocked", message: "No open invoice with a readable date survived the read." }
        : check,
      warnings: parsed.warnings,
    };
  }
  const table = cleanTable(parsed.details, input.map);
  const result = diagnoseTable({
    erpType: "excel" satisfies ErpType,
    clientName: input.clientName,
    config: {
      standardTermsDays: input.standardTermsDays,
      topAccountExternalIds: input.topAccounts,
      asOf: input.asOf,
      multiEntity: true,
    },
    table,
    runId: "local",
  });
  const byId = new Map(result.classifications.map((row) => [row.externalId, row]));
  const rows: DrillRow[] = result.invoices.filter(isOpen).map((invoice) => {
    const found = byId.get(invoice.externalId);
    return {
      id: invoice.externalId,
      party: invoice.customerName,
      partyKey: partyKey(invoice.customerName),
      minor: invoice.sourceMinor,
      currency: invoice.currency,
      due: invoice.dueDate,
      bucket: bucketOf(invoice.dueDate, input.asOf),
      overdue: isOverdue(invoice, input.asOf),
      cause: found?.subcause ?? (isOverdue(invoice, input.asOf) ? "unclassified" : "not due"),
      evidence: found?.evidence ?? "none",
    };
  });
  const buckets: BucketTotal[] = (Object.keys(BUCKET_LABEL) as BucketName[]).map((bucket) => {
    const inBucket = rows.filter((row) => row.bucket === bucket);
    return {
      bucket,
      label: BUCKET_LABEL[bucket],
      count: inBucket.length,
      minor: inBucket.reduce((sum, row) => sum + row.minor, 0),
    };
  });
  const partyMap = new Map<string, PartyTotal>();
  for (const row of rows.filter((item) => item.overdue)) {
    const current = partyMap.get(row.partyKey) ?? { key: row.partyKey, name: row.party, count: 0, minor: 0 };
    current.count += 1;
    current.minor += row.minor;
    partyMap.set(row.partyKey, current);
  }
  const parties = [...partyMap.values()].sort((a, b) => b.minor - a.minor || a.name.localeCompare(b.name)).slice(0, 8);
  const openMinor = result.invoices.filter(isOpen).reduce((sum, invoice) => sum + invoice.amountInrPaise, 0);
  const revenueMinor = input.revenueInr && input.revenueInr > 0 ? Math.round(input.revenueInr * 100) : 0;
  return {
    ok: true,
    book: toPublicBook(result.payload),
    reconcile: check,
    rows,
    buckets,
    parties,
    dso: dsoDays(openMinor, revenueMinor, input.periodDays ?? 365),
    blindSpots: blindSpots(input.map),
    warnings: parsed.warnings,
  };
}
