import { LedgerError } from "./errors.ts";

/** 1 crore rupees = 1_000_000_000 paise. */
export const PAISE_PER_CRORE = 1_000_000_000;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function paiseToCrore(paise: number): number {
  return round2(paise / PAISE_PER_CRORE);
}

/**
 * Split paise weights into crore amounts (2 decimals) that sum to the
 * independently rounded total. Largest remainder; index breaks ties.
 */
export function allocateCrore(partsPaise: number[]): number[] {
  const unit = PAISE_PER_CRORE / 100;
  const total = partsPaise.reduce((sum, part) => sum + part, 0);
  if (partsPaise.length === 0) return [];
  if (total === 0) return partsPaise.map(() => 0);
  const targetUnits = Math.round(total / unit);
  const exact = partsPaise.map((part) => (part / total) * targetUnits);
  const floors = exact.map((value) => Math.floor(value + 1e-9));
  let left = targetUnits - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  const units = floors.slice();
  for (let i = 0; i < left; i += 1) units[order[i].index] += 1;
  return units.map((value) => value / 100);
}

/** Basis points: 5500 = 55.00%. Half-up on the paise. */
export function portionPaise(paise: number, basisPoints: number): number {
  return Math.round((paise * basisPoints) / 10_000);
}

/** Source-currency amount → integer minor units. Rejects junk and scientific notation. Lakh commas and Dr/Cr are accepted. Cr is a credit. */
export function parseAmountToMinor(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) throw new LedgerError("BAD_AMOUNT", "Amount is empty");
  if (/[eE]/.test(trimmed)) throw new LedgerError("BAD_AMOUNT", `Refusing scientific notation: ${raw}`);
  let negative = /^\(.*\)$/.test(trimmed) || trimmed.startsWith("-");
  let body = trimmed.replace(/^\(|\)$/g, "").replace(/^-/, "").trim();
  const prefix = /^(dr|cr)\.?\s+/i.exec(body);
  const suffix = /\s*(dr|cr)\.?$/i.exec(body);
  const side = prefix?.[1] ?? suffix?.[1];
  if (side && /^cr/i.test(side)) negative = true;
  if (prefix) body = body.slice(prefix[0].length);
  if (suffix) body = body.slice(0, body.length - suffix[0].length);
  const cleaned = body.replace(/[₹$€£,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new LedgerError("BAD_AMOUNT", `Cannot read amount "${raw}"`);
  }
  const [whole, frac = ""] = cleaned.split(".");
  if (frac.length > 2) throw new LedgerError("BAD_AMOUNT", `More than 2 decimal places: ${raw}`);
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw new LedgerError("BAD_AMOUNT", `Amount too large: ${raw}`);
  return negative ? -minor : minor;
}

export function minorToInrPaise(minor: number, inrPerUnit: number): number {
  if (!Number.isFinite(inrPerUnit) || inrPerUnit <= 0) {
    throw new LedgerError("BAD_FX", "FX rate must be a positive number");
  }
  return Math.round(minor * inrPerUnit);
}
