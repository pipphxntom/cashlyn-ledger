import { daysBetween } from "./dates.ts";
import { portionPaise } from "./money.ts";
import type { NormalizedInvoice } from "./normalize.ts";

/**
 * Ruleset v1.
 *
 * The v2 design says "implement R001–R008 exactly as the prior version" and
 * then does not include that prior version. These eight rules are the locked
 * v1 taxonomy: first match wins. Top-account (R001) beats every other signal.
 * Power and terms always carry recoverable paise of 0.
 *
 * Recoverable portions are conservative and fixed:
 *   dispute 55%, missing PO 70%, bad contact 65%, no follow-up 60%,
 *   distress 20%, late-without-cadence 50%, unknown 0%.
 */
export const RULESET_VERSION = "v1";

export const CAUSES = ["process", "power", "terms", "distress", "unknown"] as const;
export type Cause = (typeof CAUSES)[number];

export type Classification = {
  externalId: string;
  cause: Cause;
  subcause: string;
  confidence: number;
  recoverablePaise: number;
  ruleIds: string[];
  windowDays: number | null;
  message: string;
  evidence: "data" | "hypothesis";
};

const EMPTY_CONTACT = /^(na|n\/a|none|null|nil|-|—)$/i;

function normKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function excludedStatus(status: string): boolean {
  return /^(draft|void|voided|cancelled|canceled)$/i.test(status.trim());
}

export function isOpen(invoice: NormalizedInvoice): boolean {
  return invoice.amountInrPaise > 0 && invoice.sourceMinor > 0 && !excludedStatus(invoice.status);
}

export function isOverdue(invoice: NormalizedInvoice, asOf: string): boolean {
  return isOpen(invoice) && invoice.dueDate < asOf;
}

function badContact(invoice: NormalizedInvoice): boolean {
  if (!invoice.contactColumn) return false;
  const value = (invoice.contact ?? "").trim();
  if (!value || EMPTY_CONTACT.test(value)) return true;
  if (value.includes("@") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
  return false;
}

function classifyOne(
  invoice: NormalizedInvoice,
  asOf: string,
  standardTermsDays: number,
  topAccounts: Set<string>,
): Omit<Classification, "externalId" | "message" | "evidence"> {
  const age = daysBetween(invoice.dueDate, asOf);
  const top =
    topAccounts.has(normKey(invoice.customerExternalId)) || topAccounts.has(normKey(invoice.customerName));

  if (top) {
    return {
      cause: "power",
      subcause: "top_account",
      confidence: 1,
      recoverablePaise: 0,
      ruleIds: ["R001"],
      windowDays: null,
    };
  }

  if (invoice.disputeFlag) {
    return {
      cause: "process",
      subcause: "open_dispute",
      confidence: 0.9,
      recoverablePaise: portionPaise(invoice.amountInrPaise, 5500),
      ruleIds: ["R002"],
      windowDays: 60,
    };
  }

  if (invoice.poColumn && !invoice.poNumber) {
    return {
      cause: "process",
      subcause: "missing_po",
      confidence: 0.86,
      recoverablePaise: portionPaise(invoice.amountInrPaise, 7000),
      ruleIds: ["R003"],
      windowDays: 30,
    };
  }

  if (badContact(invoice)) {
    return {
      cause: "process",
      subcause: "wrong_or_missing_contact",
      confidence: 0.82,
      recoverablePaise: portionPaise(invoice.amountInrPaise, 6500),
      ruleIds: ["R004"],
      windowDays: 30,
    };
  }

  if (invoice.lastActionColumn) {
    const stale =
      !invoice.lastActionAt || daysBetween(invoice.lastActionAt, asOf) > 21;
    if (stale && age >= 7) {
      return {
        cause: "process",
        subcause: "no_follow_up",
        confidence: 0.78,
        recoverablePaise: portionPaise(invoice.amountInrPaise, 6000),
        ruleIds: ["R005"],
        windowDays: 30,
      };
    }
  }

  const creditDays = daysBetween(invoice.invoiceDate, invoice.dueDate);
  if (creditDays > standardTermsDays) {
    return {
      cause: "terms",
      subcause: "terms_beyond_standard",
      confidence: 0.88,
      recoverablePaise: 0,
      ruleIds: ["R006"],
      windowDays: null,
    };
  }

  if (age >= 120) {
    return {
      cause: "distress",
      subcause: "chronic_delinquency",
      confidence: 0.5,
      recoverablePaise: portionPaise(invoice.amountInrPaise, 2000),
      ruleIds: ["R007"],
      windowDays: 90,
    };
  }

  if (age <= 60) {
    return {
      cause: "process",
      subcause: "late_without_cadence",
      confidence: 0.6,
      recoverablePaise: portionPaise(invoice.amountInrPaise, 5000),
      ruleIds: ["R008"],
      windowDays: 30,
    };
  }

  return {
    cause: "unknown",
    subcause: "unclassified",
    confidence: 0.35,
    recoverablePaise: 0,
    ruleIds: ["R008"],
    windowDays: null,
  };
}

export function classifyBook(
  invoices: NormalizedInvoice[],
  asOf: string,
  standardTermsDays: number,
  topAccountExternalIds: string[],
): Classification[] {
  const topAccounts = new Set(topAccountExternalIds.map(normKey).filter(Boolean));
  const out: Classification[] = [];
  for (const invoice of invoices) {
    if (!isOverdue(invoice, asOf)) continue;
    const result = classifyOne(invoice, asOf, standardTermsDays, topAccounts);
    const message = `${result.ruleIds[0]} ${result.subcause} → ${result.cause}; recoverable paise ${result.recoverablePaise}`;
    const evidence = result.ruleIds[0] === "R008" ? "hypothesis" : "data";
    out.push({ externalId: invoice.externalId, message, ...result, evidence });
  }
  return out;
}
