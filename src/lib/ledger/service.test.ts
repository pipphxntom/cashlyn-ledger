import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import { LedgerError } from "./errors.ts";
import { createClient, executeRun, listRuns, saveConfig, viewRun } from "./service.ts";

const csv = readFileSync(new URL("./fixtures/zoho-open-ar.csv", import.meta.url), "utf8");

async function testSql(): Promise<Sql> {
  const db = new PGlite();
  const migration = readFileSync(new URL("../../../migrations/0002_ledger.sql", import.meta.url), "utf8");
  await db.exec(migration);
  const run = async <T>(text: string, params: unknown[]): Promise<T[]> => {
    const result = await db.query<T>(text, params);
    return result.rows;
  };
  const sql = (async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1] ?? ""}`;
    return run<T>(text, values);
  }) as Sql;
  sql.query = (text, params) => run(text, params ?? []);
  return sql;
}

describe("ledger integration", () => {
  it("persists a Zoho run, blocks a missing config, and refuses another user", async () => {
    const sql = await testSql();
    const userA = `user-${crypto.randomUUID()}`;
    const userB = `user-${crypto.randomUUID()}`;
    const injected = "'); drop table ledger_clients;--";
    const client = await createClient(sql, userA, { name: injected, erpType: "zoho" });

    const bytes = new TextEncoder().encode(csv);
    await assert.rejects(
      () => executeRun(sql, userA, { clientId: client.id, filename: "open.csv", bytes, asOf: "2026-10-01" }),
      (error: unknown) => error instanceof LedgerError && error.code === "CONFIG_REQUIRED",
    );
    const failed = await sql<{ status: string; n: number }>`
      select r.status, (select count(*) from ledger_classifications c where c.run_id = r.id) as n
      from ledger_runs r
      where r.client_id = ${client.id}
    `;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].status, "failed");
    assert.equal(Number(failed[0].n), 0);

    await saveConfig(sql, userA, {
      clientId: client.id,
      standardTermsDays: 45,
      topAccountExternalIds: ["CUST-POWER"],
      fxRates: {},
      notes: "fixture",
    });

    const first = await executeRun(sql, userA, {
      clientId: client.id,
      filename: "zoho-open-ar.csv",
      bytes,
      asOf: "2026-10-01",
    });
    const second = await executeRun(sql, userA, {
      clientId: client.id,
      filename: "zoho-open-ar.csv",
      bytes,
      asOf: "2026-10-01",
    });
    assert.equal(first.payload.headline.trapped_cash_inr_cr, 3.98);
    assert.deepEqual(first.payload.by_cause, second.payload.by_cause);
    assert.equal(first.payload.client.name, injected);
    assert.notEqual(first.payload.run_id, second.payload.run_id);

    const power = await sql<{ recoverable_amount_inr: string }>`
      select recoverable_amount_inr
      from ledger_classifications
      where run_id = ${first.runId} and invoice_external_id = 'POWER-1'
    `;
    assert.equal(Number(power[0].recoverable_amount_inr), 0);

    const viewed = await viewRun(sql, userA, first.runId);
    assert.equal(viewed.payload.headline.trapped_cash_inr_cr, 3.98);
    assert.ok(viewed.watermark.includes(injected));
    const audits = await sql<{ n: number }>`
      select count(*) as n from ledger_audit where run_id = ${first.runId} and action = 'view' and user_id = ${userA}
    `;
    assert.equal(Number(audits[0].n), 1);

    await assert.rejects(
      () => viewRun(sql, userB, first.runId),
      (error: unknown) => error instanceof LedgerError && error.code === "NOT_FOUND",
    );
    await assert.rejects(
      () => viewRun(sql, null, first.runId),
      (error: unknown) => error instanceof LedgerError && error.code === "UNAUTHENTICATED",
    );

    const runs = await listRuns(sql, userA);
    assert.ok(runs.some((run) => run.id === first.runId && run.trapped_cash_inr_cr === 3.98));
    assert.equal((await listRuns(sql, userB)).some((run) => run.id === first.runId), false);

    const stillThere = await sql<{ n: number }>`select count(*) as n from ledger_clients`;
    assert.equal(Number(stillThere[0].n), 1);
  });
});
