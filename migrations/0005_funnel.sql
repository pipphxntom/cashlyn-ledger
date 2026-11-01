create table if not exists ledger_funnel (
  id text primary key,
  event text not null,
  created_at timestamptz not null default now()
);
