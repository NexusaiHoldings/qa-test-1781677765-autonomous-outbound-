import { buildDb } from "@/lib/db";

export interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  prospects_contacted: number;
  emails_sent: number;
  open_rate: number;
  reply_rate: number;
  meetings_booked: number;
  sequence_completion_rate: number;
  bounce_rate: number;
  spam_complaint_rate: number;
  created_at: string;
}

export interface CampaignDetail extends CampaignSummary {
  description: string | null;
  updated_at: string;
  emails_opened: number;
  emails_replied: number;
  sequences_completed: number;
  bounces: number;
  spam_complaints: number;
}

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  prospects_contacted: string | number;
  emails_sent: string | number;
  emails_opened: string | number;
  emails_replied: string | number;
  meetings_booked: string | number;
  sequences_completed: string | number;
  bounces: string | number;
  spam_complaints: string | number;
  created_at: string;
};

type CampaignDetailRow = CampaignRow & {
  description: string | null;
  updated_at: string;
};

function computeRates(row: CampaignRow): Omit<CampaignSummary, "id" | "name" | "status" | "created_at"> {
  const sent = Number(row.emails_sent) || 0;
  const opened = Number(row.emails_opened) || 0;
  const replied = Number(row.emails_replied) || 0;
  const contacted = Number(row.prospects_contacted) || 0;
  const completed = Number(row.sequences_completed) || 0;
  const bounces = Number(row.bounces) || 0;
  const spam = Number(row.spam_complaints) || 0;
  return {
    prospects_contacted: contacted,
    emails_sent: sent,
    open_rate: sent > 0 ? opened / sent : 0,
    reply_rate: sent > 0 ? replied / sent : 0,
    meetings_booked: Number(row.meetings_booked) || 0,
    sequence_completion_rate: contacted > 0 ? completed / contacted : 0,
    bounce_rate: sent > 0 ? bounces / sent : 0,
    spam_complaint_rate: sent > 0 ? spam / sent : 0,
  };
}

export async function listCampaignMetrics(): Promise<CampaignSummary[]> {
  const db = buildDb();
  try {
    const rows = await db.query<CampaignRow>(`
      SELECT
        id,
        name,
        COALESCE(status, 'draft') AS status,
        COALESCE(prospects_contacted, 0) AS prospects_contacted,
        COALESCE(emails_sent, 0) AS emails_sent,
        COALESCE(emails_opened, 0) AS emails_opened,
        COALESCE(emails_replied, 0) AS emails_replied,
        COALESCE(meetings_booked, 0) AS meetings_booked,
        COALESCE(sequences_completed, 0) AS sequences_completed,
        COALESCE(bounces, 0) AS bounces,
        COALESCE(spam_complaints, 0) AS spam_complaints,
        created_at
      FROM sdr_campaigns
      ORDER BY created_at DESC
      LIMIT 200
    `);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      created_at: row.created_at,
      ...computeRates(row),
    }));
  } catch {
    return [];
  }
}

export async function getCampaignDetail(id: string): Promise<CampaignDetail | null> {
  const db = buildDb();
  try {
    const rows = await db.query<CampaignDetailRow>(`
      SELECT
        id,
        name,
        description,
        COALESCE(status, 'draft') AS status,
        COALESCE(prospects_contacted, 0) AS prospects_contacted,
        COALESCE(emails_sent, 0) AS emails_sent,
        COALESCE(emails_opened, 0) AS emails_opened,
        COALESCE(emails_replied, 0) AS emails_replied,
        COALESCE(meetings_booked, 0) AS meetings_booked,
        COALESCE(sequences_completed, 0) AS sequences_completed,
        COALESCE(bounces, 0) AS bounces,
        COALESCE(spam_complaints, 0) AS spam_complaints,
        created_at,
        COALESCE(updated_at, created_at) AS updated_at
      FROM sdr_campaigns
      WHERE id = $1
    `, id);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      emails_opened: Number(row.emails_opened) || 0,
      emails_replied: Number(row.emails_replied) || 0,
      sequences_completed: Number(row.sequences_completed) || 0,
      bounces: Number(row.bounces) || 0,
      spam_complaints: Number(row.spam_complaints) || 0,
      ...computeRates(row),
    };
  } catch {
    return null;
  }
}

export function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
