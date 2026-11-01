create table if not exists ledger_preview_devices (
  device_id text primary key,
  used_at timestamptz,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0
);
