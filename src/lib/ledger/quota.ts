import type { Sql } from "../db.ts";
import { judgeQuota, nextAttempts, type QuotaRow } from "./gate.ts";

type QuotaSqlRow = {
  used_at: string | null;
  attempts: number | string;
  window_started_at: string | Date;
};

function asRow(row: QuotaSqlRow): QuotaRow {
  const started = row.window_started_at instanceof Date
    ? row.window_started_at.getTime()
    : new Date(row.window_started_at).getTime();
  return {
    used: row.used_at != null,
    attempts: Number(row.attempts),
    windowStartedAt: started,
  };
}

export async function beginAttempt(sql: Sql, deviceId: string, now = new Date()): Promise<"allow" | "used" | "rate"> {
  const iso = now.toISOString();
  await sql`
    insert into ledger_preview_devices (device_id, attempts, window_started_at)
    values (${deviceId}, 0, ${iso})
    on conflict (device_id) do nothing
  `;
  const rows = await sql<QuotaSqlRow>`
    select used_at, attempts, window_started_at
    from ledger_preview_devices
    where device_id = ${deviceId}
  `;
  const found = rows[0];
  if (!found) throw new Error("Could not open a preview session.");
  const row = asRow(found);
  const decision = judgeQuota(row, now.getTime());
  if (decision !== "allow") return decision;
  const next = nextAttempts(row, now.getTime());
  await sql`
    update ledger_preview_devices
    set attempts = ${next.attempts},
        window_started_at = ${new Date(next.windowStartedAt).toISOString()}
    where device_id = ${deviceId}
      and used_at is null
  `;
  return "allow";
}

export async function markUsed(sql: Sql, deviceId: string, teaser: unknown, now = new Date()): Promise<void> {
  await sql`
    update ledger_preview_devices
    set used_at = ${now.toISOString()},
        teaser = ${JSON.stringify(teaser)}::jsonb
    where device_id = ${deviceId}
  `;
}

export async function savedTeaser<T>(sql: Sql, deviceId: string): Promise<T | null> {
  const rows = await sql<{ teaser: T | null }>`
    select teaser from ledger_preview_devices where device_id = ${deviceId}
  `;
  return rows[0]?.teaser ?? null;
}
