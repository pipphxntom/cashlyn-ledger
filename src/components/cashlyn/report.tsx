import type { CauseName, PublicBook } from "@/lib/ledger/preview-public";

const CAUSE: Record<CauseName, string> = {
  process: "Process",
  power: "Power",
  terms: "Terms",
  distress: "Distress",
  unknown: "Not named",
};

const CAUSE_LINE: Record<CauseName, string> = {
  process: "A tighter motion can move it.",
  power: "They pay when they decide.",
  terms: "The clock was set too long.",
  distress: "Most of this will not come back from a reminder.",
  unknown: "The delay is real. The name is not.",
};

const SUBCAUSE: Record<string, string> = {
  missing_po: "Missing purchase order",
  open_dispute: "Open dispute",
  wrong_or_missing_contact: "Wrong or missing contact",
  no_follow_up: "No follow-up",
  late_without_cadence: "Late, no cadence",
  top_account: "Top account",
  terms_beyond_standard: "Terms longer than usual",
  chronic_delinquency: "Chronic delinquency",
  unclassified: "Not classified",
};

const ORDER: CauseName[] = ["process", "power", "terms", "distress", "unknown"];

function cr(value: number): string {
  return `₹${value.toFixed(2)} Cr`;
}

function mail(kind: "call" | "buy", company: string): string {
  const subject = kind === "call" ? `Book a call — ${company}` : `Buy the diagnostic — ${company}`;
  const body =
    kind === "call"
      ? `I saw the trapped-cash read for ${company}. I want 20 minutes on what to do with it.`
      : `I want the full diagnostic for ${company}. I understand the fee is ₹1.5–2.5 lakh.`;
  return `mailto:shwetank@cashlyn.works?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function leadOf(book: PublicBook): { cause: CauseName; amount: number } {
  let cause: CauseName = "unknown";
  let amount = -1;
  for (const name of ORDER) {
    const next = book.byCause[name].amount_inr_cr;
    if (next > amount) {
      cause = name;
      amount = next;
    }
  }
  return { cause, amount: Math.max(0, amount) };
}

function place(entity: { gstin: string; branch: string }): string {
  if (entity.gstin && entity.branch) return `${entity.branch} · ${entity.gstin}`;
  return entity.branch || entity.gstin || "Unassigned";
}

export function Offer({ company, onBook }: { company: string; onBook?: () => void }) {
  return (
    <div className="card mx-auto max-w-xl px-6 py-7 sm:px-8">
      <p className="eyebrow">If you want it argued</p>
      <h3 className="mt-3 text-2xl tracking-tight text-cream sm:text-3xl">
        The read is above. <em className="font-serif font-normal italic">The room is the call.</em>
      </h3>
      <p className="mt-4 text-base leading-relaxed text-cream-dim">
        Take this split into a CFO meeting, or have it turned into the Monday list. That part is the diagnostic.
      </p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <a
          href={mail("call", company)}
          onClick={() => onBook?.()}
          className="rounded-full bg-gold px-5 py-3.5 text-center text-base font-medium text-ink hover:bg-gold-2"
        >
          Book a 20-minute call
        </a>
        <a
          href={mail("buy", company)}
          className="rounded-full border border-line-strong px-5 py-3.5 text-center text-base text-cream hover:border-gold"
        >
          Buy the diagnostic
        </a>
      </div>
      <p className="mt-4 text-sm text-stone">₹1.5–2.5 lakh. shwetank@cashlyn.works</p>
    </div>
  );
}

export function Report({ book, kicker, onBook }: { book: PublicBook; kicker: string; onBook?: () => void }) {
  const pct = Math.round(book.pctOfAr * 100);
  const lead = leadOf(book);

  return (
    <article id="book" className="mx-auto w-full max-w-3xl">
      <p className="eyebrow">{kicker}</p>
      <h2 className="mt-4 text-2xl font-medium tracking-tight text-cream sm:text-3xl">{book.clientName}</h2>
      <p className="mt-8 font-mono text-5xl tracking-tight text-cream sm:text-7xl">{cr(book.trappedCr)}</p>
      <p className="mt-4 max-w-xl text-xl leading-snug text-cream">is sitting past the agreed terms.</p>
      <p className="lede mt-4 max-w-xl">
        About {pct}% of the open book. Roughly {book.daysOfWc} days of working capital. Read as of {book.asOf}, against a{" "}
        {book.standardTermsDays}-day credit period. The largest slice is {CAUSE[lead.cause].toLowerCase()},{" "}
        {cr(lead.amount)}. {CAUSE_LINE[lead.cause]}
      </p>

      <section className="mt-14">
        <p className="eyebrow">Why it is stuck</p>
        <ul className="mt-6 space-y-5">
          {ORDER.map((cause) => {
            const slice = book.byCause[cause];
            const width = Math.max(0, Math.min(100, Math.round(slice.pct * 100)));
            return (
              <li key={cause}>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-cream">{CAUSE[cause]}</span>
                  <span className="font-mono text-sm text-cream">
                    {cr(slice.amount_inr_cr)} · {width}%
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
                  <div className="h-full rounded-full bg-gold" style={{ width: `${width}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-14">
        <p className="eyebrow">Cash a process fix can ask for</p>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-stone">
          Cumulative, and conservative. Power and terms are not treated as cash a reminder will bring back.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {(
            [
              ["30 days", book.cashMap.d30],
              ["60 days", book.cashMap.d60],
              ["90 days", book.cashMap.d90],
            ] as const
          ).map(([label, amount]) => (
            <div key={label} className="card px-5 py-5">
              <p className="font-mono text-2xl text-cream">{cr(amount)}</p>
              <p className="mt-2 text-sm text-stone">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {book.topSubcauses.length > 0 ? (
        <section className="mt-14">
          <p className="eyebrow">Inside the process slice</p>
          <ul className="mt-6 divide-y divide-line">
            {book.topSubcauses.map((row) => (
              <li key={row.subcause} className="flex items-baseline justify-between gap-4 py-4">
                <span className="text-cream">{SUBCAUSE[row.subcause] ?? row.subcause}</span>
                <span className="shrink-0 font-mono text-sm text-stone">
                  {cr(row.amountCr)} · {row.windowDays}d
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {book.quickWins.length > 0 ? (
        <section className="mt-14">
          <p className="eyebrow">What to do first</p>
          <ol className="mt-6 space-y-4">
            {book.quickWins.map((line) => (
              <li key={line} className="text-base leading-relaxed text-cream-dim">
                {line}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {book.byEntity.length > 0 ? (
        <section className="mt-14">
          <p className="eyebrow">Where it sits</p>
          <ul className="mt-6 divide-y divide-line">
            {book.byEntity.map((entity) => (
              <li key={`${entity.gstin}-${entity.branch}`} className="flex items-baseline justify-between gap-4 py-4">
                <span className="text-cream">{place(entity)}</span>
                <span className="shrink-0 font-mono text-sm text-stone">{cr(entity.trappedCr)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-16">
        <Offer company={book.clientName} onBook={onBook} />
      </div>
    </article>
  );
}
