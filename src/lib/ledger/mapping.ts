import { LedgerError } from "./errors.ts";

export type ErpType = "zoho" | "tally" | "excel";

export type LogicalField =
  | "external_id"
  | "customer_external_id"
  | "customer_name"
  | "amount"
  | "currency"
  | "invoice_date"
  | "due_date"
  | "status"
  | "po_number"
  | "gstin"
  | "branch"
  | "dispute"
  | "contact"
  | "last_action"
  | "credit_days";

export type ColumnMap = Partial<Record<LogicalField, number>>;

const ALIASES: Record<ErpType, Record<LogicalField, string[]>> = {
  zoho: {
    external_id: ["invoice id", "invoice number", "invoice no"],
    customer_external_id: ["customer id", "customer number"],
    customer_name: ["customer name", "customer"],
    amount: ["balance", "amount", "balance due"],
    currency: ["currency", "currency code"],
    invoice_date: ["invoice date", "date"],
    due_date: ["due date"],
    status: ["status", "invoice status"],
    po_number: ["purchase order", "po number", "po no", "customer po"],
    gstin: ["gstin", "tax registration number", "gst number"],
    branch: ["branch", "location"],
    dispute: ["dispute", "dispute flag", "disputed"],
    contact: ["email", "customer email", "billing contact", "contact"],
    last_action: ["last follow up", "last follow-up", "last action", "last follow up date"],
    credit_days: ["credit days", "credit period"],
  },
  tally: {
    external_id: ["voucher number", "invoice no", "invoice number", "voucher no"],
    customer_external_id: ["party id", "customer id", "ledger id"],
    customer_name: ["party name", "ledger name", "customer name"],
    amount: ["pending amount", "closing balance", "balance", "amount"],
    currency: ["currency", "currency code"],
    invoice_date: ["date", "bill date", "invoice date"],
    due_date: ["due date"],
    status: ["status"],
    po_number: ["purchase order", "po number", "po no", "order no"],
    gstin: ["gstin", "gstin/uin", "party gstin"],
    branch: ["cost centre", "cost center", "godown", "branch"],
    dispute: ["dispute", "dispute flag", "disputed"],
    contact: ["email", "party email", "contact", "e-mail"],
    last_action: ["last follow up", "last action", "last follow-up"],
    credit_days: ["credit days", "credit period", "credit days allowed"],
  },
  excel: {
    external_id: [
      "document number",
      "invoice number",
      "invoice no",
      "invoice id",
      "doc no",
      "bill no",
      "bill number",
      "voucher number",
      "voucher no",
    ],
    customer_external_id: ["customer id", "customer number", "customer no", "cust", "account number", "account no"],
    customer_name: ["company name", "customer name", "customer", "account name", "party name", "client name"],
    amount: [
      "invoice balance due",
      "balance due",
      "open balance",
      "amount due",
      "outstanding amount",
      "outstanding",
      "pending amount",
      "balance",
      "amount",
    ],
    currency: ["currency", "currency code"],
    invoice_date: ["invoice date", "document date", "bill date", "date"],
    due_date: ["due date", "due"],
    status: ["payment status", "invoice status", "status"],
    po_number: ["po number", "purchase order", "customer po", "po no"],
    gstin: ["gstin", "gstin uin", "gst number", "tax registration number"],
    branch: ["state", "region", "branch", "location"],
    dispute: ["dispute", "dispute flag", "disputed", "payment status"],
    contact: ["billing contact email", "customer email", "email", "billing contact", "contact"],
    last_action: ["last follow up", "last follow-up", "last action", "last follow up date", "notes"],
    credit_days: ["credit days", "credit period"],
  },
};

export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findHeader(headers: string[], wanted: string): number {
  const needle = normalizeHeader(wanted);
  return headers.findIndex((header) => header === needle);
}

export function mapColumns(
  rawHeaders: string[],
  erp: ErpType,
  override?: Partial<Record<LogicalField, string>>,
): ColumnMap {
  const headers = rawHeaders.map(normalizeHeader);
  const map: ColumnMap = {};
  const fields = Object.keys(ALIASES[erp]) as LogicalField[];

  for (const field of fields) {
    const forced = override?.[field];
    if (forced) {
      const index = findHeader(headers, forced);
      if (index < 0) {
        throw new LedgerError(
          "MAPPING_INCOMPLETE",
          `Override for ${field} points at "${forced}", which is not a column`,
        );
      }
      map[field] = index;
      continue;
    }
    for (const alias of ALIASES[erp][field]) {
      const index = findHeader(headers, alias);
      if (index >= 0) {
        map[field] = index;
        break;
      }
    }
  }

  const missing: string[] = [];
  if (map.external_id === undefined) missing.push("external_id");
  if (map.amount === undefined) missing.push("amount");
  if (map.invoice_date === undefined) missing.push("invoice_date");
  const hasDue = map.due_date !== undefined || (erp === "tally" && map.credit_days !== undefined);
  if (!hasDue) missing.push("due_date");
  if (map.customer_external_id === undefined && map.customer_name === undefined) {
    missing.push("customer_external_id or customer_name");
  }
  if (missing.length > 0) {
    throw new LedgerError(
      "MAPPING_INCOMPLETE",
      `Required columns could not be mapped: ${missing.join(", ")}`,
    );
  }
  return map;
}
