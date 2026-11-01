import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv } from "./csv.ts";
import { parseDate } from "./dates.ts";
import { LedgerError } from "./errors.ts";
import {
  assembleRead,
  bucketOf,
  dsoDays,
  excelSafe,
  findHeaderIndex,
  mapFromLabels,
  partyKey,
  refuseWrongFile,
  suggestColumns,
} from "./ingest.ts";
import { parseAmountToMinor } from "./money.ts";

const TALLY = [
  "Bills Receivable",
  "Party Name,Bill Date,Bill Name,Pending Amount,Due Date",
  "ABC Pvt Ltd,,,,",
  ",01-04-2026,INV-1,\"1,00,000.00 Dr\",01-05-2026",
  ",15-04-2026,INV-2,\"50,000.00 Dr\",15-05-2026",
  ",,Sub Total,\"1,50,000.00 Dr\",",
  "ABC Private Limited,,,,",
  ",01-03-2026,INV-9,\"25,000.00 Cr\",01-04-2026",
  ",,On Account,\"10,000.00 Cr\",",
  "Grand Total,,,\"1,15,000.00 Dr\",",
].join("\n");

function tallyRead(asOf = "2026-11-01") {
  const table = parseCsv(TALLY);
  const headerIndex = findHeaderIndex(table);
  const labels = Object.fromEntries(suggestColumns(table[headerIndex] ?? []).map((field) => [field.field, field.column]));
  return assembleRead({
    table,
    headerIndex,
    map: mapFromLabels(table[headerIndex] ?? [], labels),
    clientName: "ABC",
    asOf,
    standardTermsDays: 30,
    topAccounts: [],
  });
}

describe("ingestion", () => {
  it("reads lakh-format Dr and Cr to the paisa", () => {
    assert.equal(parseAmountToMinor("1,23,45,678.00 Dr"), 1234567800);
    assert.equal(parseAmountToMinor("25,000.00 Cr"), -2500000);
    assert.equal(parseAmountToMinor("(1,000.50)"), -100050);
    assert.throws(() => parseAmountToMinor("1e5"), (error: unknown) => error instanceof LedgerError);
  });

  it("reads India dates, a two-digit month, a leap day, and an Excel serial", () => {
    assert.equal(parseDate("01-04-2026"), "2026-04-01");
    assert.equal(parseDate("1-Apr-26"), "2026-04-01");
    assert.equal(parseDate("29-02-2024"), "2024-02-29");
    assert.throws(() => parseDate("29-02-2026"), (error: unknown) => error instanceof LedgerError);
    assert.equal(parseDate("46113"), "2026-04-01");
  });

  it("carries the party, drops subtotals, keeps both partials, and matches the grand total", () => {
    const read = tallyRead();
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.reconcile.status, "matched");
    assert.equal(read.reconcile.tieOutMinor, 11500000);
    assert.equal(read.reconcile.outstandingMinor, 15000000);
    assert.equal(read.rows.length, 2);
    assert.equal(partyKey(read.rows[0]?.party ?? ""), partyKey("ABC Private Limited"));
    assert.equal(read.parties.length, 1);
    assert.equal(read.parties[0]?.minor, 15000000);
    assert.ok(read.blindSpots.some((line) => /dispute/i.test(line)));
    assert.equal(read.rows.every((row) => row.cause !== "missing_po"), true);
  });

  it("blocks a headline when the grand total does not tie", () => {
    const csv = TALLY.replace("1,15,000.00 Dr", "1,00,000.00 Dr");
    const table = parseCsv(csv);
    const headerIndex = findHeaderIndex(table);
    const labels = Object.fromEntries(suggestColumns(table[headerIndex] ?? []).map((field) => [field.field, field.column]));
    const read = assembleRead({
      table,
      headerIndex,
      map: mapFromLabels(table[headerIndex] ?? [], labels),
      clientName: "ABC",
      asOf: "2026-11-01",
      standardTermsDays: 30,
      topAccounts: [],
    });
    assert.equal(read.ok, false);
    if (read.ok) return;
    assert.equal(read.reconcile.status, "blocked");
    assert.match(read.reconcile.message, /No headline/);
  });

  it("refuses a profit-and-loss and a semicolon file still parses", () => {
    assert.match(refuseWrongFile(["Particulars", "Debit", "Credit"]) ?? "", /profit-and-loss/i);
    assert.equal(refuseWrongFile(["Party Name", "Pending Amount", "Due Date"]), null);
    const table = parseCsv("Party Name;Bill Date;Bill Name;Pending Amount;Due Date\nAcme;01-04-2026;INV-1;1000.00 Dr;01-05-2026\n");
    assert.equal(table[0]?.[0], "Party Name");
    assert.equal(table[1]?.[2], "INV-1");
  });

  it("keeps a repeated invoice number as two partials", () => {
    const csv = [
      "Party Name,Bill Date,Bill Name,Pending Amount,Due Date",
      "Acme,01-04-2026,INV-1,60.00 Dr,01-05-2026",
      "Acme,01-04-2026,INV-1,40.00 Dr,01-05-2026",
      "Grand Total,, ,100.00 Dr,",
    ].join("\n");
    const table = parseCsv(csv);
    const headerIndex = 0;
    const labels = Object.fromEntries(suggestColumns(table[0] ?? []).map((field) => [field.field, field.column]));
    const read = assembleRead({
      table,
      headerIndex,
      map: mapFromLabels(table[0] ?? [], labels),
      clientName: "Acme",
      asOf: "2026-11-01",
      standardTermsDays: 30,
      topAccounts: [],
    });
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.rows.length, 2);
    assert.equal(read.reconcile.status, "matched");
  });

  it("ages on the as-of date: day 0, day 30, day 31, and a leap day", () => {
    assert.equal(bucketOf("2026-11-01", "2026-11-01"), "current");
    assert.equal(bucketOf("2026-10-02", "2026-11-01"), "d30");
    assert.equal(bucketOf("2026-10-01", "2026-11-01"), "d60");
    assert.equal(bucketOf("2024-02-29", "2024-03-30"), "d30");
    assert.equal(dsoDays(100, 0, 365), null);
    assert.equal(dsoDays(100, 100, 365), 365);
  });

  it("matches a fuzzed book to the paisa", () => {
    let seed = 11;
    const next = () => {
      seed = (seed * 16807) % 2147483647;
      return seed;
    };
    for (let n = 0; n < 20; n += 1) {
      const count = 3 + (next() % 8);
      const lines = ["Party Name,Bill Date,Bill Name,Pending Amount,Due Date"];
      let total = 0;
      for (let i = 0; i < count; i += 1) {
        const paise = 100 + (next() % 500000);
        total += paise;
        const rupees = (paise / 100).toFixed(2);
        lines.push(`Party ${i % 3},01-04-2026,INV-${n}-${i},${rupees} Dr,01-05-2026`);
      }
      lines.push(`Grand Total,,,${(total / 100).toFixed(2)} Dr,`);
      const table = parseCsv(lines.join("\n"));
      const labels = Object.fromEntries(suggestColumns(table[0] ?? []).map((field) => [field.field, field.column]));
      const read = assembleRead({
        table,
        headerIndex: 0,
        map: mapFromLabels(table[0] ?? [], labels),
        clientName: "Fuzz",
        asOf: "2026-11-01",
        standardTermsDays: 45,
        topAccounts: [],
      });
      assert.equal(read.ok, true);
      if (!read.ok) return;
      assert.equal(read.reconcile.tieOutMinor, total);
      assert.equal(read.reconcile.status, "matched");
    }
  });

  it("neutralises a spreadsheet formula in a party name", () => {
    assert.equal(excelSafe('=HYPERLINK("http://evil","Acme")'), `'=HYPERLINK("http://evil","Acme")`);
    assert.equal(excelSafe("Acme"), "Acme");
  });
});
