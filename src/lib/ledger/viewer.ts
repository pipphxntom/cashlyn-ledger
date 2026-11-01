import { LedgerError } from "./errors.ts";

/** Headers for a view-only response. Cosmetic controls are not DRM. */
export function viewerResponseHeaders(now = Date.now()): Record<string, string> {
  return {
    "Content-Disposition": "inline",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    Expires: new Date(now).toUTCString(),
  };
}

export function requireViewer(userId: string | null | undefined): string {
  if (!userId) throw new LedgerError("UNAUTHENTICATED", "A session is required to view a report");
  return userId;
}

export function watermark(clientName: string, runId: string, viewedAtIso: string): string {
  return `${clientName} · ${runId} · ${viewedAtIso}`;
}

/** Same-owner check. Missing and foreign runs are the same answer: not found. */
export function authorizeRun(ownerId: string | null, requesterId: string | null): void {
  requireViewer(requesterId);
  if (!ownerId || ownerId !== requesterId) {
    throw new LedgerError("NOT_FOUND", "Report not found");
  }
}
