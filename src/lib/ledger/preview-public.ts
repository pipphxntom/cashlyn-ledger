export type CauseName = "process" | "power" | "terms" | "distress" | "unknown";

export type BookTeaser = {
  clientName: string;
  asOf: string;
  trappedCr: number;
  pctOfAr: number;
  daysOfWc: number;
  leadCause: CauseName;
  leadCr: number;
};

/** The public sample. Kept as data so the browser never receives the full engine output. */
export const SAMPLE_TEASER: BookTeaser = {
  clientName: "Aravali Components",
  asOf: "2026-10-01",
  trappedCr: 3.98,
  pctOfAr: 0.9734,
  daysOfWc: 102,
  leadCause: "process",
  leadCr: 1.98,
};

export type CauseSlice = { amount_inr_cr: number; pct: number };

export type PublicBook = {
  clientName: string;
  asOf: string;
  erpType: "zoho" | "tally" | "excel";
  standardTermsDays: number;
  trappedCr: number;
  pctOfAr: number;
  daysOfWc: number;
  byCause: Record<CauseName, CauseSlice>;
  byEntity: Array<{ gstin: string; branch: string; trappedCr: number }>;
  topSubcauses: Array<{ subcause: string; amountCr: number; windowDays: number }>;
  cashMap: { d30: number; d60: number; d90: number };
  quickWins: string[];
  notes: string[];
};

/** Same sample book as SAMPLE_TEASER, with the split left visible while the paywall is off. */
export const SAMPLE_BOOK: PublicBook = {
  clientName: "Aravali Components",
  asOf: "2026-10-01",
  erpType: "zoho",
  standardTermsDays: 45,
  trappedCr: 3.98,
  pctOfAr: 0.9734,
  daysOfWc: 102,
  byCause: {
    process: { amount_inr_cr: 1.98, pct: 0.4979 },
    power: { amount_inr_cr: 1, pct: 0.251 },
    terms: { amount_inr_cr: 0.5, pct: 0.1255 },
    distress: { amount_inr_cr: 0.3, pct: 0.0753 },
    unknown: { amount_inr_cr: 0.2, pct: 0.0502 },
  },
  byEntity: [
    { gstin: "07AABCU9603R1ZM", branch: "Delhi", trappedCr: 3.9 },
    { gstin: "27AABCU9603R1Z5", branch: "Mumbai", trappedCr: 0.08 },
  ],
  topSubcauses: [
    { subcause: "wrong_or_missing_contact", amountCr: 0.7, windowDays: 30 },
    { subcause: "open_dispute", amountCr: 0.5, windowDays: 60 },
    { subcause: "missing_po", amountCr: 0.48, windowDays: 30 },
    { subcause: "no_follow_up", amountCr: 0.2, windowDays: 30 },
    { subcause: "late_without_cadence", amountCr: 0.1, windowDays: 30 },
  ],
  cashMap: { d30: 0.96, d60: 1.24, d90: 1.24 },
  quickWins: [
    "Update the billing contact on every account in the missing-contact bucket before the next statement. Wrong inboxes are a 30-day cash item.",
    "Put a named owner and an age limit on every open dispute. Unowned disputes do not get collected.",
    "Stop sending invoices that leave without a PO number. This bucket is paperwork, not a customer who will not pay.",
    "Put a first touch on these invoices inside seven days. The balance is late because nobody asked.",
    "Add a pre-due reminder at day −7 for invoices above your threshold. The cadence is missing, the customer is not.",
  ],
  notes: ["conservative; power and terms excluded from recoverable"],
};

export function veilProgress(top: number, viewport: number): number {
  if (!(viewport > 0)) return 0;
  const start = viewport * 0.82;
  const distance = viewport * 0.5;
  const raw = (start - top) / distance;
  if (raw <= 0) return 0;
  if (raw >= 1) return 1;
  return raw;
}

export function veilBlurPx(progress: number, reducedMotion: boolean): number {
  if (reducedMotion) return 18;
  const clamped = Math.min(1, Math.max(0, progress));
  return 3 + clamped * 19;
}

const ACCEPT = /\.(csv|txt|xlsx|xls)$/i;
const MAX_BYTES = 5 * 1024 * 1024;

export function acceptUpload(name: string, size: number): { ok: true } | { ok: false; message: string } {
  const base = name.split(/[/\\]/).pop() ?? "";
  if (!ACCEPT.test(base)) {
    return { ok: false, message: "Use a CSV or an Excel file. Zoho, Tally, or a receivables aging workbook." };
  }
  if (size <= 0) return { ok: false, message: "That file is empty." };
  if (size > MAX_BYTES) return { ok: false, message: "Keep the file under 5 MB." };
  return { ok: true };
}
