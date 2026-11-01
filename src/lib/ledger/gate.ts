import type { LedgerPayload } from "./aggregate.ts";
import { type BookTeaser, type PublicBook } from "./preview-public.ts";
import { CAUSES, type Cause } from "./rules.ts";

export { SAMPLE_TEASER, acceptUpload, veilBlurPx, veilProgress } from "./preview-public.ts";
export type { BookTeaser, PublicBook } from "./preview-public.ts";

/** One finished look per browser. Failed files do not spend it. */
export const MAX_ATTEMPTS_PER_HOUR = 6;
export const HOUR_MS = 60 * 60 * 1000;
/** Backstop for clients that throw the cookie away and ask again. */
export const GLOBAL_TEASERS_PER_HOUR = 40;

export type QuotaRow = {
  used: boolean;
  attempts: number;
  windowStartedAt: number;
};

export function toTeaser(payload: LedgerPayload): BookTeaser {
  let leadCause: Cause = "unknown";
  let leadCr = -1;
  for (const cause of CAUSES) {
    const amount = payload.by_cause[cause].amount_inr_cr;
    if (amount > leadCr) {
      leadCause = cause;
      leadCr = amount;
    }
  }
  return {
    clientName: payload.client.name,
    asOf: payload.as_of,
    trappedCr: payload.headline.trapped_cash_inr_cr,
    pctOfAr: payload.headline.pct_of_ar,
    daysOfWc: payload.headline.days_of_wc,
    leadCause,
    leadCr: Math.max(0, leadCr),
  };
}

export function toPublicBook(payload: LedgerPayload): PublicBook {
  return {
    clientName: payload.client.name,
    asOf: payload.as_of,
    erpType: payload.client.erp_type,
    standardTermsDays: payload.client.standard_terms_days,
    trappedCr: payload.headline.trapped_cash_inr_cr,
    pctOfAr: payload.headline.pct_of_ar,
    daysOfWc: payload.headline.days_of_wc,
    byCause: payload.by_cause,
    byEntity: payload.by_entity.map((entity) => ({
      gstin: entity.gstin,
      branch: entity.branch,
      trappedCr: entity.trapped_cash_inr_cr,
    })),
    topSubcauses: payload.top_subcauses.map((row) => ({
      subcause: row.subcause,
      amountCr: row.amount_inr_cr,
      windowDays: row.window_days,
    })),
    cashMap: payload.cash_map_30_60_90,
    quickWins: payload.quick_wins,
    notes: payload.notes,
  };
}

export function judgeQuota(row: QuotaRow, now: number): "allow" | "used" | "rate" {
  if (row.used) return "used";
  const inWindow = now - row.windowStartedAt < HOUR_MS;
  const attempts = inWindow ? row.attempts : 0;
  if (attempts >= MAX_ATTEMPTS_PER_HOUR) return "rate";
  return "allow";
}

export function nextAttempts(row: QuotaRow, now: number): { attempts: number; windowStartedAt: number } {
  const inWindow = now - row.windowStartedAt < HOUR_MS && row.attempts > 0;
  if (!inWindow) return { attempts: 1, windowStartedAt: now };
  return { attempts: row.attempts + 1, windowStartedAt: row.windowStartedAt };
}

export function createHourlyCap(limit: number) {
  const stamps: number[] = [];
  return {
    allow(now: number): boolean {
      while (stamps.length > 0 && stamps[0] !== undefined && now - stamps[0] >= HOUR_MS) stamps.shift();
      if (stamps.length >= limit) return false;
      stamps.push(now);
      return true;
    },
  };
}
