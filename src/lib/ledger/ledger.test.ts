import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildPayload, daysOfWorkingCapital } from "./aggregate.ts";
import { parseCsv } from "./csv.ts";
import { parseDate } from "./dates.ts";
import { LedgerError } from "./errors.ts";
import { FIXTURE_CONFIG } from "./fixtures.ts";
import { mapColumns } from "./mapping.ts";
import { portionPaise } from "./money.ts";
import type { NormalizedInvoice } from "./normalize.ts";
import { runCsvDiagnostic, runDiagnostic } from "./pipeline.ts";
import { classifyBook } from "./rules.ts";
import { authorizeRun, requireViewer, viewerResponseHeaders, watermark } from "./viewer.ts";
import { diagnoseTable, chooseTable } from "./read-book.ts";
import { parseXlsx, parseXlsxSheets } from "./xlsx.ts";

const csv = readFileSync(new URL("./fixtures/zoho-open-ar.csv", import.meta.url), "utf8");

function runZoho(runId = "run-fixture") {
  return runCsvDiagnostic(csv, {
    erpType: "zoho",
    clientName: "Northwind Components",
    config: FIXTURE_CONFIG,
    runId,
  });
}

describe("ruleset v1", () => {
  it("fires every rule exactly once on the Zoho fixture, and power recovers nothing", () => {
    const result = runZoho();
    const byId = Object.fromEntries(result.classifications.map((row) => [row.externalId, row]));
    assert.equal(byId["POWER-1"].ruleIds[0], "R001");
    assert.equal(byId["POWER-1"].cause, "power");
    assert.equal(byId["POWER-1"].recoverablePaise, 0);
    assert.equal(byId["DISP-1"].ruleIds[0], "R002");
    assert.equal(byId["DISP-1"].subcause, "open_dispute");
    assert.equal(byId["PO-1"].ruleIds[0], "R003");
    assert.equal(byId["CONT-1"].ruleIds[0], "R004");
    assert.equal(byId["CONT-1"].subcause, "wrong_or_missing_contact");
    assert.equal(byId["FOL-1"].ruleIds[0], "R005");
    assert.equal(byId["TERM-1"].ruleIds[0], "R006");
    assert.equal(byId["TERM-1"].cause, "terms");
    assert.equal(byId["TERM-1"].recoverablePaise, 0);
    assert.equal(byId["DIST-1"].ruleIds[0], "R007");
    assert.equal(byId["DIST-1"].cause, "distress");
    assert.equal(byId["CAD-1"].ruleIds[0], "R008");
    assert.equal(byId["CAD-1"].subcause, "late_without_cadence");
    assert.equal(byId["UNK-1"].ruleIds[0], "R008");
    assert.equal(byId["UNK-1"].cause, "unknown");
    assert.equal(byId["UNK-1"].recoverablePaise, 0);
    assert.equal(byId["USD-1"].subcause, "missing_po");
    assert.equal(byId["EUR-1"], undefined);
    assert.equal(byId["CUR-1"], undefined);
    assert.equal(byId["DRAFT-1"], undefined);
    assert.equal(byId["ZERO-1"], undefined);
    assert.equal(result.classifications.length, 10);
  });

  it("lets a top account override a dispute", () => {
    const [invoice] = runZoho().invoices.filter((row) => row.externalId === "DISP-1");
    const [hit] = classifyBook([invoice], "2026-10-01", 45, ["CUST-A"]);
    assert.equal(hit.cause, "power");
    assert.equal(hit.recoverablePaise, 0);
    assert.deepEqual(hit.ruleIds, ["R001"]);
  });

  it("uses conservative portions", () => {
    assert.equal(portionPaise(5_000_000_00, 5500), 2_750_000_00);
    const result = runZoho();
    const dispute = result.classifications.find((row) => row.externalId === "DISP-1");
    assert.equal(dispute?.recoverablePaise, 2_750_000_00);
  });
});

describe("payload", () => {
  it("matches the locked Zoho numbers, in crore, deterministically", () => {
    const first = runZoho();
    const second = runZoho();
    assert.deepEqual(first.payload, second.payload);
    assert.deepEqual(first.classifications, second.classifications);
    const payload = first.payload;
    assert.equal(payload.headline.trapped_cash_inr_cr, 3.98);
    assert.equal(payload.headline.pct_of_ar, 0.9734);
    assert.equal(payload.headline.days_of_wc, 102);
    assert.equal(payload.by_cause.process.amount_inr_cr, 1.98);
    assert.equal(payload.by_cause.power.amount_inr_cr, 1);
    assert.equal(payload.by_cause.terms.amount_inr_cr, 0.5);
    assert.equal(payload.by_cause.distress.amount_inr_cr, 0.3);
    assert.equal(payload.by_cause.unknown.amount_inr_cr, 0.2);
    assert.equal(payload.client.base_currency, "INR");
    assert.equal(payload.fx_rates_snapshot.USD, 83.5);
    assert.equal(payload.fx_rates_snapshot.EUR, 90.1);
    assert.equal(payload.by_entity.length, 2);
    assert.equal(payload.by_entity[0].gstin, "07AABCU9603R1ZM");
    assert.equal(payload.by_entity[1].gstin, "27AABCU9603R1Z5");
    assert.equal(payload.by_entity[1].trapped_cash_inr_cr, 0.08);
    assert.equal(payload.top_subcauses[0].subcause, "wrong_or_missing_contact");
    assert.equal(payload.top_subcauses[0].amount_inr_cr, 0.7);
    assert.equal(payload.top_subcauses[0].window_days, 30);
    assert.equal(payload.cash_map_30_60_90.d30, 0.96);
    assert.equal(payload.cash_map_30_60_90.d60, 1.24);
    assert.equal(payload.cash_map_30_60_90.d90, 1.24);
    assert.deepEqual(payload.notes, ["conservative; power and terms excluded from recoverable"]);
    assert.ok(payload.quick_wins.length >= 4);
    const causeSum = Object.values(payload.by_cause).reduce((sum, slice) => sum + slice.amount_inr_cr, 0);
    assert.equal(Math.round(causeSum * 100) / 100, payload.headline.trapped_cash_inr_cr);
  });

  it("computes days of working capital from the open book, not from buckets", () => {
    const asOf = "2026-10-01";
    const invoices: NormalizedInvoice[] = [
      baseInvoice({
        externalId: "A",
        amountInrPaise: 100_000_000,
        invoiceDate: "2026-09-21",
        dueDate: "2026-09-26",
      }),
      baseInvoice({
        externalId: "B",
        amountInrPaise: 100_000_000,
        invoiceDate: "2026-09-26",
        dueDate: "2026-10-15",
      }),
    ];
    assert.equal(daysOfWorkingCapital(invoices, 100_000_000, asOf), 4);
    const payload = buildPayload({
      runId: "tiny",
      clientName: "Tiny",
      erpType: "zoho",
      standardTermsDays: 30,
      asOf,
      fxRatesSnapshot: { INR: 1 },
      invoices,
      classifications: classifyBook(invoices, asOf, 30, []),
    });
    assert.equal(payload.headline.days_of_wc, 4);
    assert.equal(payload.headline.trapped_cash_inr_cr, 0.1);
  });
});

describe("ingest gates", () => {
  it("aborts when client_config is missing and writes no classifications", () => {
    assert.throws(
      () =>
        runCsvDiagnostic(csv, {
          erpType: "zoho",
          clientName: "Northwind Components",
          config: null,
          runId: "no-config",
        }),
      (error: unknown) => error instanceof LedgerError && error.code === "CONFIG_REQUIRED",
    );
  });

  it("fails closed when a required column cannot be mapped", () => {
    const broken = "Invoice ID,Customer Name,Invoice Date,Due Date\n1,A,2026-01-01,2026-02-01\n";
    assert.throws(
      () =>
        runCsvDiagnostic(broken, {
          erpType: "zoho",
          clientName: "X",
          config: FIXTURE_CONFIG,
          runId: "bad-map",
        }),
      (error: unknown) => error instanceof LedgerError && error.code === "MAPPING_INCOMPLETE",
    );
  });

  it("accepts a mapping override", () => {
    const odd = "Vch,Party,Pending,Inv Date,Due,PO\n9,Acme,1000,2026-01-01,2026-03-01,PO-9\n";
    const result = runCsvDiagnostic(odd, {
      erpType: "tally",
      clientName: "X",
      config: { standardTermsDays: 30, topAccountExternalIds: [], asOf: "2026-04-01" },
      runId: "override",
      mapping: {
        external_id: "Vch",
        customer_name: "Party",
        amount: "Pending",
        invoice_date: "Inv Date",
        due_date: "Due",
        po_number: "PO",
      },
    });
    assert.equal(result.classifications[0].cause, "terms");
    assert.equal(result.payload.headline.trapped_cash_inr_cr, 0);
  });

  it("rejects duplicate invoice ids and unknown currencies", () => {
    const dup =
      "Invoice ID,Customer Name,Balance,Invoice Date,Due Date\n1,A,10,2026-01-01,2026-02-01\n1,A,10,2026-01-01,2026-02-01\n";
    assert.throws(
      () => runCsvDiagnostic(dup, { erpType: "zoho", clientName: "X", config: FIXTURE_CONFIG, runId: "dup" }),
      (error: unknown) => error instanceof LedgerError && error.code === "DUPLICATE_INVOICE",
    );
    const fx =
      "Invoice ID,Customer Name,Balance,Currency,Invoice Date,Due Date\n1,A,10,JPY,2026-01-01,2026-02-01\n";
    assert.throws(
      () => runCsvDiagnostic(fx, { erpType: "zoho", clientName: "X", config: FIXTURE_CONFIG, runId: "fx" }),
      (error: unknown) => error instanceof LedgerError && error.code === "BAD_FX",
    );
  });

  it("reads India-first dates and refuses the impossible", () => {
    assert.equal(parseDate("01/10/2026"), "2026-10-01");
    assert.equal(parseDate("13/01/2026"), "2026-01-13");
    assert.equal(parseDate("01/13/2026"), "2026-01-13");
    assert.equal(parseDate("01-Oct-2026"), "2026-10-01");
    assert.throws(() => parseDate("31/02/2026"), (error: unknown) => error instanceof LedgerError);
  });
});

describe("Tally Excel fixture", () => {
  it("covers every rule, two currencies, and two GSTINs", async () => {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Bills");
    sheet.addRow([
      "Voucher Number",
      "Party Id",
      "Party Name",
      "Pending Amount",
      "Currency",
      "Date",
      "Due Date",
      "Credit Days",
      "GSTIN",
      "Cost Centre",
      "Purchase Order",
      "Dispute",
      "Email",
      "Last Follow Up",
    ]);
    const rows = parseCsv(csv).slice(1);
    for (const row of rows) {
      const [id, customerId, name, amount, currency, invoiceDate, dueDate, status, po, gstin, branch, dispute, email, last] =
        row;
      if (status === "Draft" || amount === "0") continue;
      const useCreditOnly = id === "USD-1";
      sheet.addRow([
        id,
        customerId,
        name,
        Number(amount),
        currency,
        invoiceDate,
        useCreditOnly ? "" : dueDate,
        useCreditOnly ? 45 : "",
        gstin,
        branch,
        po,
        dispute,
        email,
        last,
      ]);
    }
    const buffer = await workbook.xlsx.writeBuffer();
    const table = await parseXlsx(new Uint8Array(buffer));
    const tally = runDiagnostic({
      erpType: "tally",
      clientName: "Northwind Components",
      config: FIXTURE_CONFIG,
      runId: "run-fixture",
      table,
    });
    const zoho = runZoho();
    assert.equal(tally.payload.headline.trapped_cash_inr_cr, zoho.payload.headline.trapped_cash_inr_cr);
    assert.deepEqual(
      tally.classifications.map((row) => [row.externalId, row.ruleIds[0], row.cause]),
      zoho.classifications.map((row) => [row.externalId, row.ruleIds[0], row.cause]),
    );
    assert.equal(tally.payload.fx_rates_snapshot.USD, 83.5);
    assert.equal(tally.payload.by_entity.length, 2);
    const mapped = mapColumns(table[0], "tally");
    assert.equal(typeof mapped.external_id, "number");
  });
});

describe("Excel aging", () => {
  it("reads a collector sheet, skips credits, and keeps the decision rules", () => {
    const aging = [
      "Aging 10.20.26",
      "Collectors,Company Name,Document Number,Date,Due Date,Currency,Invoice Balance Due,USD Conversion Total,PO Number,Payment Status,Billing Contact Email,Notes,Form",
      "A,Siemens,SF-1,2026-08-01,2026-09-01,USD,1000,1000,Need PO,Open,ap@siemens.com,10/01/2026- mailed the invoice,Subscription Invoice",
      "A,Doane,SF-2,2026-08-01,2026-09-15,CAD,500,70,PO-9,Possible Issue,ap@doane.example; sam@cvent.com,09/01/2026- called,Subscription Invoice",
      "A,Haleon,,2026-04-11,,GBP,-100,-10,0,Credit on Account,,,Customer Payment",
      "A,Dup,SF-1,2026-08-01,2026-09-01,USD,999,999,PO-1,Open,ap@dup.example,,Subscription Invoice",
    ].join("\n");
    const result = diagnoseTable({
      clientName: "Book",
      config: { standardTermsDays: 30, topAccountExternalIds: [], asOf: "2026-10-20" },
      table: parseCsv(aging),
      runId: "excel-1",
    });
    const byId = Object.fromEntries(result.classifications.map((row) => [row.externalId, row]));
    assert.equal(result.payload.client.erp_type, "excel");
    assert.equal(result.invoices.length, 2);
    assert.equal(byId["SF-1"].subcause, "missing_po");
    assert.equal(byId["SF-2"].subcause, "open_dispute");
    const doane = result.invoices.find((row) => row.externalId === "SF-2");
    assert.equal(doane?.currency, "USD");
    assert.equal(doane?.sourceMinor, 7000);
    assert.equal(doane?.contact, "ap@doane.example");
    assert.equal(result.invoices.find((row) => row.externalId === "SF-1")?.lastActionAt, "2026-10-01");
    assert.equal(result.invoices.find((row) => row.externalId === "SF-1")?.poNumber, null);
  });

  it("reads native currency when the workbook has no USD conversion column", () => {
    const aging = [
      "Company Name,Document Number,Date,Due Date,Currency,Invoice Balance Due,PO Number",
      "Acme,SF-3,2026-08-01,2026-09-01,CAD,100,0",
    ].join("\n");
    const result = diagnoseTable({
      clientName: "Book",
      config: { standardTermsDays: 30, topAccountExternalIds: [], asOf: "2026-10-20" },
      table: parseCsv(aging),
      runId: "excel-cad",
    });
    assert.equal(result.invoices[0].currency, "CAD");
    assert.equal(result.invoices[0].poNumber, null);
    assert.equal(result.classifications[0].subcause, "missing_po");
    assert.equal(result.payload.fx_rates_snapshot.CAD, 61.5);
  });

  it("picks the aging sheet and reads real Excel dates", async () => {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    const cover = workbook.addWorksheet("Payment Status");
    cover.addRow(["Payment Status", "Reason"]);
    cover.addRow(["Remit", "Collectible"]);
    const sheet = workbook.addWorksheet("Aging");
    sheet.addRow(["Company Name", "Document Number", "Date", "Due Date", "Currency", "Invoice Balance Due", "PO Number"]);
    sheet.addRow(["Acme", "SF-9", new Date(Date.UTC(2026, 7, 1)), new Date(Date.UTC(2026, 8, 1)), "USD", 250, "Need PO"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const table = chooseTable(await parseXlsxSheets(new Uint8Array(buffer)));
    const result = diagnoseTable({
      clientName: "Book",
      config: { standardTermsDays: 30, topAccountExternalIds: [], asOf: "2026-10-20" },
      table,
      runId: "excel-xlsx",
    });
    assert.equal(result.invoices[0].invoiceDate, "2026-08-01");
    assert.equal(result.invoices[0].dueDate, "2026-09-01");
    assert.equal(result.classifications[0].subcause, "missing_po");
    assert.equal(result.payload.client.erp_type, "excel");
  });
});

describe("viewer contract", () => {
  it("rejects an unauthenticated viewer and hides other clients' runs", () => {
    assert.throws(() => requireViewer(null), (error: unknown) => error instanceof LedgerError && error.code === "UNAUTHENTICATED");
    assert.throws(() => requireViewer(undefined), (error: unknown) => error instanceof LedgerError);
    assert.throws(
      () => authorizeRun("owner-a", "owner-b"),
      (error: unknown) => error instanceof LedgerError && error.code === "NOT_FOUND",
    );
    assert.doesNotThrow(() => authorizeRun("owner-a", "owner-a"));
  });

  it("sets inline, no-store headers and a watermark, and never a download disposition", () => {
    const headers = viewerResponseHeaders(Date.UTC(2026, 9, 25));
    assert.equal(headers["Content-Disposition"], "inline");
    assert.equal(headers["Cache-Control"], "no-store");
    assert.equal(headers["X-Frame-Options"], "DENY");
    assert.equal(headers["Content-Disposition"].includes("attachment"), false);
    assert.equal(watermark("Acme", "run-1", "2026-10-25T00:00:00.000Z"), "Acme · run-1 · 2026-10-25T00:00:00.000Z");
  });
});

function baseInvoice(partial: Partial<NormalizedInvoice> & Pick<NormalizedInvoice, "externalId" | "amountInrPaise" | "invoiceDate" | "dueDate">): NormalizedInvoice {
  return {
    customerExternalId: partial.externalId,
    customerName: partial.externalId,
    currency: "INR",
    sourceMinor: partial.amountInrPaise,
    status: "Overdue",
    poNumber: "PO",
    poColumn: true,
    gstin: "07AABCU9603R1ZM",
    branch: "Delhi",
    disputeFlag: false,
    contact: "ap@example.com",
    contactColumn: true,
    lastActionAt: "2026-09-28",
    lastActionColumn: true,
    ...partial,
  };
}
