import type { BucketName, DrillRow, LocalRead } from "@/lib/ledger/ingest";
import { excelSafe } from "@/lib/ledger/ingest";

function money(minor: number, currency: string): string {
  const formatted = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Math.abs(minor) / 100,
  );
  return `${minor < 0 ? "−" : ""}${currency} ${formatted}`;
}

export function Readout(props: {
  read: LocalRead;
  filter: { bucket?: BucketName; party?: string } | null;
  chronic: string[];
  onFilter: (next: { bucket?: BucketName; party?: string } | null) => void;
  onPrint: () => void;
  onForget: () => void;
}) {
  const { read } = props;
  const shown = read.rows.filter((row) => {
    if (!props.filter) return false;
    if (props.filter.bucket && row.bucket !== props.filter.bucket) return false;
    if (props.filter.party && row.partyKey !== props.filter.party) return false;
    return true;
  });
  const tone =
    read.reconcile.status === "matched" ? "text-cream" : "text-gold";

  return (
    <div className="mx-auto mt-16 max-w-3xl">
      <p className={`text-lg leading-snug ${tone}`}>{read.reconcile.message}</p>
      {read.reconcile.status === "unconfirmed" ? (
        <p className="mt-2 text-sm text-stone">This is not a tie-out. Do not forward it as one.</p>
      ) : null}
      {props.chronic.length > 0 ? (
        <p className="mt-3 text-sm text-stone">
          Still overdue in the previous file: {props.chronic.join(", ")}.
        </p>
      ) : null}
      <div className="mt-8 grid gap-3 sm:grid-cols-5">
        {read.buckets.map((bucket) => (
          <button
            key={bucket.bucket}
            type="button"
            onClick={() => props.onFilter({ bucket: bucket.bucket })}
            className="card px-3 py-4 text-left hover:border-gold"
          >
            <p className="font-mono text-sm text-cream">{money(bucket.minor, read.reconcile.currency)}</p>
            <p className="mt-2 text-xs text-stone">
              {bucket.label} · {bucket.count}
            </p>
          </button>
        ))}
      </div>
      {read.dso !== null ? (
        <p className="mt-6 text-sm text-cream">DSO {read.dso} days, from the revenue you typed. Data, not a guess.</p>
      ) : (
        <p className="mt-6 text-sm text-stone">DSO is blank. An aging without revenue cannot produce it.</p>
      )}
      {read.parties.length > 0 ? (
        <ul className="mt-8 divide-y divide-line">
          {read.parties.map((party) => (
            <li key={party.key}>
              <button
                type="button"
                onClick={() => props.onFilter({ party: party.key })}
                className="flex w-full items-baseline justify-between gap-4 py-3 text-left"
              >
                <span className="text-cream">{excelSafe(party.name)}</span>
                <span className="font-mono text-sm text-stone">
                  {money(party.minor, read.reconcile.currency)} · {party.count}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="no-print mt-6">
        <div className="flex gap-4 text-sm">
          <button type="button" onClick={props.onPrint} className="text-gold">
            Print the one-page PDF
          </button>
          <button type="button" onClick={props.onForget} className="text-stone">
            Forget this read
          </button>
          {props.filter ? (
            <button type="button" onClick={() => props.onFilter(null)} className="text-stone">
              Clear the rows
            </button>
          ) : null}
        </div>
        {props.filter ? (
          <Rows rows={shown.slice(0, 40)} currency={read.reconcile.currency} more={Math.max(0, shown.length - 40)} />
        ) : (
          <p className="mt-3 text-sm text-stone">Click a bucket or a customer to see the rows behind the number.</p>
        )}
      </div>
      {read.warnings.length > 0 ? (
        <ul className="mt-6 space-y-1 text-sm text-stone">
          {read.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-8">
        <p className="eyebrow">What this file cannot tell you</p>
        <ul className="mt-4 space-y-2 text-sm leading-relaxed text-stone">
          {read.blindSpots.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Rows({ rows, currency, more }: { rows: DrillRow[]; currency: string; more: number }) {
  if (rows.length === 0) return <p className="mt-3 text-sm text-stone">No rows in that slice.</p>;
  return (
    <ul className="mt-4 divide-y divide-line">
      {rows.map((row) => (
        <li key={row.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
          <span className="text-cream">
            {excelSafe(row.party)} · {excelSafe(row.id)}
          </span>
          <span className="shrink-0 font-mono text-stone">
            {money(row.minor, currency)} · {row.evidence === "hypothesis" ? "hypothesis" : row.cause}
          </span>
        </li>
      ))}
      {more > 0 ? <li className="py-2 text-sm text-stone">{more} more rows sit under this number.</li> : null}
    </ul>
  );
}
