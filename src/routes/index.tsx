import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { MapStep } from "@/components/cashlyn/map-step";
import { Readout } from "@/components/cashlyn/readout";
import { Report } from "@/components/cashlyn/report";
import { parseCsv } from "@/lib/ledger/csv";
import { rememberFunnel } from "@/lib/ledger/funnel";
import {
  assembleRead,
  findHeaderIndex,
  headerSignature,
  mapFromLabels,
  refuseWrongFile,
  suggestColumns,
  type BlockedRead,
  type BucketName,
  type LocalRead,
} from "@/lib/ledger/ingest";
import type { LogicalField } from "@/lib/ledger/mapping";
import { SAMPLE_BOOK, acceptUpload } from "@/lib/ledger/preview-public";
import { chooseTable } from "@/lib/ledger/read-book";

export const Route = createFileRoute("/")({
  component: Home,
});

const TEMPLATE = "cashlyn-map:";

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [hot, setHot] = useState(false);
  const [error, setError] = useState("");
  const [table, setTable] = useState<string[][] | null>(null);
  const [headerIndex, setHeaderIndex] = useState(0);
  const [labels, setLabels] = useState<Partial<Record<LogicalField, string>>>({});
  const [remembered, setRemembered] = useState(false);
  const [name, setName] = useState("");
  const [terms, setTerms] = useState(45);
  const [customTerms, setCustomTerms] = useState(false);
  const [asOf, setAsOf] = useState(todayIso);
  const [revenue, setRevenue] = useState("");
  const [periodDays, setPeriodDays] = useState("365");
  const [tops, setTops] = useState("");
  const [read, setRead] = useState<LocalRead | null>(null);
  const [blocked, setBlocked] = useState<BlockedRead | null>(null);
  const [filter, setFilter] = useState<{ bucket?: BucketName; party?: string } | null>(null);
  const [previous, setPrevious] = useState<string[]>([]);
  const [sample, setSample] = useState(true);

  const headers = table?.[headerIndex] ?? [];

  function openTable(next: string[][], label: string) {
    const headerAt = findHeaderIndex(next);
    const header = next[headerAt] ?? [];
    const wrong = refuseWrongFile(header);
    if (wrong) {
      setError(wrong);
      setTable(null);
      return;
    }
    const suggested = Object.fromEntries(suggestColumns(header).map((field) => [field.field, field.column]));
    let saved: Partial<Record<LogicalField, string>> | null = null;
    try {
      const raw = localStorage.getItem(TEMPLATE + headerSignature(header));
      saved = raw ? (JSON.parse(raw) as Partial<Record<LogicalField, string>>) : null;
    } catch {
      saved = null;
    }
    setTable(next);
    setHeaderIndex(headerAt);
    setLabels(saved ?? suggested);
    setRemembered(Boolean(saved));
    setFileName(label);
    setRead(null);
    setBlocked(null);
    setFilter(null);
    setSample(false);
    setError("");
    if (!name) setName(label.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  }

  async function takeFile(file: File | null) {
    if (!file) return;
    const accepted = acceptUpload(file.name, file.size);
    if (!accepted.ok) {
      setError(accepted.message);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("Keep the file under 8 MB.");
      return;
    }
    rememberFunnel("upload_started");
    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".xls") && !lower.endsWith(".xlsx")) {
        setError("Save that workbook as .xlsx. The old .xls format is not read.");
        return;
      }
      let next: string[][];
      if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
        next = parseCsv(await file.text());
      } else {
        const { parseXlsxSheets } = await import("@/lib/ledger/xlsx");
        const bytes = new Uint8Array(await file.arrayBuffer());
        next = chooseTable(await parseXlsxSheets(bytes));
      }
      openTable(next, file.name);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not read that file.";
      setError(/password|encrypt/i.test(message) ? "This workbook is protected. Remove the password and try again." : message);
    }
  }

  async function loadSample() {
    const response = await fetch("/sample-bills-receivable.csv");
    openTable(parseCsv(await response.text()), "Sample bills receivable");
    setName("Sample Traders");
  }

  function confirm() {
    if (!table) return;
    rememberFunnel("mapping_confirmed");
    try {
      localStorage.setItem(TEMPLATE + headerSignature(headers), JSON.stringify(labels));
    } catch {
      // The map still applies for this read.
    }
    const revenueInr = Number(revenue.replace(/,/g, ""));
    let result: LocalRead | BlockedRead;
    try {
      result = assembleRead({
        table,
        headerIndex,
        map: mapFromLabels(headers, labels),
        clientName: name || fileName || "Your company",
        asOf,
        standardTermsDays: terms,
        topAccounts: tops.split(/[\n,]/).map((part) => part.trim()).filter(Boolean),
        revenueInr: Number.isFinite(revenueInr) && revenueInr > 0 ? revenueInr : null,
        periodDays: Number(periodDays) || 365,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read that file.");
      return;
    }
    if (!result.ok) {
      rememberFunnel("reconciliation_blocked");
      setBlocked(result);
      setRead(null);
      return;
    }
    if (result.reconcile.status === "matched") rememberFunnel("reconciliation_passed");
    rememberFunnel("headline_viewed");
    setPrevious(read ? [...new Set(read.rows.filter((row) => row.overdue).map((row) => row.partyKey))] : previous);
    setRead(result);
    setBlocked(null);
    setFilter(null);
    window.setTimeout(() => document.getElementById("sheet")?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
  }

  function forget() {
    setTable(null);
    setRead(null);
    setBlocked(null);
    setFilter(null);
    setLabels({});
    setFileName("");
    setSample(true);
  }

  const chronic =
    read === null
      ? []
      : read.parties.filter((party) => previous.includes(party.key) && previous.length > 0).map((party) => party.name);

  return (
    <div className="relative min-h-screen bg-ink text-cream">
      <div className="grain pointer-events-none absolute inset-0" />
      <header className="no-print relative mx-auto flex h-16 max-w-5xl items-center justify-between px-5 sm:h-20 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5">
          <img src="/cashlyn-mark.png" alt="" width={40} height={40} className="h-10 w-10" />
          <span className="text-base font-medium tracking-tight">Cashlyn</span>
        </a>
        <a href="#read" className="rounded-full bg-cream px-4 py-2.5 text-sm font-medium text-ink hover:bg-white">
          Read a book
        </a>
      </header>

      <main id="top" className="relative mx-auto max-w-5xl px-5 pb-24 sm:px-8">
        <section className="no-print mx-auto max-w-3xl pt-10 text-center sm:pt-16">
          <p className="eyebrow">Order-to-cash for the mid-market</p>
          <h1 className="display mx-auto mt-5 text-cream">
            See the cash <em className="font-serif font-normal italic">trapped</em> in the aging
          </h1>
          <p className="lede mx-auto mt-6 max-w-xl">
            The file stays on this machine. You confirm the columns. The total has to match before a number is shown.
          </p>
        </section>

        <section id="read" className="no-print card mx-auto mt-12 max-w-xl px-5 py-6 sm:px-8 sm:py-8">
          <p className="text-lg text-cream">Start with the file.</p>
          <p className="mt-1 text-sm leading-relaxed text-stone">
            Zoho, Tally, Busy, SAP, or the aging workbook. Parsed here. Not uploaded.
          </p>
          <div
            className={`relative mt-5 rounded-2xl border border-dashed px-4 py-6 text-center ${hot ? "border-gold" : "border-line-strong"}`}
            onDragOver={(event) => {
              event.preventDefault();
              setHot(true);
            }}
            onDragLeave={() => setHot(false)}
            onDrop={(event) => {
              event.preventDefault();
              setHot(false);
              void takeFile(event.dataTransfer.files?.[0] ?? null);
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.txt,.xlsx,.xls,text/csv"
              className="absolute h-px w-px opacity-0"
              onChange={(event) => {
                void takeFile(event.target.files?.[0] ?? null);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-full bg-cream px-5 py-3 text-sm font-medium text-ink hover:bg-white"
            >
              {fileName ? "Choose a different file" : "Choose the export"}
            </button>
            <p className="mt-3 text-cream">{fileName || "or drop it here"}</p>
          </div>
          <button type="button" onClick={() => void loadSample()} className="mt-4 text-sm text-stone underline-offset-4 hover:text-cream hover:underline">
            No file yet — try a sample bills-receivable export
          </button>
          <p className="mt-4 text-sm text-stone">
            <Link to="/privacy" className="underline-offset-4 hover:text-cream hover:underline">
              Your data never leaves this machine.
            </Link>
          </p>
          {error ? <p className="mt-4 text-sm text-gold">{error}</p> : null}
        </section>

        {table && !read && !blocked ? (
          <div className="no-print">
            <MapStep
              headers={headers.filter(Boolean)}
              labels={labels}
              remembered={remembered}
              asOf={asOf}
              terms={terms}
              customTerms={customTerms}
              revenue={revenue}
              periodDays={periodDays}
              onLabel={(field, column) => setLabels((current) => ({ ...current, [field]: column }))}
              onAsOf={setAsOf}
              onTerms={(days, custom) => {
                setCustomTerms(custom);
                setTerms(days);
              }}
              onRevenue={setRevenue}
              onPeriod={setPeriodDays}
              onConfirm={confirm}
            />
            <label className="mx-auto mt-4 block max-w-xl text-sm text-stone">
              Names that pay when they feel like it, one per line. Optional.
              <textarea
                value={tops}
                onChange={(event) => setTops(event.target.value)}
                rows={2}
                className="mt-2 w-full rounded-2xl border border-line bg-ink px-4 py-3 text-cream outline-none focus:border-gold"
              />
            </label>
          </div>
        ) : null}

        {blocked ? (
          <section className="no-print mx-auto mt-10 max-w-xl">
            <p className="text-lg leading-snug text-gold">{blocked.reconcile.message}</p>
            <ul className="mt-4 space-y-1 text-sm text-stone">
              {blocked.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <button type="button" onClick={forget} className="mt-4 text-sm text-stone">
              Forget this read
            </button>
          </section>
        ) : null}

        <div id="sheet">
          {read ? (
            <Readout
              read={read}
              filter={filter}
              chronic={chronic}
              onFilter={setFilter}
              onPrint={() => {
                rememberFunnel("report_downloaded");
                window.print();
              }}
              onForget={forget}
            />
          ) : null}
          <section className="mt-16 sm:mt-20">
            {read ? (
              <Report book={read.book} kicker={read.reconcile.status === "matched" ? "Tied to the file" : "Not tied to a grand total"} onBook={() => rememberFunnel("call_booked")} />
            ) : !table && !blocked ? (
              <Report book={SAMPLE_BOOK} kicker="A sample book" onBook={() => rememberFunnel("call_booked")} />
            ) : null}
          </section>
        </div>

        <section className="no-print mx-auto mt-20 grid max-w-3xl gap-10 sm:grid-cols-3">
          {(
            [
              ["01", "From the file", "Buckets, concentration, the total. Click a number and the rows are under it."],
              ["02", "Needs a column", "A missing PO, a bad contact, a dispute. Only if you mapped that column."],
              ["03", "Not in an aging", "Who was chased, and why they stalled. That is the paid diagnostic."],
            ] as const
          ).map(([n, title, body]) => (
            <div key={n}>
              <p className="font-mono text-sm text-gold">{n}</p>
              <h3 className="mt-3 text-xl tracking-tight">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-stone">{body}</p>
            </div>
          ))}
        </section>

        <footer className="no-print mx-auto mt-20 max-w-3xl border-t border-line pt-6 text-sm text-stone">
          Cashlyn. {sample ? "The sample below is not your book." : "This read is on this machine only."}
        </footer>
      </main>
    </div>
  );
}
