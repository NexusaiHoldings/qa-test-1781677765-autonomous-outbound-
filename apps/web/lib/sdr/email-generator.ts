/**
 * GPT-4o Personalized Email Sequence Generator
 *
 * Ingests structured prospect data (role, company news, technographics from
 * Apollo) and generates a 3-touch cold email sequence with dynamic
 * personalization fields. Each email references a specific prospect signal
 * (funding round, new hire, product launch) to differentiate from generic
 * mail-merge tools.
 *
 * Calls GPT via a gateway proxy (OPENAI_BASE_URL env var) — never imports
 * the openai SDK directly (banned in company apps per substrate policy).
 */

export interface ProspectData {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
  company: string;
  companyDomain?: string;
  recentFunding?: string;
  recentHires?: string;
  techStack?: string[];
  industry?: string;
  linkedinUrl?: string;
  customSignal?: string;
}

export interface EmailDraft {
  touchNumber: 1 | 2 | 3;
  subject: string;
  body: string;
  personalizationField: string;
  signal: string;
}

export interface EmailSequence {
  prospectId: string;
  campaignId: string;
  emails: [EmailDraft, EmailDraft, EmailDraft];
  generatedAt: string;
}

interface LLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface NewsApiResponse {
  articles?: Array<{ title?: string; description?: string }>;
}

interface ParsedEmailDraft {
  subject?: string;
  body?: string;
  personalizationField?: string;
}

async function fetchProspectSignal(prospect: ProspectData): Promise<string> {
  const fallback =
    prospect.recentFunding ??
    prospect.recentHires ??
    prospect.customSignal ??
    `${prospect.company} expanding their ${prospect.industry ?? "B2B"} footprint`;

  const newsApiKey = process.env.NEWS_API_KEY;
  if (!newsApiKey || !prospect.companyDomain) {
    return fallback;
  }

  try {
    const query = encodeURIComponent(prospect.company);
    const url =
      `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=1&apiKey=${newsApiKey}`;
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return fallback;
    const data = (await res.json()) as NewsApiResponse;
    const title = data.articles?.[0]?.title;
    return title ?? fallback;
  } catch {
    return fallback;
  }
}

async function callLLM(prompt: string): Promise<string> {
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an expert SDR who writes highly personalized, signal-based cold emails. " +
            "Your emails are concise (3-4 short paragraphs), specific, and always reference a real prospect " +
            "signal to stand out from generic mail-merge tools like Instantly.ai. " +
            "Always respond with valid JSON only — no markdown fences.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 600,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM API error ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as LLMResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from LLM");
  return content.trim();
}

async function generateEmail(
  prospect: ProspectData,
  touchNumber: 1 | 2 | 3,
  signal: string,
  previousEmails: EmailDraft[],
): Promise<EmailDraft> {
  const touchGuides: Record<number, string> = {
    1: "initial outreach — hook with the prospect signal in the first sentence",
    2: "first follow-up (send 3–5 days after touch 1) — add a different angle of value, briefly reference the signal",
    3: "second follow-up (send 7–10 days after touch 1) — low-friction CTA, break-up framing",
  };

  const prevContext =
    previousEmails.length > 0
      ? "\n\nPrevious touches already sent:\n" +
        previousEmails
          .map(
            (e, idx) =>
              `Touch ${idx + 1}:\n  Subject: "${e.subject}"\n  Body: ${e.body}`,
          )
          .join("\n\n")
      : "";

  const techLine =
    prospect.techStack && prospect.techStack.length > 0
      ? `Tech stack: ${prospect.techStack.join(", ")}`
      : "";

  const prompt =
    `Write a ${touchGuides[touchNumber]} cold email for this prospect:\n\n` +
    `Name: ${prospect.firstName} ${prospect.lastName}\n` +
    `Role: ${prospect.role}\n` +
    `Company: ${prospect.company}\n` +
    (techLine ? `${techLine}\n` : "") +
    `Industry: ${prospect.industry ?? "B2B SaaS"}\n` +
    `Prospect signal (reference this specifically): ${signal}` +
    prevContext +
    "\n\nRequirements:\n" +
    "- Opening line must directly reference the specific signal\n" +
    "- 3–4 short paragraphs, no fluff, no generic openers\n" +
    "- Clear, low-friction CTA\n" +
    "- Use merge tags: {{FIRST_NAME}}, {{COMPANY}}, {{SENDER_NAME}}, {{SENDER_COMPANY}}\n" +
    "- Respond with ONLY a JSON object, no markdown:\n" +
    '{"subject":"...","body":"...","personalizationField":"the exact signal or fact referenced"}';

  const raw = await callLLM(prompt);

  let jsonStr = raw;
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1];
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error(`Could not parse LLM JSON: ${raw.slice(0, 200)}`);

  const parsed = JSON.parse(objMatch[0]) as ParsedEmailDraft;

  return {
    touchNumber,
    subject: parsed.subject ?? `${prospect.firstName}, quick question about ${prospect.company}`,
    body: parsed.body ?? raw,
    personalizationField: parsed.personalizationField ?? signal,
    signal,
  };
}

export async function generateEmailSequence(
  prospect: ProspectData,
  campaignId: string,
): Promise<EmailSequence> {
  const signal = await fetchProspectSignal(prospect);

  const touch1 = await generateEmail(prospect, 1, signal, []);
  const touch2 = await generateEmail(prospect, 2, signal, [touch1]);
  const touch3 = await generateEmail(prospect, 3, signal, [touch1, touch2]);

  return {
    prospectId: prospect.id,
    campaignId,
    emails: [touch1, touch2, touch3],
    generatedAt: new Date().toISOString(),
  };
}
