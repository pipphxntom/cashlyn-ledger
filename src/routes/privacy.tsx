import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  component: Privacy,
});

function Privacy() {
  return (
    <main className="mx-auto max-w-xl px-5 py-16 text-cream">
      <p className="eyebrow">Privacy</p>
      <h1 className="mt-4 text-3xl tracking-tight">The aging stays on this machine.</h1>
      <div className="mt-8 space-y-4 text-base leading-relaxed text-cream-dim">
        <p>The read runs in your browser. The file is not uploaded, and it is not written to our database.</p>
        <p>We do not send invoices, party names, or amounts to a model. Forget the read and it is gone from the page.</p>
        <p>
          If you book a call, that is an email you send. The only thing the server records on its own is an event name —
          upload started, mapping confirmed, reconciliation passed or blocked, headline viewed, page printed, call
          booked. No ledger comes with it.
        </p>
        <p>Saved column layouts live in this browser, under a key made from the header names, so the next file with the same layout is pre-filled. You still confirm it.</p>
      </div>
      <Link to="/" className="mt-10 inline-block text-sm text-gold">
        Back to the read
      </Link>
    </main>
  );
}
