/**
 * GET /api/cron/prospect-fetch
 * Vercel Cron handler that runs the Apollo prospect enrichment pipeline.
 * Queries active campaigns, fetches matching prospects from Apollo using each
 * campaign's ICP filters, enriches them with company news and hiring signals,
 * and upserts structured records for the email generation step.
 * Auth: CRON_SECRET bearer token (same pattern as /api/cron/approved-actions).
 */

import { NextResponse } from "next/server";
import { searchProspects, fetchHiringSignals } from "@/lib/sdr/apollo-enrichment";
import { fetchCompanyNews, fetchFundingNews } from "@/lib/sdr/news-rag-fetcher";
import type { IcpFilters, ApolloProspect } from "@/lib/sdr/apollo-enrichment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (cfg: Record<string, unknown>) => { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  };
  _pool = new PgPool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30_000 });
  return _pool;
}

interface SdrCampaign {
  id: string;
  name: string;
  icp_filters: IcpFilters;
}

interface ProcessResult {
  campaign_id: string;
  campaign_name: string;
  prospects_fetched: number;
  prospects_stored: number;
  error?: string;
}

async function ensureTables(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdr_campaigns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      icp_filters jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'active',
      owner_email text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdr_prospects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id uuid NOT NULL REFERENCES sdr_campaigns(id) ON DELETE CASCADE,
      apollo_person_id text NOT NULL,
      first_name text,
      last_name text,
      email text,
      email_status text,
      title text,
      linkedin_url text,
      city text,
      state text,
      country text,
      seniority text,
      departments jsonb NOT NULL DEFAULT '[]'::jsonb,
      company_name text,
      company_domain text,
      company_size text,
      industry text,
      technology_names jsonb NOT NULL DEFAULT '[]'::jsonb,
      funding_stage text,
      funding_date text,
      total_funding numeric,
      hiring_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
      news_snippets jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'new',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (campaign_id, apollo_person_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_sdr_prospects_campaign ON sdr_prospects (campaign_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_sdr_prospects_status ON sdr_prospects (status)`
  );
}

async function getActiveCampaigns(): Promise<SdrCampaign[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, name, icp_filters FROM sdr_campaigns WHERE status = $1 ORDER BY created_at DESC LIMIT 10`,
    ["active"]
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    icp_filters: (typeof row.icp_filters === "object" && row.icp_filters !== null
      ? row.icp_filters
      : {}) as IcpFilters,
  }));
}

async function upsertProspect(
  campaignId: string,
  prospect: ApolloProspect,
  hiringSignals: unknown[],
  newsSnippets: unknown[]
): Promise<void> {
  const pool = getPool();
  const org = prospect.organization;

  await pool.query(
    `INSERT INTO sdr_prospects (
      campaign_id, apollo_person_id, first_name, last_name, email, email_status,
      title, linkedin_url, city, state, country, seniority, departments,
      company_name, company_domain, company_size, industry, technology_names,
      funding_stage, funding_date, total_funding, hiring_signals, news_snippets,
      status, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
      $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22::jsonb, $23::jsonb,
      'new', now()
    )
    ON CONFLICT (campaign_id, apollo_person_id) DO UPDATE SET
      email = EXCLUDED.email,
      email_status = EXCLUDED.email_status,
      title = EXCLUDED.title,
      linkedin_url = EXCLUDED.linkedin_url,
      company_name = EXCLUDED.company_name,
      company_domain = EXCLUDED.company_domain,
      industry = EXCLUDED.industry,
      technology_names = EXCLUDED.technology_names,
      funding_stage = EXCLUDED.funding_stage,
      funding_date = EXCLUDED.funding_date,
      total_funding = EXCLUDED.total_funding,
      hiring_signals = EXCLUDED.hiring_signals,
      news_snippets = EXCLUDED.news_snippets,
      updated_at = now()`,
    [
      campaignId,
      prospect.id,
      prospect.first_name,
      prospect.last_name,
      prospect.email,
      prospect.email_status,
      prospect.title,
      prospect.linkedin_url,
      prospect.city,
      prospect.state,
      prospect.country,
      prospect.seniority,
      JSON.stringify(prospect.departments),
      org?.name ?? null,
      org?.primary_domain ?? null,
      org?.estimated_num_employees != null ? String(org.estimated_num_employees) : null,
      org?.industry ?? null,
      JSON.stringify(org?.technology_names ?? []),
      org?.latest_funding_stage ?? null,
      org?.latest_funding_round_date ?? null,
      org?.total_funding ?? null,
      JSON.stringify(hiringSignals),
      JSON.stringify(newsSnippets),
    ]
  );
}

function isCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const authHeader = request.headers.get("authorization") ?? "";
  return authHeader === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorized(request)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (!process.env.APOLLO_API_KEY) {
    return NextResponse.json({ skipped: true, reason: "APOLLO_API_KEY not configured" });
  }

  try {
    await ensureTables();
  } catch (err) {
    return NextResponse.json(
      { error: "Table setup failed", detail: String((err as Error).message) },
      { status: 500 }
    );
  }

  let campaigns: SdrCampaign[];
  try {
    campaigns = await getActiveCampaigns();
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch campaigns", detail: String((err as Error).message) },
      { status: 500 }
    );
  }

  const results: ProcessResult[] = [];

  for (const campaign of campaigns) {
    const result: ProcessResult = {
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      prospects_fetched: 0,
      prospects_stored: 0,
    };

    try {
      const searchResult = await searchProspects(campaign.icp_filters, 1, 25);
      result.prospects_fetched = searchResult.prospects.length;

      for (const prospect of searchResult.prospects) {
        const domain = prospect.organization?.primary_domain ?? "";
        const companyName = prospect.organization?.name ?? "";

        const [hiringSignals, companyNews, fundingNews] = await Promise.all([
          domain ? fetchHiringSignals(companyName, domain).catch(() => []) : Promise.resolve([]),
          companyName ? fetchCompanyNews(companyName, domain, 3).catch(() => []) : Promise.resolve([]),
          companyName ? fetchFundingNews(companyName, 2).catch(() => []) : Promise.resolve([]),
        ]);

        const newsSnippets = [...companyNews, ...fundingNews].slice(0, 5);

        await upsertProspect(campaign.id, prospect, hiringSignals, newsSnippets).catch((err) => {
          console.error(
            JSON.stringify({
              event: "prospect_upsert_failed",
              campaign_id: campaign.id,
              apollo_person_id: prospect.id,
              error: String((err as Error).message),
            })
          );
        });
        result.prospects_stored += 1;
      }
    } catch (err) {
      result.error = String((err as Error).message);
      console.error(
        JSON.stringify({
          event: "campaign_enrichment_failed",
          campaign_id: campaign.id,
          error: result.error,
        })
      );
    }

    results.push(result);
  }

  return NextResponse.json({
    processed_campaigns: results.length,
    results,
    timestamp: new Date().toISOString(),
  });
}
