/**
 * /campaigns/[id]/prospects — server component page displaying the enriched
 * prospect list for a campaign. Pulls Apollo-enriched records from sdr_prospects
 * including funding stage, hiring signals, technographics, and news snippets.
 */

interface HiringSignal { role: string; department: string; posted_at: string; }
interface NewsSnippet { title: string; url: string; source: string; published_at: string; }

interface Prospect {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  title: string | null;
  linkedin_url: string | null;
  city: string | null;
  country: string | null;
  company_name: string | null;
  company_domain: string | null;
  industry: string | null;
  company_size: string | null;
  funding_stage: string | null;
  technology_names: string[];
  hiring_signals: HiringSignal[];
  news_snippets: NewsSnippet[];
  status: string;
  created_at: string;
}

interface Campaign { id: string; name: string; status: string; }

interface PageProps {
  params: { id: string };
  searchParams: { status?: string; page?: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (cfg: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  };
  _pool = new PgPool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30_000 });
  return _pool;
}

async function getCampaign(id: string): Promise<Campaign | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, name, status FROM sdr_campaigns WHERE id = $1 LIMIT 1`,
      [id]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: String(row.id), name: String(row.name), status: String(row.status) };
  } catch {
    return null;
  }
}

function safeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  return [];
}

async function getProspects(
  campaignId: string,
  status: string | undefined,
  page: number
): Promise<{ prospects: Prospect[]; total: number }> {
  try {
    const pool = getPool();
    const perPage = 25;
    const offset = (page - 1) * perPage;
    const params: unknown[] = [campaignId];
    let whereExtra = "";
    if (status && status !== "all") {
      params.push(status);
      whereExtra = ` AND status = $${params.length}`;
    }

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::text AS count FROM sdr_prospects WHERE campaign_id = $1${whereExtra}`,
      params
    );
    const total = parseInt(String((countRows[0] as Record<string, unknown>)?.count ?? "0"), 10);

    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, title, linkedin_url, city, country,
         company_name, company_domain, industry, company_size, funding_stage,
         technology_names, hiring_signals, news_snippets, status, created_at
       FROM sdr_prospects
       WHERE campaign_id = $1${whereExtra}
       ORDER BY created_at DESC
       LIMIT ${perPage} OFFSET ${offset}`,
      params
    );

    const prospects = (rows as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      first_name: row.first_name ? String(row.first_name) : null,
      last_name: row.last_name ? String(row.last_name) : null,
      email: row.email ? String(row.email) : null,
      title: row.title ? String(row.title) : null,
      linkedin_url: row.linkedin_url ? String(row.linkedin_url) : null,
      city: row.city ? String(row.city) : null,
      country: row.country ? String(row.country) : null,
      company_name: row.company_name ? String(row.company_name) : null,
      company_domain: row.company_domain ? String(row.company_domain) : null,
      industry: row.industry ? String(row.industry) : null,
      company_size: row.company_size ? String(row.company_size) : null,
      funding_stage: row.funding_stage ? String(row.funding_stage) : null,
      technology_names: safeJsonArray(row.technology_names) as string[],
      hiring_signals: safeJsonArray(row.hiring_signals) as HiringSignal[],
      news_snippets: safeJsonArray(row.news_snippets) as NewsSnippet[],
      status: String(row.status ?? "new"),
      created_at: String(row.created_at ?? ""),
    }));

    return { prospects, total };
  } catch {
    return { prospects: [], total: 0 };
  }
}

export default async function ProspectsPage({ params, searchParams }: PageProps) {
  const campaignId = params.id;
  const statusFilter = searchParams.status;
  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10));

  const [campaign, { prospects, total }] = await Promise.all([
    getCampaign(campaignId),
    getProspects(campaignId, statusFilter, page),
  ]);

  const perPage = 25;
  const totalPages = Math.ceil(total / perPage);
  const baseHref = `/campaigns/${campaignId}/prospects`;

  if (!campaign) {
    return (
      <main>
        <h1>Campaign Not Found</h1>
        <p>This campaign does not exist or the enrichment tables have not been initialized yet.</p>
        <a href="/campaigns" className="btn secondary">Back to Campaigns</a>
      </main>
    );
  }

  return (
    <main>
      <h1>{campaign.name} — Prospects</h1>
      <p>
        Enriched prospect list built from Apollo ICP filters with funding events, hiring signals,
        and company news for personalized outreach.
      </p>

      <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginBottom: "1rem" }}>
        <a href={`/campaigns/${campaignId}`} className="btn secondary">← Campaign</a>
        <span className="muted">{total} prospect{total !== 1 ? "s" : ""}</span>
      </div>

      <form className="toolbar" action={baseHref} method="get">
        <select name="status" defaultValue={statusFilter ?? "all"}>
          <option value="all">All statuses</option>
          <option value="new">New</option>
          <option value="contacted">Contacted</option>
          <option value="replied">Replied</option>
          <option value="suppressed">Suppressed</option>
        </select>
        <button type="submit">Filter</button>
      </form>

      {prospects.length === 0 ? (
        <div className="empty">
          <p>No prospects yet.</p>
          <p className="muted">
            The enrichment cron job will populate this list on its next run.
            Ensure <code>APOLLO_API_KEY</code> is set and the campaign has ICP filters configured.
          </p>
        </div>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Contact</th>
                <th>Role</th>
                <th>Company</th>
                <th>Signals</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {prospects.map((prospect) => {
                const fullName =
                  [prospect.first_name, prospect.last_name].filter(Boolean).join(" ") || "—";
                const location = [prospect.city, prospect.country].filter(Boolean).join(", ");
                const hiringCount = prospect.hiring_signals.length;
                const newsCount = prospect.news_snippets.length;
                const techCount = prospect.technology_names.length;

                return (
                  <tr key={prospect.id}>
                    <td>
                      <strong>{fullName}</strong>
                      {location && (
                        <>
                          <br />
                          <span className="muted">{location}</span>
                        </>
                      )}
                      {prospect.email && (
                        <>
                          <br />
                          <span className="muted">{prospect.email}</span>
                        </>
                      )}
                      {prospect.linkedin_url && (
                        <>
                          <br />
                          <a href={prospect.linkedin_url} target="_blank" rel="noreferrer" className="muted">
                            LinkedIn ↗
                          </a>
                        </>
                      )}
                    </td>
                    <td>
                      {prospect.title ?? "—"}
                      {prospect.industry && (
                        <>
                          <br />
                          <span className="muted">{prospect.industry}</span>
                        </>
                      )}
                    </td>
                    <td>
                      {prospect.company_name ?? "—"}
                      {prospect.company_domain && (
                        <>
                          <br />
                          <span className="muted">{prospect.company_domain}</span>
                        </>
                      )}
                      {prospect.funding_stage && (
                        <>
                          <br />
                          <span className="muted">Funding: {prospect.funding_stage}</span>
                        </>
                      )}
                      {prospect.company_size && (
                        <>
                          <br />
                          <span className="muted">{prospect.company_size} employees</span>
                        </>
                      )}
                    </td>
                    <td>
                      {hiringCount > 0 && (
                        <span className="muted">{hiringCount} open role{hiringCount !== 1 ? "s" : ""}</span>
                      )}
                      {newsCount > 0 && (
                        <>
                          {hiringCount > 0 && <br />}
                          <span className="muted">{newsCount} news item{newsCount !== 1 ? "s" : ""}</span>
                        </>
                      )}
                      {techCount > 0 && (
                        <>
                          {(hiringCount > 0 || newsCount > 0) && <br />}
                          <span className="muted">{techCount} tech signal{techCount !== 1 ? "s" : ""}</span>
                        </>
                      )}
                      {hiringCount === 0 && newsCount === 0 && techCount === 0 && "—"}
                    </td>
                    <td>{prospect.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {totalPages > 1 && (
            <nav style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "1rem" }}>
              {page > 1 && (
                <a
                  href={`${baseHref}?status=${statusFilter ?? "all"}&page=${page - 1}`}
                  className="btn secondary"
                >
                  Previous
                </a>
              )}
              <span className="muted">Page {page} of {totalPages}</span>
              {page < totalPages && (
                <a
                  href={`${baseHref}?status=${statusFilter ?? "all"}&page=${page + 1}`}
                  className="btn secondary"
                >
                  Next
                </a>
              )}
            </nav>
          )}
        </>
      )}
    </main>
  );
}
