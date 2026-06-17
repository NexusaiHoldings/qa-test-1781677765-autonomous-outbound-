/**
 * Reply classifier for SDR inbound email detection.
 *
 * Calls OpenAI via raw fetch (no SDK — openai npm package is banned in
 * company apps). Uses gpt-5.4-mini to categorise each reply into one of four
 * classes, and generates coaching context for genuine-interest replies so the
 * founder knows exactly how to respond.
 */

export type ReplyCategory =
  | "genuine_interest"
  | "ooo"
  | "unsubscribe"
  | "objection";

export interface EmailInput {
  subject: string;
  body: string;
  from_email: string;
  from_name?: string;
}

export interface ClassificationResult {
  category: ReplyCategory;
  confidence: number;
  summary: string;
  /** Non-null only when category === "genuine_interest" */
  coaching_context: string | null;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
}

async function callChatCompletion(messages: OpenAIMessage[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages,
      temperature: 0.1,
      max_tokens: 600,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenAI API error (${response.status}): ${detail.slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as OpenAIResponse;
  return data.choices[0]?.message?.content ?? "";
}

function fallbackCategory(body: string, subject: string): ReplyCategory {
  const text = `${subject} ${body}`.toLowerCase();
  if (
    text.includes("unsubscribe") ||
    text.includes("remove me") ||
    text.includes("stop emailing") ||
    text.includes("opt out") ||
    text.includes("opt-out")
  ) {
    return "unsubscribe";
  }
  if (
    text.includes("out of office") ||
    text.includes("out-of-office") ||
    text.includes("auto-reply") ||
    text.includes("automatic reply") ||
    text.includes("on vacation") ||
    text.includes("on leave") ||
    text.includes("will be back")
  ) {
    return "ooo";
  }
  if (
    text.includes("interested") ||
    text.includes("tell me more") ||
    text.includes("schedule") ||
    text.includes("call") ||
    text.includes("demo") ||
    text.includes("pricing") ||
    text.includes("learn more")
  ) {
    return "genuine_interest";
  }
  return "objection";
}

const SYSTEM_PROMPT = `You are an email classifier for a B2B sales development representative (SDR) system.
Classify the following inbound reply into exactly one of these categories:

- genuine_interest: The prospect expresses real curiosity, wants to learn more, asks about pricing/features, or wants to schedule a call or demo.
- ooo: An out-of-office, vacation, or any fully automated/auto-generated reply with no human intent.
- unsubscribe: The prospect explicitly asks to stop receiving emails, unsubscribe, or be removed from the list.
- objection: A human reply expressing disinterest, wrong timing, already have a solution, budget constraints, or any other negative but human response.

Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "category": "<genuine_interest|ooo|unsubscribe|objection>",
  "confidence": <float 0.0–1.0>,
  "summary": "<one-sentence explanation of why this category was chosen>",
  "coaching_context": "<for genuine_interest only: 2–3 sentences of actionable coaching for the founder on how best to respond to this specific email. For all other categories return null.>"
}`;

export async function classifyReply(
  email: EmailInput,
): Promise<ClassificationResult> {
  const userContent = [
    `From: ${email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email}`,
    `Subject: ${email.subject}`,
    "",
    email.body.slice(0, 2000),
  ].join("\n");

  let raw = "";
  try {
    raw = await callChatCompletion([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ]);
  } catch (err) {
    console.error("[reply-classifier] OpenAI call failed, using heuristic:", err);
    const category = fallbackCategory(email.body, email.subject);
    return {
      category,
      confidence: 0.4,
      summary: "Classified via heuristic fallback (AI unavailable)",
      coaching_context: null,
    };
  }

  let parsed: {
    category?: string;
    confidence?: number;
    summary?: string;
    coaching_context?: string | null;
  };

  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    console.warn("[reply-classifier] JSON parse failed, raw:", raw.slice(0, 200));
    const category = fallbackCategory(email.body, email.subject);
    return {
      category,
      confidence: 0.4,
      summary: "Classified via heuristic fallback (malformed AI response)",
      coaching_context: null,
    };
  }

  const validCategories: ReplyCategory[] = [
    "genuine_interest",
    "ooo",
    "unsubscribe",
    "objection",
  ];
  const category: ReplyCategory = validCategories.includes(
    parsed.category as ReplyCategory,
  )
    ? (parsed.category as ReplyCategory)
    : fallbackCategory(email.body, email.subject);

  const confidence = Math.min(1, Math.max(0, parsed.confidence ?? 0.5));

  return {
    category,
    confidence,
    summary: parsed.summary ?? "",
    coaching_context:
      category === "genuine_interest" ? (parsed.coaching_context ?? null) : null,
  };
}
