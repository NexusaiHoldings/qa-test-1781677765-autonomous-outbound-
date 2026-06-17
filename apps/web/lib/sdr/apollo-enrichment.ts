/**
 * Apollo.io API client for prospect enrichment.
 * Queries the Apollo People Search API using campaign ICP filters to build
 * enriched prospect lists with role, company size, technographics,
 * funding events, and hiring signals.
 */

export interface IcpFilters {
  job_titles?: string[];
  seniority_levels?: string[];
  industries?: string[];
  company_sizes?: string[];
  locations?: string[];
  keywords?: string[];
  excluded_domains?: string[];
}

export interface ApolloOrganization {
  id: string;
  name: string;
  website_url: string | null;
  primary_domain: string | null;
  estimated_num_employees: number | null;
  industry: string | null;
  technology_names: string[];
  latest_funding_round_date: string | null;
  latest_funding_stage: string | null;
  total_funding: number | null;
  linkedin_url: string | null;
  short_description: string | null;
}

export interface ApolloProspect {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  email_status: string | null;
  title: string | null;
  linkedin_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  seniority: string | null;
  departments: string[];
  organization: ApolloOrganization | null;
}

export interface HiringSignal {
  role: string;
  department: string;
  posted_at: string;
  url: string | null;
}

export interface ProspectSearchResult {
  prospects: ApolloProspect[];
  total_count: number;
  has_more: boolean;
}

interface RawApolloOrg {
  id?: string; name?: string; website_url?: string; primary_domain?: string;
  estimated_num_employees?: number; industry?: string; technology_names?: string[];
  latest_funding_round_date?: string; latest_funding_stage?: string;
  total_funding?: number; linkedin_url?: string; short_description?: string;
}

interface RawApolloPerson {
  id?: string; first_name?: string; last_name?: string; email?: string;
  email_status?: string; title?: string; linkedin_url?: string;
  city?: string; state?: string; country?: string; seniority?: string;
  departments?: string[]; organization?: RawApolloOrg;
}

function getApolloApiKey(): string {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new Error("APOLLO_API_KEY environment variable is not set");
  return key;
}

function employeeRangeForSize(size: string): string | null {
  const map: Record<string, string> = {
    "1-10": "1,10", "11-50": "11,50", "51-200": "51,200",
    "201-500": "201,500", "501-1000": "501,1000", "1001-5000": "1001,5000",
    "5001-10000": "5001,10000", "10001+": "10001,9999999",
  };
  return map[size] ?? null;
}

function toOrganization(raw: RawApolloOrg): ApolloOrganization {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    website_url: raw.website_url ?? null,
    primary_domain: raw.primary_domain ?? null,
    estimated_num_employees: raw.estimated_num_employees ?? null,
    industry: raw.industry ?? null,
    technology_names: raw.technology_names ?? [],
    latest_funding_round_date: raw.latest_funding_round_date ?? null,
    latest_funding_stage: raw.latest_funding_stage ?? null,
    total_funding: raw.total_funding ?? null,
    linkedin_url: raw.linkedin_url ?? null,
    short_description: raw.short_description ?? null,
  };
}

function toPerson(raw: RawApolloPerson): ApolloProspect {
  return {
    id: raw.id ?? crypto.randomUUID(),
    first_name: raw.first_name ?? "",
    last_name: raw.last_name ?? "",
    email: raw.email ?? null,
    email_status: raw.email_status ?? null,
    title: raw.title ?? null,
    linkedin_url: raw.linkedin_url ?? null,
    city: raw.city ?? null,
    state: raw.state ?? null,
    country: raw.country ?? null,
    seniority: raw.seniority ?? null,
    departments: raw.departments ?? [],
    organization: raw.organization ? toOrganization(raw.organization) : null,
  };
}

export async function searchProspects(
  filters: IcpFilters,
  page = 1,
  perPage = 25
): Promise<ProspectSearchResult> {
  const apiKey = getApolloApiKey();

  const employeeRanges = (filters.company_sizes ?? [])
    .map(employeeRangeForSize)
    .filter((r): r is string => r !== null);

  const body: Record<string, unknown> = {
    page,
    per_page: perPage,
    prospected_by_current_team: ["no"],
  };
  if ((filters.job_titles ?? []).length > 0) body.person_titles = filters.job_titles;
  if ((filters.seniority_levels ?? []).length > 0) body.person_seniorities = filters.seniority_levels;
  if ((filters.industries ?? []).length > 0) body.organization_industry_tag_ids = filters.industries;
  if (employeeRanges.length > 0) body.organization_num_employees_ranges = employeeRanges;
  if ((filters.locations ?? []).length > 0) body.person_locations = filters.locations;
  if ((filters.keywords ?? []).length > 0) body.q_keywords = filters.keywords!.join(" ");
  if ((filters.excluded_domains ?? []).length > 0) body.organization_not_domains = filters.excluded_domains;

  const response = await fetch("https://api.apollo.io/v1/mixed_people/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Apollo search failed ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    people?: RawApolloPerson[];
    pagination?: { total_entries?: number };
  };

  const prospects = (data.people ?? []).map(toPerson);
  const totalCount = data.pagination?.total_entries ?? prospects.length;

  return {
    prospects,
    total_count: totalCount,
    has_more: page * perPage < totalCount,
  };
}

export async function enrichOrganization(
  domain: string
): Promise<ApolloOrganization | null> {
  const apiKey = getApolloApiKey();

  const response = await fetch(
    `https://api.apollo.io/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
    {
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
    }
  );

  if (!response.ok) return null;

  const data = (await response.json()) as { organization?: RawApolloOrg };
  return data.organization ? toOrganization(data.organization) : null;
}

export async function fetchHiringSignals(
  _companyName: string,
  domain: string
): Promise<HiringSignal[]> {
  const apiKey = getApolloApiKey();

  const response = await fetch("https://api.apollo.io/v1/mixed_jobs/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      organization_domains: [domain],
      page: 1,
      per_page: 10,
    }),
  });

  if (!response.ok) return [];

  const data = (await response.json()) as {
    jobs?: Array<{
      title?: string;
      department?: string;
      posted_at?: string;
      url?: string;
    }>;
  };

  return (data.jobs ?? []).map((job) => ({
    role: job.title ?? "Unknown Role",
    department: job.department ?? "Engineering",
    posted_at: job.posted_at ?? new Date().toISOString(),
    url: job.url ?? null,
  }));
}
