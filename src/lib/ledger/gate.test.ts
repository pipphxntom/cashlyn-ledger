import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db.ts";
import { parseCsv } from "./csv.ts";
import { FIXTURE_CONFIG } from "./fixtures.ts";
import {
  SAMPLE_TEASER,
  acceptUpload,
  createHourlyCap,
  judgeQuota,
  nextAttempts,
  toTeaser,
  veilBlurPx,
  veilProgress,
} from "./gate.ts";
import { beginAttempt, markUsed } from "./quota.ts";
import { teaserFromTable } from "./read-book.ts";
import { runCsvDiagnostic } from "./pipeline.ts";

const csv = readFileSync(new URL("./fixtures/zoho-open-ar.csv", import.meta.url), "utf8");

async function testSql(): Promise<Sql> {
  const db = new PGlite();
  const migration = [
    readFileSync(new URL("../../../migrations/0003_preview_gate.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../../../migrations/0004_preview_teaser.sql", import.meta.url), "utf8"),
  ].join("\n");
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

describe("teaser", () => {
  it("matches the published sample and drops the rest of the analysis", () => {
    const payload = runCsvDiagnostic(csv, {
      erpType: "zoho",
      clientName: "Aravali Components",
      config: FIXTURE_CONFIG,
      runId: "sample",
    }).payload;
    const teaser = toTeaser(payload);
    assert.deepEqual(teaser, SAMPLE_TEASER);
    const encoded = JSON.stringify(teaser);
    assert.equal(encoded.includes("quick_wins"), false);
    assert.equal(encoded.includes("cash_map"), false);
    assert.equal(encoded.includes("Update the billing contact"), false);
    assert.equal(encoded.includes("by_entity"), false);
    assert.equal(Object.keys(teaser).sort().join(), "asOf,clientName,daysOfWc,leadCause,leadCr,pctOfAr,trappedCr");
  });

  it("reads a Zoho export down to the teaser only", () => {
    const teaser = teaserFromTable({
      filename: "zoho-open-ar.csv",
      table: parseCsv(csv),
      clientName: "Aravali Components",
      standardTermsDays: FIXTURE_CONFIG.standardTermsDays,
      topAccounts: FIXTURE_CONFIG.topAccountExternalIds,
      asOf: FIXTURE_CONFIG.asOf,
    });
    assert.equal(teaser.trappedCr, 3.98);
    assert.equal(teaser.leadCause, "process");
    assert.equal("quick_wins" in teaser, false);
  });
});

describe("one look", () => {
  it("allows the first finished look, then locks the device", () => {
    const now = Date.parse("2026-10-25T00:00:00Z");
    const fresh = { used: false, attempts: 0, windowStartedAt: now };
    assert.equal(judgeQuota(fresh, now), "allow");
    assert.deepEqual(nextAttempts(fresh, now), { attempts: 1, windowStartedAt: now });
    assert.equal(judgeQuota({ used: true, attempts: 1, windowStartedAt: now }, now), "used");
  });

  it("counts failed tries and slows the device after six in an hour", () => {
    const start = Date.parse("2026-10-25T00:00:00Z");
    let row = { used: false, attempts: 0, windowStartedAt: start };
    for (let i = 0; i < 6; i += 1) {
      assert.equal(judgeQuota(row, start + i), "allow");
      const next = nextAttempts(row, start + i);
      row = { used: false, attempts: next.attempts, windowStartedAt: next.windowStartedAt };
    }
    assert.equal(row.attempts, 6);
    assert.equal(judgeQuota(row, start + 10), "rate");
    assert.equal(judgeQuota(row, start + 60 * 60 * 1000 + 1), "allow");
  });

  it("persists the lock in the database", async () => {
    const sql = await testSql();
    const now = new Date("2026-10-25T00:00:00Z");
    assert.equal(await beginAttempt(sql, "device-a", now), "allow");
    await markUsed(sql, "device-a", { trappedCr: 1 }, now);
    assert.equal(await beginAttempt(sql, "device-a", new Date(now.getTime() + 1000)), "used");
    assert.equal(await beginAttempt(sql, "device-b", now), "allow");
  });
});

describe("upload and veil", () => {
  it("accepts Zoho and Tally files and refuses the rest", () => {
    assert.equal(acceptUpload("aging.csv", 1200).ok, true);
    assert.equal(acceptUpload("books/receivables.xlsx", 1200).ok, true);
    assert.equal(acceptUpload("photo.png", 1200).ok, false);
    assert.equal(acceptUpload("empty.csv", 0).ok, false);
    assert.equal(acceptUpload("huge.csv", 5 * 1024 * 1024 + 1).ok, false);
  });

  it("tightens the blur as the locked section rises into view", () => {
    assert.equal(veilProgress(900, 800), 0);
    assert.equal(veilProgress(200, 800) > veilProgress(500, 800), true);
    assert.equal(veilProgress(-200, 800), 1);
    assert.equal(veilBlurPx(0, false), 3);
    assert.equal(veilBlurPx(1, false), 22);
    assert.equal(veilBlurPx(0, true), 18);
  });

  it("caps how many teasers one process will mint in an hour", () => {
    const cap = createHourlyCap(2);
    assert.equal(cap.allow(0), true);
    assert.equal(cap.allow(10), true);
    assert.equal(cap.allow(20), false);
    assert.equal(cap.allow(60 * 60 * 1000), true);
  });
});
