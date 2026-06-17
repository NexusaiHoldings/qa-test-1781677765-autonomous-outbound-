/**
 * Company news fetcher for prospect research and email personalization context.
 * Fetches recent news about a prospect's company using NewsAPI (when configured)
 * or Google News RSS as a fallback. Returns structured snippets for RAG-based
 * personalization hooks in outbound email sequences.
 */

export interface NewsSnippet {
  title: string;
  url: string;
  source: string;
  published_at: string;
  summary: string;
}

function truncateSummary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function parseIsoDate(dateStr: string | undefined): string {
  if (!dateStr) return new Date().toISOString();
  try {
    return new Date(dateStr).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function parseRssXml(xml: string, maxItems: number): NewsSnippet[] {
  const items: NewsSnippet[] = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

  for (const match of itemMatches) {
    if (items.length >= maxItems) break;
    const block = match[1];

    const titleMatch =
      block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s) ??
      block.match(/<title>(.*?)<\/title>/s);
    const linkMatch =
      block.match(/<link>(.*?)<\/link>/s) ??
      block.match(/<link[^>]+href="([^"]+)"/);
    const pubDateMatch = block.match(/<pubDate>(.*?)<\/pubDate>/s);
    const descMatch =
      block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/s) ??
      block.match(/<description>(.*?)<\/description>/s);
    const sourceMatch = block.match(/<source[^>]*>(.*?)<\/source>/s);

    const title = titleMatch?.[1]?.trim() ?? "Untitled";
    const url = linkMatch?.[1]?.trim() ?? "";
    const publishedAt = parseIsoDate(pubDateMatch?.[1]?.trim());
    const rawDesc = (descMatch?.[1]?.trim() ?? "").replace(/<[^>]+>/g, "");
    const summary = truncateSummary(rawDesc || title, 280);
    const source = sourceMatch?.[1]?.trim() ?? "Google News";

    if (title && url) {
      items.push({ title, url, source, published_at: publishedAt, summary });
    }
  }

  return items;
}

async function fetchFromNewsApi(
  query: string,
  maxArticles: number
): Promise<NewsSnippet[]> {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return [];

  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", String(Math.min(maxArticles, 20)));
  url.searchParams.set("apiKey", apiKey);

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": "NexusSDR/1.0" },
  });

  if (!response.ok) return [];

  const data = (await response.json()) as {
    articles?: Array<{
      title?: string;
      url?: string;
      source?: { name?: string };
      publishedAt?: string;
      description?: string;
    }>;
  };

  return (data.articles ?? []).slice(0, maxArticles).map((article) => ({
    title: article.title ?? "Untitled",
    url: article.url ?? "",
    source: article.source?.name ?? "NewsAPI",
    published_at: parseIsoDate(article.publishedAt),
    summary: truncateSummary(article.description ?? article.title ?? "", 280),
  }));
}

async function fetchFromGoogleNewsRss(
  companyName: string,
  maxArticles: number
): Promise<NewsSnippet[]> {
  const query = encodeURIComponent(
    `"${companyName}" funding OR hiring OR acquisition OR launch`
  );
  const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

  const response = await fetch(rssUrl, {
    headers: { "User-Agent": "NexusSDR/1.0" },
  });

  if (!response.ok) return [];

  const xml = await response.text();
  return parseRssXml(xml, maxArticles);
}

export async function fetchCompanyNews(
  companyName: string,
  domain: string,
  maxArticles = 5
): Promise<NewsSnippet[]> {
  if (process.env.NEWS_API_KEY) {
    const query = `"${companyName}" OR site:${domain}`;
    const results = await fetchFromNewsApi(query, maxArticles).catch(() => []);
    if (results.length > 0) return results;
  }
  return fetchFromGoogleNewsRss(companyName, maxArticles).catch(() => []);
}

export async function fetchFundingNews(
  companyName: string,
  maxArticles = 3
): Promise<NewsSnippet[]> {
  const query = `"${companyName}" funding OR "Series A" OR "Series B" OR raised OR investment`;

  if (process.env.NEWS_API_KEY) {
    const results = await fetchFromNewsApi(query, maxArticles).catch(() => []);
    if (results.length > 0) return results;
  }

  const encodedQuery = encodeURIComponent(query);
  const rssUrl = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetch(rssUrl, {
    headers: { "User-Agent": "NexusSDR/1.0" },
  }).catch(() => null);

  if (!response?.ok) return [];
  const xml = await response.text();
  return parseRssXml(xml, maxArticles);
}
