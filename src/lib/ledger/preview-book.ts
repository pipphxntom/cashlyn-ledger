import { createServerFn } from "@tanstack/react-start";
import { LedgerError } from "./errors.ts";
import { GLOBAL_TEASERS_PER_HOUR, createHourlyCap, toPublicBook, type BookTeaser, type PublicBook } from "./gate.ts";

/** The blur, the one look, and the locked teaser. Off until production. */
export const PAYWALL = false;

function friendly(error: unknown): Error {
  if (error instanceof LedgerError) {
    if (error.code === "MAPPING_INCOMPLETE") {
      return new Error("This file doesn’t look like an open-invoice export. Use Zoho, Tally, or an Excel aging file.");
    }
    if (error.code === "EMPTY_BOOK") {
      return new Error("That file has no open invoices with an amount and a due date.");
    }
    if (error.code === "DUPLICATE_INVOICE") {
      return new Error("Two rows share the same invoice number. Clean that and upload again.");
    }
    return new Error(error.message);
  }
  if (error instanceof Error) return error;
  return new Error("Could not read that file.");
}

const globalCap = createHourlyCap(GLOBAL_TEASERS_PER_HOUR);
const COOKIE = "cashlyn_device";

export type PreviewResponse =
  | { status: "arm" }
  | { status: "book"; book: PublicBook }
  | { status: "teaser"; teaser: BookTeaser }
  | { status: "locked" }
  | { status: "slow" };

async function browserDevice(): Promise<{ id: string; armed: boolean }> {
  const { getCookie, setCookie, getRequestProtocol } = await import("@tanstack/react-start/server");
  const existing = getCookie(COOKIE);
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return { id: existing, armed: true };
  const id = crypto.randomUUID().replace(/-/g, "");
  setCookie(COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: getRequestProtocol() === "https",
    maxAge: 60 * 60 * 24 * 180,
  });
  return { id, armed: false };
}

export const previewBook = createServerFn({ method: "POST" })
  .validator((input: {
    filename: string;
    contentBase64: string;
    clientName: string;
    standardTermsDays: number;
    topAccounts: string;
    asOf: string;
  }) => {
    const filename = (input.filename || "export.csv").split(/[/\\]/).pop() || "export.csv";
    if (!input.contentBase64 || input.contentBase64.length > 7_000_000) {
      throw new Error("That file is too large. Keep it under 5 MB.");
    }
    const days = Number(input.standardTermsDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Pick a credit period between 1 and 365 days.");
    const asOf = input.asOf?.trim() ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("The as-of date needs to be a real date.");
    const name = input.clientName?.trim() || filename.replace(/\.[^.]+$/, "") || "Your company";
    return {
      filename,
      contentBase64: input.contentBase64,
      clientName: name.slice(0, 120),
      standardTermsDays: days,
      topAccounts: input.topAccounts ?? "",
      asOf,
    };
  })
  .handler(async ({ data }): Promise<PreviewResponse> => {
    const { parseCsv } = await import("./csv.ts");
    const { parseXlsxSheets } = await import("./xlsx.ts");
    const { analyzeTable, chooseTable } = await import("./read-book.ts");
    const bytes = Uint8Array.from(Buffer.from(data.contentBase64, "base64"));
    if (bytes.byteLength === 0) throw new Error("That file is empty.");
    const lower = data.filename.toLowerCase();
    let table: string[][];
    try {
      if (lower.endsWith(".xls") && !lower.endsWith(".xlsx")) {
        throw new Error("Save that workbook as .xlsx and upload it again.");
      }
      table = lower.endsWith(".csv") || lower.endsWith(".txt")
        ? parseCsv(new TextDecoder("utf-8", { fatal: false }).decode(bytes))
        : chooseTable(await parseXlsxSheets(bytes));
    } catch (error) {
      throw friendly(error);
    }
    const tops = data.topAccounts.split(/[\n,]/).map((part) => part.trim()).filter(Boolean);
    const read = () => {
      try {
        return analyzeTable({
          filename: data.filename,
          table,
          clientName: data.clientName,
          standardTermsDays: data.standardTermsDays,
          topAccounts: tops,
          asOf: data.asOf,
        });
      } catch (error) {
        throw friendly(error);
      }
    };

    if (!PAYWALL) return { status: "book", book: toPublicBook(read()) };

    const device = await browserDevice();
    if (!device.armed) return { status: "arm" };
    if (!globalCap.allow(Date.now())) return { status: "slow" };

    const { getSql } = await import("../db.ts");
    const { beginAttempt, markUsed, savedTeaser } = await import("./quota.ts");
    const { toTeaser } = await import("./gate.ts");
    const sql = await getSql();
    const decision = await beginAttempt(sql, device.id);
    if (decision === "used") {
      const saved = await savedTeaser<BookTeaser>(sql, device.id);
      if (saved && typeof saved.trappedCr === "number") return { status: "teaser", teaser: saved };
      return { status: "locked" };
    }
    if (decision === "rate") return { status: "slow" };

    const teaser = toTeaser(read());
    await markUsed(sql, device.id, teaser);
    return { status: "teaser", teaser };
  });
