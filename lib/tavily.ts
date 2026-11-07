import { config } from "@/lib/config";

const BASE_URL = "https://api.tavily.com";

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
}

export interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  images?: string[];
}

export interface TavilyExtractResult {
  url: string;
  raw_content: string;
  images?: string[];
}

async function tavilyFetch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!config.tavily.apiKey) {
    throw new Error("TAVILY_API_KEY is not configured");
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.tavily.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tavily ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export async function tavilySearch(
  query: string,
  opts: { maxResults?: number; includeImages?: boolean; searchDepth?: "basic" | "advanced" } = {}
): Promise<TavilySearchResponse> {
  return tavilyFetch<TavilySearchResponse>("/search", {
    query,
    max_results: opts.maxResults ?? 8,
    include_images: opts.includeImages ?? true,
    search_depth: opts.searchDepth ?? "basic",
    include_answer: false,
  });
}

export async function tavilyExtract(urls: string[]): Promise<TavilyExtractResult[]> {
  const res = await tavilyFetch<{ results: TavilyExtractResult[] }>("/extract", {
    urls,
    include_images: true,
  });
  return res.results ?? [];
}
