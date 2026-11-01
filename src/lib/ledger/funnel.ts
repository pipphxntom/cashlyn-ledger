import { createServerFn } from "@tanstack/react-start";

const EVENTS = [
  "upload_started",
  "mapping_confirmed",
  "reconciliation_passed",
  "reconciliation_blocked",
  "headline_viewed",
  "report_downloaded",
  "call_booked",
] as const;

export type FunnelEvent = (typeof EVENTS)[number];

export const noteFunnel = createServerFn({ method: "POST" })
  .validator((input: { event: string }) => {
    if (!EVENTS.includes(input.event as FunnelEvent)) throw new Error("Unknown event");
    return { event: input.event as FunnelEvent };
  })
  .handler(async ({ data }) => {
    try {
      const { getSql } = await import("../db.ts");
      const sql = await getSql();
      await sql`insert into ledger_funnel (id, event) values (${crypto.randomUUID()}, ${data.event})`;
    } catch {
      // Analytics must never block the read.
    }
    return { ok: true as const };
  });

export function rememberFunnel(event: FunnelEvent) {
  try {
    const raw = localStorage.getItem("cashlyn-funnel");
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    list.push({ event, at: new Date().toISOString() });
    localStorage.setItem("cashlyn-funnel", JSON.stringify(list.slice(-40)));
  } catch {
    // Private mode can refuse storage. The read still stands.
  }
  void noteFunnel({ data: { event } }).catch(() => undefined);
}
