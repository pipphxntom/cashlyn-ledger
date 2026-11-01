import { daysBetween } from "./dates.ts";
import { allocateCrore, paiseToCrore, round2 } from "./money.ts";
import type { NormalizedInvoice } from "./normalize.ts";
import type { ErpType } from "./mapping.ts";
import { CAUSES, isOpen, type Cause, type Classification } from "./rules.ts";

export type CauseSlice = { amount_inr_cr: number; pct: number };

export type LedgerPayload = {
  run_id: string;
  client: {
    name: string;
    erp_type: ErpType;
    standard_terms_days: number;
    base_currency: "INR";
  };
  as_of: string;
  fx_rates_snapshot: Record<string, number>;
  headline: {
    trapped_cash_inr_cr: number;
    pct_of_ar: number;
    days_of_wc: number;
  };
  by_cause: Record<Cause, CauseSlice>;
  by_entity: Array<{ gstin: string; branch: string; trapped_cash_inr_cr: number }>;
  top_subcauses: Array<{ subcause: string; amount_inr_cr: number; window_days: number }>;
  cash_map_30_60_90: { d30: number; d60: number; d90: number };
  quick_wins: string[];
  notes: string[];
};

const QUICK_WIN: Record<string, string> = {
  wrong_or_missing_contact:
    "Update the billing contact on every account in the missing-contact bucket before the next statement. Wrong inboxes are a 30-day cash item.",
  missing_po:
    "Stop sending invoices that leave without a PO number. This bucket is paperwork, not a customer who will not pay.",
  open_dispute:
    "Put a named owner and an age limit on every open dispute. Unowned disputes do not get collected.",
  no_follow_up:
    "Put a first touch on these invoices inside seven days. The balance is late because nobody asked.",
  late_without_cadence:
    "Add a pre-due reminder at day −7 for invoices above your threshold. The cadence is missing, the customer is not.",
};

export function daysOfWorkingCapital(
  openInvoices: NormalizedInvoice[],
  trappedPaise: number,
  asOf: string,
): number {
  const total = openInvoices.reduce((sum, invoice) => sum + invoice.amountInrPaise, 0);
  if (total <= 0 || trappedPaise <= 0) return 0;
  const weighted = openInvoices.reduce((sum, invoice) => {
    const age = Math.max(0, daysBetween(invoice.invoiceDate, asOf));
    return sum + invoice.amountInrPaise * age;
  }, 0);
  const weightedAge = weighted / total;
  return Math.round((trappedPaise / total) * weightedAge);
}

function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 10_000) / 10_000;
}

export function buildPayload(input: {
  runId: string;
  clientName: string;
  erpType: ErpType;
  standardTermsDays: number;
  asOf: string;
  fxRatesSnapshot: Record<string, number>;
  invoices: NormalizedInvoice[];
  classifications: Classification[];
}): LedgerPayload {
  const open = input.invoices.filter(isOpen);
  const classById = new Map(input.classifications.map((row) => [row.externalId, row]));
  const overdue = open.filter((invoice) => classById.has(invoice.externalId));
  const trappedPaise = overdue.reduce((sum, invoice) => sum + invoice.amountInrPaise, 0);
  const totalPaise = open.reduce((sum, invoice) => sum + invoice.amountInrPaise, 0);

  const causePaise = new Map<Cause, number>(CAUSES.map((cause) => [cause, 0]));
  for (const invoice of overdue) {
    const classification = classById.get(invoice.externalId);
    if (!classification) continue;
    causePaise.set(classification.cause, (causePaise.get(classification.cause) ?? 0) + invoice.amountInrPaise);
  }
  const causeOrder = CAUSES.map((cause) => causePaise.get(cause) ?? 0);
  const causeCrore = allocateCrore(causeOrder);
  const by_cause = {} as Record<Cause, CauseSlice>;
  CAUSES.forEach((cause, index) => {
    by_cause[cause] = {
      amount_inr_cr: causeCrore[index] ?? 0,
      pct: ratio(causeOrder[index] ?? 0, trappedPaise),
    };
  });

  const entityMap = new Map<string, { gstin: string; branch: string; paise: number }>();
  for (const invoice of overdue) {
    const key = `${invoice.gstin}||${invoice.branch}`;
    const current = entityMap.get(key) ?? { gstin: invoice.gstin, branch: invoice.branch, paise: 0 };
    current.paise += invoice.amountInrPaise;
    entityMap.set(key, current);
  }
  const entities = [...entityMap.values()].sort((a, b) => a.gstin.localeCompare(b.gstin) || a.branch.localeCompare(b.branch));
  const entityCrore = allocateCrore(entities.map((entity) => entity.paise));
  const by_entity = entities.map((entity, index) => ({
    gstin: entity.gstin,
    branch: entity.branch,
    trapped_cash_inr_cr: entityCrore[index] ?? 0,
  }));

  const subMap = new Map<string, { paise: number; window: number }>();
  for (const invoice of overdue) {
    const classification = classById.get(invoice.externalId);
    if (!classification || classification.cause !== "process" || classification.windowDays === null) continue;
    const current = subMap.get(classification.subcause) ?? { paise: 0, window: classification.windowDays };
    current.paise += invoice.amountInrPaise;
    subMap.set(classification.subcause, current);
  }
  const top_subcauses = [...subMap.entries()]
    .sort((a, b) => b[1].paise - a[1].paise || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([subcause, value]) => ({
      subcause,
      amount_inr_cr: paiseToCrore(value.paise),
      window_days: value.window,
    }));

  const recoverableWithin = (days: number) =>
    overdue.reduce((sum, invoice) => {
      const classification = classById.get(invoice.externalId);
      if (!classification || classification.cause !== "process" || classification.windowDays === null) return sum;
      if (classification.windowDays <= days) return sum + classification.recoverablePaise;
      return sum;
    }, 0);

  const quick_wins = top_subcauses
    .map((row) => QUICK_WIN[row.subcause])
    .filter((line): line is string => Boolean(line));

  return {
    run_id: input.runId,
    client: {
      name: input.clientName,
      erp_type: input.erpType,
      standard_terms_days: input.standardTermsDays,
      base_currency: "INR",
    },
    as_of: input.asOf,
    fx_rates_snapshot: input.fxRatesSnapshot,
    headline: {
      trapped_cash_inr_cr: paiseToCrore(trappedPaise),
      pct_of_ar: ratio(trappedPaise, totalPaise),
      days_of_wc: daysOfWorkingCapital(open, trappedPaise, input.asOf),
    },
    by_cause,
    by_entity,
    top_subcauses,
    cash_map_30_60_90: {
      d30: paiseToCrore(recoverableWithin(30)),
      d60: paiseToCrore(recoverableWithin(60)),
      d90: paiseToCrore(recoverableWithin(90)),
    },
    quick_wins,
    notes: ["conservative; power and terms excluded from recoverable"],
  };
}

export function payloadIsDeterministicShape(payload: LedgerPayload): boolean {
  const causeSum = round2(CAUSES.reduce((sum, cause) => sum + payload.by_cause[cause].amount_inr_cr, 0));
  return causeSum === payload.headline.trapped_cash_inr_cr;
}
