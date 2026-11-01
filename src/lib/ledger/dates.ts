import { LedgerError } from "./errors.ts";

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(year: number, month: number, day: number): string {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) {
    throw new LedgerError("BAD_DATE", `Impossible date ${year}-${month}-${day}`);
  }
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new LedgerError("BAD_DATE", `Impossible date ${year}-${month}-${day}`);
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Calendar dates only. No `Date.parse`.
 * Accepts YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, DD-MMM-YYYY, DD-MMM-YY, and an Excel serial.
 * When both slash/dash numbers are ≤ 12, India wins: day first.
 * A 2-digit year 00–69 is 2000–2069. Aging uses the as-of date you set, never the server clock.
 */
export function parseDate(raw: string): string {
  const value = raw.trim().replace(/\./g, "/");
  if (!value) throw new LedgerError("BAD_DATE", "Date is empty");

  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) return ymd(Number(match[1]), Number(match[2]), Number(match[3]));

  if (/^\d{5}$/.test(value)) {
    const serial = Number(value);
    if (serial >= 20000 && serial <= 80000) return excelSerial(serial);
  }

  match = /^(\d{1,2})[/-]([A-Za-z]{3})[/-](\d{2,4})$/.exec(value);
  if (match) {
    const month = MONTHS[match[2].toLowerCase()];
    if (!month) throw new LedgerError("BAD_DATE", `Unknown month in "${raw}"`);
    return ymd(yearOf(match[3]), month, Number(match[1]));
  }

  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(value);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    const year = yearOf(match[3]);
    if (a > 12 && b > 12) throw new LedgerError("BAD_DATE", `Cannot read date "${raw}"`);
    if (a > 12) return ymd(year, b, a);
    if (b > 12) return ymd(year, a, b);
    return ymd(year, b, a);
  }

  throw new LedgerError("BAD_DATE", `Cannot read date "${raw}"`);
}

function yearOf(raw: string): number {
  const year = Number(raw);
  if (raw.length === 4) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}

/** Excel's 1900 system, including the Lotus false leap day. Serial 1 is 1899-12-31. */
function excelSerial(serial: number): string {
  const utc = Date.UTC(1899, 11, 30) + serial * 86_400_000;
  const date = new Date(utc);
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addDays(iso: string, days: number): string {
  if (!Number.isInteger(days)) throw new LedgerError("BAD_DATE", "Credit days must be a whole number");
  const [year, month, day] = iso.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day + days);
  const next = new Date(utc);
  return ymd(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

export function daysBetween(earlierIso: string, laterIso: string): number {
  const [ay, am, ad] = earlierIso.split("-").map(Number);
  const [by, bm, bd] = laterIso.split("-").map(Number);
  const delta = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(delta / 86_400_000);
}
