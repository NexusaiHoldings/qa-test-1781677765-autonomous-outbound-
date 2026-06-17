/**
 * Sequence builder — persists GPT-generated 3-touch email sequences to
 * PostgreSQL and provides query helpers for the campaign UI.
 *
 * Uses the same pg Pool singleton pattern as apps/web/lib/db.ts.
 * All SQL uses parameterized queries ($1, $2 …) — never string interpolation.
 * Table is created idempotently on first call so deploys without migrations work.
 */

import {
  generateEmailSequence,
  type ProspectData,
  type EmailDraft,
} from "./email-generator";

export interface SequenceRecord {
  id: string;
  campaignId: string;
  prospectId: string;
  prospectFirstName: string;
  prospectLastName: string;
  prospectRole: string;
  prospectCompany: string;
  emails: EmailDraft[];
  status: "draft" | "active" | "paused" | "completed";
  generatedAt: string;
  createdAt: string;
}

interface RawSequenceRow {
  id: string;
  campaign_id: string;
  prospect_id: string;
  prospect_first_name: string;
  prospect_last_name: string;
  prospect_role: string;
  prospect_company: string;
  emails: EmailDraft[];
  status: string;
  generated_at: string;
  created_at: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
} {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

async function dbQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pool = getPool();
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS sdr_email_sequences (" +
  "  id UUID PRIMARY KEY DEFAULT gen_random_uuid()," +
  "  campaign_id UUID NOT NULL," +
  "  prospect_id TEXT NOT NULL," +
  "  prospect_first_name TEXT NOT NULL," +
  "  prospect_last_name TEXT NOT NULL," +
  "  prospect_role TEXT NOT NULL," +
  "  prospect_company TEXT NOT NULL," +
  "  emails JSONB NOT NULL DEFAULT '[]'," +
  "  status TEXT NOT NULL DEFAULT 'draft'," +
  "  generated_at TIMESTAMPTZ NOT NULL," +
  "  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()" +
  ")";

async function ensureTable(): Promise<void> {
  await dbQuery(CREATE_TABLE_SQL);
}

function rowToRecord(row: RawSequenceRow): SequenceRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    prospectId: row.prospect_id,
    prospectFirstName: row.prospect_first_name,
    prospectLastName: row.prospect_last_name,
    prospectRole: row.prospect_role,
    prospectCompany: row.prospect_company,
    emails: row.emails,
    status: row.status as SequenceRecord["status"],
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

export async function buildSequence(
  prospect: ProspectData,
  campaignId: string,
): Promise<SequenceRecord> {
  const sequence = await generateEmailSequence(prospect, campaignId);
  await ensureTable();

  const INSERT_SQL =
    "INSERT INTO sdr_email_sequences " +
    "(campaign_id, prospect_id, prospect_first_name, prospect_last_name, " +
    " prospect_role, prospect_company, emails, status, generated_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *";

  const rows = await dbQuery<RawSequenceRow>(INSERT_SQL, [
    campaignId,
    prospect.id,
    prospect.firstName,
    prospect.lastName,
    prospect.role,
    prospect.company,
    JSON.stringify(sequence.emails),
    "draft",
    sequence.generatedAt,
  ]);

  const row = rows[0];
  if (!row) throw new Error("Failed to insert sequence record");
  return rowToRecord(row);
}

export async function getSequencesForCampaign(
  campaignId: string,
): Promise<SequenceRecord[]> {
  await ensureTable();
  const SELECT_SQL =
    "SELECT * FROM sdr_email_sequences WHERE campaign_id = $1 ORDER BY created_at DESC";
  const rows = await dbQuery<RawSequenceRow>(SELECT_SQL, [campaignId]);
  return rows.map(rowToRecord);
}

export async function getSequenceById(
  sequenceId: string,
): Promise<SequenceRecord | null> {
  await ensureTable();
  const SELECT_SQL = "SELECT * FROM sdr_email_sequences WHERE id = $1";
  const rows = await dbQuery<RawSequenceRow>(SELECT_SQL, [sequenceId]);
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

export async function updateSequenceStatus(
  sequenceId: string,
  status: SequenceRecord["status"],
): Promise<void> {
  await ensureTable();
  const UPDATE_SQL =
    "UPDATE sdr_email_sequences SET status = $1 WHERE id = $2";
  await dbQuery(UPDATE_SQL, [status, sequenceId]);
}
