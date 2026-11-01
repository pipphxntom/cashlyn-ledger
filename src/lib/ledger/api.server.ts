import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { LedgerError } from "./errors.ts";
import type { LogicalField } from "./mapping.ts";
import { createClient, executeRun, listClients, listRuns, saveConfig, viewRun } from "./service.ts";

function fail(error: unknown): never {
  if (error instanceof LedgerError) throw new Error(error.message);
  throw error;
}

export const listLedgerClients = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    return listClients(sql, context.userId);
  });

export const listLedgerRuns = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    return listRuns(sql, context.userId);
  });

export const createLedgerClient = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string; erpType: string }) => {
    const name = input.name?.trim() ?? "";
    if (name.length < 2 || name.length > 120) throw new Error("Client name must be 2–120 characters");
    if (input.erpType !== "zoho" && input.erpType !== "tally") throw new Error("ERP must be Zoho or Tally");
    return { name, erpType: input.erpType };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return createClient(sql, context.userId, {
      name: data.name,
      erpType: data.erpType as "zoho" | "tally",
    });
  });

export const saveLedgerConfig = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: {
    clientId: string;
    standardTermsDays: number;
    topAccounts: string;
    fxJson: string;
    notes: string;
  }) => {
    if (!input.clientId) throw new Error("Client is required");
    const days = Number(input.standardTermsDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Standard terms must be 1–365 days");
    const topAccountExternalIds = input.topAccounts
      .split(/[\n,]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 200);
    let fxRates: Record<string, number> = {};
    const rawFx = input.fxJson.trim();
    if (rawFx) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawFx);
      } catch {
        throw new Error("FX rates must be JSON, for example {\"USD\":83.5}");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("FX rates must be an object");
      for (const [key, value] of Object.entries(parsed)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error("FX rates contain a rejected key");
        }
        if (typeof value !== "number") throw new Error(`FX rate for ${key} must be a number`);
        fxRates[key] = value;
      }
    }
    return {
      clientId: input.clientId,
      standardTermsDays: days,
      topAccountExternalIds,
      fxRates,
      notes: (input.notes ?? "").slice(0, 500),
    };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    try {
      await saveConfig(sql, context.userId, data);
      return { ok: true as const };
    } catch (error) {
      fail(error);
    }
  });

export const runLedger = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { clientId: string; filename: string; contentBase64: string; asOf: string; mappingJson: string }) => {
    if (!input.clientId) throw new Error("Client is required");
    const filename = (input.filename || "export.csv").split(/[/\\]/).pop() || "export.csv";
    if (input.contentBase64.length > 7_000_000) throw new Error("File is larger than 5 MB");
    let mapping: Partial<Record<LogicalField, string>> | undefined;
    const rawMap = input.mappingJson?.trim() ?? "";
    if (rawMap) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawMap);
      } catch {
        throw new Error("Mapping override must be JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Mapping override must be an object");
      mapping = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error("Mapping contains a rejected key");
        }
        if (typeof value !== "string") throw new Error("Mapping values must be column names");
        mapping[key as LogicalField] = value;
      }
    }
    const asOf = input.asOf?.trim() ?? "";
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("As-of date must be YYYY-MM-DD");
    return { clientId: input.clientId, filename, contentBase64: input.contentBase64, asOf, mapping };
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const bytes = Uint8Array.from(Buffer.from(data.contentBase64, "base64"));
    try {
      return await executeRun(sql, context.userId, {
        clientId: data.clientId,
        filename: data.filename,
        bytes,
        asOf: data.asOf || undefined,
        mapping: data.mapping,
      });
    } catch (error) {
      fail(error);
    }
  });

export const viewLedgerRun = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((runId: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Bad run");
    return runId;
  })
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    try {
      return await viewRun(sql, context.userId, data);
    } catch (error) {
      fail(error);
    }
  });
