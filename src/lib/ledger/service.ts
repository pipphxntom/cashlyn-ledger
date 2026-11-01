import type { Sql } from "../db.ts";
import type { LedgerPayload } from "./aggregate.ts";
import { parseCsv } from "./csv.ts";
import { LedgerError } from "./errors.ts";
import type { LogicalField } from "./mapping.ts";
import type { ClientConfig } from "./normalize.ts";
import { diagnoseTable, chooseTable } from "./read-book.ts";
import { sha256Hex } from "./pipeline.ts";
import { RULESET_VERSION } from "./rules.ts";
import { authorizeRun } from "./viewer.ts";
import { parseXlsxSheets } from "./xlsx.ts";

const MAX_BYTES = 5_000_000;

export type ClientRow = {
  id: string;
  name: string;
  erp_type: "zoho" | "tally";
  base_currency: string;
  has_config: boolean;
  standard_terms_days: number | null;
};

export type RunRow = {
  id: string;
  status: string;
  started_at: string;
  error: string | null;
  client_name: string;
  trapped_cash_inr_cr: number | null;
};

function asObject<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function recoverableRupees(paise: number): string {
  return (paise / 100).toFixed(2);
}

export async function listClients(sql: Sql, userId: string): Promise<ClientRow[]> {
  const rows = await sql<{
    id: string;
    name: string;
    erp_type: "zoho" | "tally";
    base_currency: string;
    has_config: boolean;
    standard_terms_days: number | null;
  }>`
    select c.id, c.name, c.erp_type, c.base_currency,
           (cfg.client_id is not null) as has_config,
           cfg.standard_terms_days
    from ledger_clients c
    left join ledger_client_config cfg on cfg.client_id = c.id
    where c.user_id = ${userId}
    order by c.created_at desc
  `;
  return rows;
}

export async function createClient(
  sql: Sql,
  userId: string,
  input: { name: string; erpType: "zoho" | "tally" },
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await sql`
    insert into ledger_clients (id, user_id, name, erp_type)
    values (${id}, ${userId}, ${input.name}, ${input.erpType})
  `;
  return { id };
}

export async function saveConfig(
  sql: Sql,
  userId: string,
  input: {
    clientId: string;
    standardTermsDays: number;
    topAccountExternalIds: string[];
    fxRates: Record<string, number>;
    notes: string;
  },
): Promise<void> {
  const owned = await sql<{ id: string }>`
    select id from ledger_clients where id = ${input.clientId} and user_id = ${userId}
  `;
  if (owned.length === 0) throw new LedgerError("NOT_FOUND", "Client not found");
  const tops = JSON.stringify(input.topAccountExternalIds);
  const fx = JSON.stringify(input.fxRates);
  await sql`
    insert into ledger_client_config
      (client_id, standard_terms_days, top_account_external_ids, multi_entity, fx_rates, notes)
    values (${input.clientId}, ${input.standardTermsDays}, ${tops}::jsonb, true, ${fx}::jsonb, ${input.notes})
    on conflict (client_id) do update set
      standard_terms_days = excluded.standard_terms_days,
      top_account_external_ids = excluded.top_account_external_ids,
      fx_rates = excluded.fx_rates,
      notes = excluded.notes
  `;
}

async function loadOwnedConfig(sql: Sql, userId: string, clientId: string): Promise<{
  name: string;
  erpType: "zoho" | "tally";
  config: ClientConfig | null;
}> {
  const rows = await sql<{
    name: string;
    erp_type: "zoho" | "tally";
    standard_terms_days: number | null;
    top_account_external_ids: unknown;
    fx_rates: unknown;
  }>`
    select c.name, c.erp_type, cfg.standard_terms_days, cfg.top_account_external_ids, cfg.fx_rates
    from ledger_clients c
    left join ledger_client_config cfg on cfg.client_id = c.id
    where c.id = ${clientId} and c.user_id = ${userId}
  `;
  const row = rows[0];
  if (!row) throw new LedgerError("NOT_FOUND", "Client not found");
  if (row.standard_terms_days === null || row.standard_terms_days === undefined) {
    return { name: row.name, erpType: row.erp_type, config: null };
  }
  const tops = asObject<string[]>(row.top_account_external_ids ?? []);
  const fx = asObject<Record<string, number>>(row.fx_rates ?? {});
  return {
    name: row.name,
    erpType: row.erp_type,
    config: {
      standardTermsDays: Number(row.standard_terms_days),
      topAccountExternalIds: Array.isArray(tops) ? tops : [],
      fxRates: fx && typeof fx === "object" ? fx : {},
      multiEntity: true,
    },
  };
}

export async function executeRun(
  sql: Sql,
  userId: string,
  input: {
    clientId: string;
    filename: string;
    bytes: Uint8Array;
    asOf?: string;
    mapping?: Partial<Record<LogicalField, string>>;
  },
): Promise<{ runId: string; payload: LedgerPayload }> {
  if (input.bytes.byteLength === 0) throw new LedgerError("BAD_FILE", "File is empty");
  if (input.bytes.byteLength > MAX_BYTES) throw new LedgerError("BAD_FILE", "File is larger than 5 MB");
  const owned = await loadOwnedConfig(sql, userId, input.clientId);
  const hash = await sha256Hex(input.bytes);
  const runId = crypto.randomUUID();
  const exportBody = Buffer.from(input.bytes).toString("base64");

  if (!owned.config) {
    await sql`
      insert into ledger_runs
        (id, user_id, client_id, status, ruleset_version, input_file_hash, error, export_body, finished_at)
      values
        (${runId}, ${userId}, ${input.clientId}, 'failed', ${RULESET_VERSION}, ${hash},
         'client_config is required before a run', ${exportBody}, now())
    `;
    throw new LedgerError("CONFIG_REQUIRED", "client_config is required before a run");
  }

  const config: ClientConfig = input.asOf ? { ...owned.config, asOf: input.asOf } : owned.config;
  await sql`
    insert into ledger_runs
      (id, user_id, client_id, status, ruleset_version, input_file_hash, export_body)
    values
      (${runId}, ${userId}, ${input.clientId}, 'running', ${RULESET_VERSION}, ${hash}, ${exportBody})
  `;

  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
    const lower = input.filename.toLowerCase();
    const table = lower.endsWith(".csv")
      ? parseCsv(text)
      : chooseTable(await parseXlsxSheets(input.bytes));
    const result = diagnoseTable({
      erpType: owned.erpType,
      clientName: owned.name,
      config,
      table,
      runId,
      mapping: input.mapping,
    });

    for (const invoice of result.invoices) {
      await sql`
        insert into ledger_invoices
          (id, run_id, external_id, customer_external_id, customer_name, gstin, branch,
           amount_inr_paise, currency, invoice_date, due_date)
        values
          (${crypto.randomUUID()}, ${runId}, ${invoice.externalId}, ${invoice.customerExternalId},
           ${invoice.customerName}, ${invoice.gstin}, ${invoice.branch}, ${invoice.amountInrPaise},
           ${invoice.currency}, ${invoice.invoiceDate}, ${invoice.dueDate})
      `;
    }
    for (const row of result.classifications) {
      await sql`
        insert into ledger_classifications
          (run_id, invoice_external_id, cause, subcause, confidence, recoverable_amount_inr, rule_ids)
        values
          (${runId}, ${row.externalId}, ${row.cause}, ${row.subcause}, ${row.confidence},
           ${recoverableRupees(row.recoverablePaise)}, ${JSON.stringify(row.ruleIds)}::jsonb)
      `;
      await sql`
        insert into ledger_audit (run_id, user_id, invoice_external_id, rule_id, action, message)
        values (${runId}, ${userId}, ${row.externalId}, ${row.ruleIds[0] ?? "R008"}, 'classify', ${row.message})
      `;
    }
    const payloadJson = JSON.stringify(result.payload);
    const fxJson = JSON.stringify(result.payload.fx_rates_snapshot);
    await sql`
      update ledger_runs
      set status = 'succeeded', payload = ${payloadJson}::jsonb, fx_rates_snapshot = ${fxJson}::jsonb, finished_at = now()
      where id = ${runId} and user_id = ${userId}
    `;
    return { runId, payload: result.payload };
  } catch (error) {
    await sql`delete from ledger_classifications where run_id = ${runId}`;
    await sql`delete from ledger_invoices where run_id = ${runId}`;
    const message = error instanceof Error ? error.message : "Run failed";
    await sql`
      update ledger_runs
      set status = 'failed', error = ${message}, finished_at = now()
      where id = ${runId} and user_id = ${userId}
    `;
    throw error;
  }
}

export async function listRuns(sql: Sql, userId: string): Promise<RunRow[]> {
  const rows = await sql<{
    id: string;
    status: string;
    started_at: string | Date;
    error: string | null;
    client_name: string;
    payload: unknown;
  }>`
    select r.id, r.status, r.started_at, r.error, c.name as client_name, r.payload
    from ledger_runs r
    join ledger_clients c on c.id = r.client_id
    where r.user_id = ${userId}
    order by r.started_at desc
    limit 30
  `;
  return rows.map((row) => {
    const payload = row.payload ? asObject<LedgerPayload>(row.payload) : null;
    return {
      id: row.id,
      status: row.status,
      started_at: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
      error: row.error,
      client_name: row.client_name,
      trapped_cash_inr_cr: payload?.headline?.trapped_cash_inr_cr ?? null,
    };
  });
}

export async function viewRun(
  sql: Sql,
  userId: string | null,
  runId: string,
): Promise<{ payload: LedgerPayload; watermark: string; viewedAt: string }> {
  const rows = await sql<{ user_id: string; payload: unknown; status: string }>`
    select user_id, payload, status from ledger_runs where id = ${runId}
  `;
  const row = rows[0];
  authorizeRun(row?.user_id ?? null, userId);
  if (!row || row.status !== "succeeded" || !row.payload) {
    throw new LedgerError("NOT_FOUND", "Report not found");
  }
  const viewedAt = new Date().toISOString();
  const payload = asObject<LedgerPayload>(row.payload);
  const mark = `${payload.client.name} · ${payload.run_id} · ${viewedAt}`;
  await sql`
    insert into ledger_audit (run_id, user_id, action, message)
    values (${runId}, ${userId}, 'view', ${mark})
  `;
  return { payload, watermark: mark, viewedAt };
}
