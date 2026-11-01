import type { LogicalField } from "@/lib/ledger/mapping";
import { FIELD_LABEL } from "@/lib/ledger/ingest";

const FIELDS: LogicalField[] = [
  "customer_name",
  "customer_external_id",
  "external_id",
  "amount",
  "invoice_date",
  "due_date",
  "credit_days",
  "currency",
  "po_number",
  "dispute",
  "contact",
  "last_action",
];

const TERMS = [30, 45, 60, 90] as const;

export function MapStep(props: {
  headers: string[];
  labels: Partial<Record<LogicalField, string>>;
  remembered: boolean;
  asOf: string;
  terms: number;
  customTerms: boolean;
  revenue: string;
  periodDays: string;
  onLabel: (field: LogicalField, column: string) => void;
  onAsOf: (value: string) => void;
  onTerms: (days: number, custom: boolean) => void;
  onRevenue: (value: string) => void;
  onPeriod: (value: string) => void;
  onConfirm: () => void;
}) {
  const party = Boolean(props.labels.customer_name || props.labels.customer_external_id);
  const due = Boolean(props.labels.due_date || props.labels.credit_days);
  const ready = party && Boolean(props.labels.amount && props.labels.invoice_date && props.labels.external_id && due);

  return (
    <div id="map" className="card mx-auto mt-8 max-w-xl px-5 py-6 sm:px-8">
      <p className="text-lg text-cream">We think these are the columns. Confirm them.</p>
      <p className="mt-2 text-sm leading-relaxed text-stone">
        {props.remembered
          ? "This layout matches a map you confirmed before. Check it. A wrong column is a wrong number."
          : "Nothing is decided until you say so. Leave a column blank if the file does not have it."}
      </p>
      <div className="mt-5 space-y-3">
        {FIELDS.map((field) => (
          <label key={field} className="grid grid-cols-[9rem_1fr] items-center gap-3 text-sm">
            <span className="text-stone">{FIELD_LABEL[field]}</span>
            <select
              value={props.labels[field] ?? ""}
              onChange={(event) => props.onLabel(field, event.target.value)}
              className="rounded-xl border border-line bg-ink px-3 py-2 text-cream outline-none focus:border-gold"
            >
              <option value="">Not in this file</option>
              {props.headers.map((header) => (
                <option key={header} value={header}>
                  {header}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm text-stone">Age the book as of this date. Not the server clock.</span>
          <input
            type="date"
            value={props.asOf}
            onChange={(event) => props.onAsOf(event.target.value)}
            className="mt-2 w-full rounded-2xl border border-line bg-ink px-4 py-3 text-cream outline-none focus:border-gold"
          />
        </label>
        <div>
          <p className="text-sm text-stone">Usual credit period</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {TERMS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => props.onTerms(days, false)}
                className={
                  !props.customTerms && props.terms === days
                    ? "rounded-full bg-cream px-4 py-2 text-sm font-medium text-ink"
                    : "rounded-full border border-line px-4 py-2 text-sm text-cream"
                }
              >
                {days} days
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="text-sm text-stone">Revenue for DSO, rupees. Leave blank if you do not have it.</span>
          <input
            inputMode="decimal"
            value={props.revenue}
            onChange={(event) => props.onRevenue(event.target.value)}
            placeholder="Optional"
            className="mt-2 w-full rounded-2xl border border-line bg-ink px-4 py-3 text-cream outline-none focus:border-gold"
          />
        </label>
        <label className="block">
          <span className="text-sm text-stone">Days in that revenue period</span>
          <input
            inputMode="numeric"
            value={props.periodDays}
            onChange={(event) => props.onPeriod(event.target.value.replace(/[^\d]/g, ""))}
            className="mt-2 w-28 rounded-2xl border border-line bg-ink px-4 py-3 font-mono text-cream outline-none focus:border-gold"
          />
        </label>
      </div>
      <button
        type="button"
        disabled={!ready}
        onClick={props.onConfirm}
        className="mt-6 w-full rounded-full bg-gold px-5 py-3.5 text-base font-medium text-ink hover:bg-gold-2 disabled:opacity-40"
      >
        {ready ? "Confirm and tie the total" : "Map the customer, the invoice, the amount, and both dates"}
      </button>
    </div>
  );
}
