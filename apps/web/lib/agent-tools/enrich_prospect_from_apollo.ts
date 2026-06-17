/**
 * Agent tool: enrich_prospect_from_apollo
 *
 * Confirm-gated mutation — queries the Apollo.io People + Organization APIs
 * to enrich a prospect record with role, company size, technographics,
 * recent funding events, and hiring signals.  Called by the agent when a
 * new outbound campaign is activated.
 *
 * Autonomy: autonomous — routes through the cross-boundary bridge because
 * it writes to the DB (mutation class).
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

// ── Apollo API response shapes (minimal) ──────────────────────────────────

interface ApolloPersonMatch {
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  title?: string;
  seniority?: string;
  departments?: string[];
  organization?: ApolloOrg;
}

interface ApolloOrg {
  id?: string;
  name?: string;
  website_url?: string;
  employee_count?: number;
  estimated_num_employees?: number;
  industry?: string;
  keywords?: string[];
  technologies?: string[];
  latest_funding_stage?: string;
  total_funding?: number;
  total_funding_printed?: string;
  last_funding_amount?: number;
  last_funding_amount_printed?: string;
  last_funding_at?: string;
  job_postings?: ApolloJobPosting[];
}

interface ApolloJobPosting {
  id?: string;
  title?: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
}

interface ApolloMatchResponse {
  person?: ApolloPersonMatch;
  status?: string;
}

// ── Helper: call Apollo People Match API ─────────────────────────────────

async function apolloMatchPerson(params: {
  first_name?: string;
  last_name?: string;
  email?: string;
  organization_name?: string;
  domain?: string;
  linkedin_url?: string;
}): Promise<ApolloPersonMatch | null> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error("APOLLO_API_KEY environment variable is not set");
  }

  const response = await fetch("https://api.apollo.io/v1/people/match", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      ...params,
      reveal_personal_emails: false,
      reveal_phone_number: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Apollo People Match API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as ApolloMatchResponse;
  return data.person ?? null;
}

// ── Helper: call Apollo Organization Enrich API ──────────────────────────

async function apolloEnrichOrganization(params: {
  domain?: string;
  organization_name?: string;
}): Promise<ApolloOrg | null> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error("APOLLO_API_KEY environment variable is not set");
  }

  const response = await fetch("https://api.apollo.io/v1/organizations/enrich", {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey,
    },
  });

  // Apollo enrich uses query params, rebuild as GET with params
  const url = new URL("https://api.apollo.io/v1/organizations/enrich");
  if (params.domain) url.searchParams.set("domain", params.domain);
  if (params.organization_name) url.searchParams.set("organization_name", params.organization_name);

  const enrichResponse = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey,
    },
  });

  if (!enrichResponse.ok) {
    // Non-fatal: org enrich may return 404 for unknown companies
    if (enrichResponse.status === 404) return null;
    const text = await enrichResponse.text();
    throw new Error(`Apollo Org Enrich API error ${enrichResponse.status}: ${text}`);
  }

  const data = (await enrichResponse.json()) as { organization?: ApolloOrg };
  return data.organization ?? null;
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function handleEnrichProspectFromApollo(
  ctx: HandlerContext,
  args: Args
): Promise<HandlerResult> {
  // Validate required args
  const prospectId = args.prospect_id as string | undefined;
  if (!prospectId || typeof prospectId !== "string") {
    return { status: 400, body: "Missing required argument: prospect_id (UUID string)" };
  }

  // ICP filter parameters (optional — used to validate match relevance)
  const minEmployees = typeof args.min_employees === "number" ? args.min_employees : 0;
  const maxEmployees =
    typeof args.max_employees === "number" ? args.max_employees : Number.MAX_SAFE_INTEGER;
  const targetIndustries = Array.isArray(args.target_industries)
    ? (args.target_industries as string[])
    : [];
  const targetSeniorities = Array.isArray(args.target_seniorities)
    ? (args.target_seniorities as string[])
    : [];

  // Load existing prospect record
  const prospects = await ctx.db.query<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    company_name: string | null;
    company_domain: string | null;
    linkedin_url: string | null;
    enrichment_status: string | null;
  }>(
    `SELECT id, first_name, last_name, email, company_name, company_domain,
            linkedin_url, enrichment_status
     FROM sdr_prospects
     WHERE id = $1`,
    prospectId
  );

  if (prospects.length === 0) {
    return { status: 404, body: `Prospect ${prospectId} not found` };
  }

  const prospect = prospects[0];

  // ── Step 1: Person enrichment ───────────────────────────────────────────
  let person: ApolloPersonMatch | null = null;
  try {
    person = await apolloMatchPerson({
      first_name: prospect.first_name ?? undefined,
      last_name: prospect.last_name ?? undefined,
      email: prospect.email ?? undefined,
      organization_name: prospect.company_name ?? undefined,
      domain: prospect.company_domain ?? undefined,
      linkedin_url: prospect.linkedin_url ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 502, body: `Apollo People Match failed: ${message}` };
  }

  if (!person) {
    return {
      status: 404,
      body: `Apollo could not match a person record for prospect ${prospectId}`,
    };
  }

  // ── Step 2: ICP filter gate ─────────────────────────────────────────────
  const org = person.organization;
  const employeeCount = org?.employee_count ?? org?.estimated_num_employees ?? 0;

  if (employeeCount > 0 && (employeeCount < minEmployees || employeeCount > maxEmployees)) {
    return {
      status: 422,
      body: `Prospect company employee count (${employeeCount}) is outside ICP range [${minEmployees}, ${maxEmployees}]`,
    };
  }

  if (
    targetIndustries.length > 0 &&
    org?.industry &&
    !targetIndustries.some((ind) =>
      org.industry!.toLowerCase().includes(ind.toLowerCase())
    )
  ) {
    return {
      status: 422,
      body: `Prospect company industry ("${org.industry}") does not match target industries: ${targetIndustries.join(", ")}`,
    };
  }

  if (
    targetSeniorities.length > 0 &&
    person.seniority &&
    !targetSeniorities.some((sen) => person.seniority!.toLowerCase() === sen.toLowerCase())
  ) {
    return {
      status: 422,
      body: `Prospect seniority ("${person.seniority}") does not match target seniorities: ${targetSeniorities.join(", ")}`,
    };
  }

  // ── Step 3: Organization enrichment (full technographics + funding) ─────
  let fullOrg: ApolloOrg | null = org ?? null;
  if (prospect.company_domain || prospect.company_name) {
    try {
      const enriched = await apolloEnrichOrganization({
        domain: prospect.company_domain ?? undefined,
        organization_name: prospect.company_name ?? undefined,
      });
      if (enriched) fullOrg = enriched;
    } catch {
      // Non-fatal — proceed with person.organization data
    }
  }

  // ── Step 4: Extract structured signals ─────────────────────────────────
  const technographics: string[] = fullOrg?.technologies ?? fullOrg?.keywords ?? [];
  const fundingStage = fullOrg?.latest_funding_stage ?? null;
  const totalFunding = fullOrg?.total_funding ?? null;
  const lastFundingAt = fullOrg?.last_funding_at ?? null;
  const hiringSignals: string[] = (fullOrg?.job_postings ?? [])
    .slice(0, 10)
    .map((jp) => jp.title ?? "")
    .filter(Boolean);

  const enrichmentData = {
    apollo_person_id: person.id ?? null,
    apollo_org_id: fullOrg?.id ?? null,
    job_title: person.title ?? null,
    seniority: person.seniority ?? null,
    departments: person.departments ?? [],
    company_employee_count: employeeCount || null,
    company_industry: fullOrg?.industry ?? null,
    technographics,
    funding_stage: fundingStage,
    total_funding: totalFunding,
    last_funding_at: lastFundingAt ? new Date(lastFundingAt).toISOString() : null,
    hiring_signals: hiringSignals,
    enriched_at: new Date().toISOString(),
  };

  // ── Step 5: Persist enrichment to DB ───────────────────────────────────
  await ctx.db.execute(
    `INSERT INTO sdr_prospect_enrichments (
       prospect_id, apollo_person_id, apollo_org_id,
       job_title, seniority, departments,
       company_employee_count, company_industry,
       technographics, funding_stage, total_funding, last_funding_at,
       hiring_signals, enriched_at
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6::jsonb,
       $7, $8,
       $9::jsonb, $10, $11, $12,
       $13::jsonb, $14
     )
     ON CONFLICT (prospect_id) DO UPDATE SET
       apollo_person_id      = EXCLUDED.apollo_person_id,
       apollo_org_id         = EXCLUDED.apollo_org_id,
       job_title             = EXCLUDED.job_title,
       seniority             = EXCLUDED.seniority,
       departments           = EXCLUDED.departments,
       company_employee_count = EXCLUDED.company_employee_count,
       company_industry      = EXCLUDED.company_industry,
       technographics        = EXCLUDED.technographics,
       funding_stage         = EXCLUDED.funding_stage,
       total_funding         = EXCLUDED.total_funding,
       last_funding_at       = EXCLUDED.last_funding_at,
       hiring_signals        = EXCLUDED.hiring_signals,
       enriched_at           = EXCLUDED.enriched_at`,
    prospectId,
    enrichmentData.apollo_person_id,
    enrichmentData.apollo_org_id,
    enrichmentData.job_title,
    enrichmentData.seniority,
    JSON.stringify(enrichmentData.departments),
    enrichmentData.company_employee_count,
    enrichmentData.company_industry,
    JSON.stringify(enrichmentData.technographics),
    enrichmentData.funding_stage,
    enrichmentData.total_funding,
    enrichmentData.last_funding_at,
    JSON.stringify(enrichmentData.hiring_signals),
    enrichmentData.enriched_at
  );

  // Mark prospect as enriched
  await ctx.db.execute(
    `UPDATE sdr_prospects SET enrichment_status = 'enriched', updated_at = NOW() WHERE id = $1`,
    prospectId
  );

  return {
    status: 200,
    body: {
      prospect_id: prospectId,
      enriched: true,
      apollo_person_id: enrichmentData.apollo_person_id,
      apollo_org_id: enrichmentData.apollo_org_id,
      job_title: enrichmentData.job_title,
      seniority: enrichmentData.seniority,
      company_employee_count: enrichmentData.company_employee_count,
      company_industry: enrichmentData.company_industry,
      technographics_count: technographics.length,
      funding_stage: enrichmentData.funding_stage,
      hiring_signals_count: hiringSignals.length,
      enriched_at: enrichmentData.enriched_at,
    },
  };
}
