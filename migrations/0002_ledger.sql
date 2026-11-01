create table if not exists ledger_clients (
  id text primary key,
  user_id text not null,
  name text not null,
  erp_type text not null,
  base_currency text not null default 'INR',
  created_at timestamptz not null default now()
);
create index if not exists ledger_clients_user_idx on ledger_clients (user_id);

create table if not exists ledger_client_config (
  client_id text primary key references ledger_clients (id) on delete cascade,
  standard_terms_days integer not null,
  top_account_external_ids jsonb not null,
  multi_entity boolean not null default true,
  fx_rates jsonb not null default '{}'::jsonb,
  notes text not null default ''
);

create table if not exists ledger_runs (
  id text primary key,
  user_id text not null,
  client_id text not null references ledger_clients (id) on delete cascade,
  status text not null,
  ruleset_version text not null,
  input_file_hash text not null,
  fx_rates_snapshot jsonb not null default '{}'::jsonb,
  payload jsonb,
  error text,
  export_body text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists ledger_runs_user_idx on ledger_runs (user_id, started_at desc);
create index if not exists ledger_runs_client_idx on ledger_runs (client_id);

create table if not exists ledger_invoices (
  id text primary key,
  run_id text not null references ledger_runs (id) on delete cascade,
  external_id text not null,
  customer_external_id text not null,
  customer_name text not null,
  gstin text not null default '',
  branch text not null default '',
  amount_inr_paise bigint not null,
  currency text not null,
  invoice_date text not null,
  due_date text not null
);
create index if not exists ledger_invoices_run_idx on ledger_invoices (run_id);

create table if not exists ledger_classifications (
  run_id text not null references ledger_runs (id) on delete cascade,
  invoice_external_id text not null,
  cause text not null,
  subcause text not null,
  confidence numeric not null,
  recoverable_amount_inr numeric not null,
  rule_ids jsonb not null,
  primary key (run_id, invoice_external_id)
);
create index if not exists ledger_classifications_cause_idx on ledger_classifications (run_id, cause);

create table if not exists ledger_audit (
  id bigserial primary key,
  run_id text,
  user_id text not null,
  invoice_external_id text,
  rule_id text,
  action text not null,
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists ledger_audit_run_idx on ledger_audit (run_id);
