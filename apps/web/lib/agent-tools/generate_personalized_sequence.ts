/**
 * Agent tool: generate_personalized_sequence
 *
 * Confirm-gated mutation — calls the LLM gateway with structured prospect
 * signals and RAG-fetched company news to generate a 3-touch cold email
 * sequence with dynamic personalization fields.  Called after prospect
 * enrichment completes.
 *
 * Autonomy: confirm — routes through the cross-boundary bridge because
 * it writes to the DB (mutation class).
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

// ── LLM gateway types ─────────────────────────────────────────────────────

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMChoice {
  message: { content: string };
}

interface LLMResponse {
  choices: LLMChoice[];
}

// ── Email sequence types ─────────────────────────────────────────────────

interface EmailTouch {
  touch_number: number;
  subject: string;
  body: string;
  personalization_fields: Record<string, string>;
  send_delay_days: number;
}

interface GeneratedSequence {
  touches: EmailTouch[];
  personalization_summary: string;
  news_signals_used: string[];
}

// ── Prospect / enrichment DB row shapes ─────────────────────────────────

interface ProspectRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
  company_domain: string | null;
  linkedin_url: string | null;
}

interface EnrichmentRow {
  job_title: string | null;
  seniority: string | null;
  departments: unknown;
  company_employee_count: number | null;
  company_industry: string | null;
  technographics: unknown;
  funding_stage: string | null;
  total_funding: number | null;
  hiring_signals: unknown;
}

// ── Helper: fetch company news via RSS ───────────────────────────────────

async function fetchCompanyNews(
  companyName: string,
  domain: string | null
): Promise<string[]> {
  const signals: string[] = [];
  const query = encodeURIComponent(`${companyName} news funding product launch`);
  const feedUrl = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const response = await fetch(feedUrl, {
      headers: { "User-Agent": "NexusSDR/1.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return signals;

    const xml = await response.text();
    const titleMatches = xml.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g);
    for (const match of titleMatches) {
      const title = match[1].trim();
      if (title && !title.toLowerCase().includes("google news")) {
        signals.push(title);
        if (signals.length >= 5) break;
      }
    }

    if (signals.length === 0) {
      const simpleTitleMatches = xml.matchAll(/<title>([^<]+)<\/title>/g);
      for (const match of simpleTitleMatches) {
        const title = match[1].trim();
        if (title && !title.toLowerCase().includes("google news")) {
          signals.push(title);
          if (signals.length >= 5) break;
        }
      }
    }
  } catch {
    // Non-fatal: news fetch failure degrades gracefully
  }

  if (domain) {
    try {
      const domainFeedUrl = `https://news.google.com/rss/search?q=site:${encodeURIComponent(domain)}&hl=en-US&gl=US&ceid=US:en`;
      const domainResponse = await fetch(domainFeedUrl, {
        headers: { "User-Agent": "NexusSDR/1.0" },
        signal: AbortSignal.timeout(5000),
      });
      if (domainResponse.ok) {
        const domainXml = await domainResponse.text();
        const domainTitles = domainXml.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g);
        for (const match of domainTitles) {
          const title = match[1].trim();
          if (title && !signals.includes(title)) {
            signals.push(title);
            if (signals.length >= 8) break;
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return signals.slice(0, 8);
}

// ── Helper: call LLM gateway ─────────────────────────────────────────────

async function callLLMGateway(messages: LLMMessage[]): Promise<string> {
  const gatewayUrl =
    process.env.OPENAI_GATEWAY_URL ?? "https://api.openai.com/v1/chat/completions";
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }

  const response = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages,
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM gateway error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as LLMResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM gateway returned empty response");
  }
  return content;
}

// ── Helper: build LLM prompt ──────────────────────────────────────────────

function buildPrompt(
  prospect: ProspectRow,
  enrichment: EnrichmentRow | null,
  newsSignals: string[],
  campaignContext: string | null
): LLMMessage[] {
  const firstName = prospect.first_name ?? "there";
  const lastName = prospect.last_name ?? "";
  const fullName = `${firstName} ${lastName}`.trim();
  const companyName = prospect.company_name ?? "your company";
  const jobTitle = enrichment?.job_title ?? "professional";
  const industry = enrichment?.company_industry ?? "";
  const fundingStage = enrichment?.funding_stage ?? "";
  const employeeCount = enrichment?.company_employee_count ?? null;
  const technographics = Array.isArray(enrichment?.technographics)
    ? (enrichment!.technographics as string[]).slice(0, 5).join(", ")
    : "";
  const hiringSignals = Array.isArray(enrichment?.hiring_signals)
    ? (enrichment!.hiring_signals as string[]).slice(0, 3).join("; ")
    : "";

  const newsContext =
    newsSignals.length > 0
      ? `Recent news about ${companyName}:\n${newsSignals.map((n) => `- ${n}`).join("\n")}`
      : "";

  const enrichmentContext = [
    jobTitle && `Role: ${jobTitle}`,
    industry && `Industry: ${industry}`,
    fundingStage && `Funding stage: ${fundingStage}`,
    employeeCount && `Company size: ~${employeeCount} employees`,
    technographics && `Tech stack signals: ${technographics}`,
    hiringSignals && `Active hiring for: ${hiringSignals}`,
  ]
    .filter(Boolean)
    .join("\n");

  const systemPrompt = `You are an expert B2B cold email copywriter. Generate a 3-touch cold email sequence for an outbound SDR campaign.
Each email must be concise, highly personalized, and focused on the prospect's specific situation.

RULES:
- Touch 1 (Day 0): Introduce with a specific hook from news or company signals — max 120 words
- Touch 2 (Day 3): Follow up with a pain-point angle relevant to their role/industry — max 100 words
- Touch 3 (Day 7): Soft break-up email with a clear low-friction CTA — max 80 words
- Use {{first_name}}, {{company_name}}, {{job_title}} as personalization tokens
- Never use cliché openers like "I hope this email finds you well"
- Subject lines must be under 50 characters
- Return ONLY valid JSON, no other text

JSON schema:
{
  "touches": [
    {
      "touch_number": 1,
      "subject": "string",
      "body": "string",
      "personalization_fields": {"key": "value"},
      "send_delay_days": 0
    }
  ],
  "personalization_summary": "string",
  "news_signals_used": ["string"]
}`;

  const userPrompt = `Generate a personalized 3-touch cold email sequence for:

PROSPECT:
Name: ${fullName}
Email: ${prospect.email ?? "unknown"}
Company: ${companyName}

ENRICHMENT SIGNALS:
${enrichmentContext || "No enrichment data available"}

${newsContext}

${campaignContext ? `CAMPAIGN CONTEXT:\n${campaignContext}` : ""}

Return the JSON sequence now.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

// ── Helper: parse LLM JSON response ─────────────────────────────────────

function parseLLMSequence(raw: string): GeneratedSequence {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]+\}/);
    if (!jsonMatch) {
      throw new Error("LLM response did not contain parseable JSON");
    }
    parsed = JSON.parse(jsonMatch[0]);
  }

  const obj = parsed as Record<string, unknown>;
  if (!obj.touches || !Array.isArray(obj.touches) || obj.touches.length === 0) {
    throw new Error("LLM response missing touches array");
  }

  const touches: EmailTouch[] = (obj.touches as unknown[]).map((t, idx) => {
    const touch = t as Record<string, unknown>;
    return {
      touch_number: typeof touch.touch_number === "number" ? touch.touch_number : idx + 1,
      subject: typeof touch.subject === "string" ? touch.subject : `Follow-up ${idx + 1}`,
      body: typeof touch.body === "string" ? touch.body : "",
      personalization_fields:
        touch.personalization_fields &&
        typeof touch.personalization_fields === "object" &&
        !Array.isArray(touch.personalization_fields)
          ? (touch.personalization_fields as Record<string, string>)
          : {},
      send_delay_days:
        typeof touch.send_delay_days === "number" ? touch.send_delay_days : idx * 3,
    };
  });

  return {
    touches,
    personalization_summary:
      typeof obj.personalization_summary === "string" ? obj.personalization_summary : "",
    news_signals_used: Array.isArray(obj.news_signals_used)
      ? (obj.news_signals_used as string[])
      : [],
  };
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function handleGeneratePersonalizedSequence(
  ctx: HandlerContext,
  args: Args
): Promise<HandlerResult> {
  const prospectId = args.prospect_id as string | undefined;
  if (!prospectId || typeof prospectId !== "string") {
    return { status: 400, body: "Missing required argument: prospect_id (UUID string)" };
  }

  const campaignId = args.campaign_id as string | undefined;
  const campaignContext =
    typeof args.campaign_context === "string" ? args.campaign_context : null;

  // ── Step 1: Load prospect ───────────────────────────────────────────────
  const prospects = await ctx.db.query<ProspectRow>(
    `SELECT id, first_name, last_name, email, company_name, company_domain, linkedin_url
     FROM sdr_prospects
     WHERE id = $1`,
    prospectId
  );

  if (prospects.length === 0) {
    return { status: 404, body: `Prospect ${prospectId} not found` };
  }

  const prospect = prospects[0];

  // ── Step 2: Load enrichment data ─────────────────────────────────────
  const enrichments = await ctx.db.query<EnrichmentRow>(
    `SELECT job_title, seniority, departments, company_employee_count, company_industry,
            technographics, funding_stage, total_funding, hiring_signals
     FROM sdr_prospect_enrichments
     WHERE prospect_id = $1`,
    prospectId
  );

  const enrichment: EnrichmentRow | null = enrichments.length > 0 ? enrichments[0] : null;

  // ── Step 3: Fetch RAG news signals ──────────────────────────────────
  const newsSignals = await fetchCompanyNews(
    prospect.company_name ?? "",
    prospect.company_domain ?? null
  );

  // ── Step 4: Call LLM to generate sequence ───────────────────────────
  const messages = buildPrompt(prospect, enrichment, newsSignals, campaignContext);
  let rawLLMResponse: string;

  try {
    rawLLMResponse = await callLLMGateway(messages);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 502, body: `LLM gateway call failed: ${message}` };
  }

  // ── Step 5: Parse the generated sequence ────────────────────────────
  let sequence: GeneratedSequence;
  try {
    sequence = parseLLMSequence(rawLLMResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 422, body: `Failed to parse LLM sequence output: ${message}` };
  }

  if (sequence.touches.length < 3) {
    return {
      status: 422,
      body: `LLM returned only ${sequence.touches.length} touches; expected 3`,
    };
  }

  // ── Step 6: Persist sequence to DB ──────────────────────────────────
  const sequenceId = crypto.randomUUID();
  const now = new Date().toISOString();

  await ctx.db.execute(
    `INSERT INTO sdr_email_sequences (
       id, prospect_id, campaign_id,
       touches, personalization_summary, news_signals_used,
       generated_at, status
     ) VALUES (
       $1, $2, $3,
       $4::jsonb, $5, $6::jsonb,
       $7, 'draft'
     )
     ON CONFLICT (prospect_id) DO UPDATE SET
       campaign_id             = EXCLUDED.campaign_id,
       touches                 = EXCLUDED.touches,
       personalization_summary = EXCLUDED.personalization_summary,
       news_signals_used       = EXCLUDED.news_signals_used,
       generated_at            = EXCLUDED.generated_at,
       status                  = 'draft'`,
    sequenceId,
    prospectId,
    campaignId ?? null,
    JSON.stringify(sequence.touches),
    sequence.personalization_summary,
    JSON.stringify(sequence.news_signals_used),
    now
  );

  // Mark prospect sequence status
  await ctx.db.execute(
    `UPDATE sdr_prospects SET sequence_status = 'generated', updated_at = NOW() WHERE id = $1`,
    prospectId
  );

  return {
    status: 200,
    body: {
      sequence_id: sequenceId,
      prospect_id: prospectId,
      campaign_id: campaignId ?? null,
      touches_count: sequence.touches.length,
      touches: sequence.touches.map((t) => ({
        touch_number: t.touch_number,
        subject: t.subject,
        send_delay_days: t.send_delay_days,
        personalization_fields: t.personalization_fields,
      })),
      personalization_summary: sequence.personalization_summary,
      news_signals_used: sequence.news_signals_used,
      generated_at: now,
    },
  };
}
