import { fetchPageSignals, type PageSignals } from "@/lib/pageSignals";
import { tavilyExtract } from "@/lib/tavily";

export interface InspirationExtraction {
  title: string | null;
  description: string | null;
  caption: string | null;
  imageUrls: string[];
  canonicalUrl: string;
  limited: boolean; // true when the source blocked/limited extraction and we fell back
}

function fromSignals(url: string, signals: PageSignals): InspirationExtraction | null {
  if (!signals.title && !signals.metaDescription && signals.ogImages.length === 0) return null;
  return {
    title: signals.title,
    description: signals.metaDescription,
    caption: signals.metaDescription,
    imageUrls: Array.from(new Set(signals.ogImages)),
    canonicalUrl: signals.canonicalUrl ?? signals.finalUrl ?? url,
    limited: false,
  };
}

/**
 * Best-effort metadata extraction for Pinterest/Instagram/other inspiration
 * links. Reads only publicly server-rendered Open Graph tags — never
 * attempts to log in or bypass any access control. If a platform blocks
 * the request or renders nothing useful server-side, falls back to Tavily
 * extract, and ultimately to just saving the bare URL (`limited: true`).
 *
 * `preloaded` lets a caller that already fetched the page (the bulk
 * ingest pipeline) hand over the signals instead of fetching twice.
 */
export async function extractInspirationMeta(
  url: string,
  preloaded?: PageSignals | null
): Promise<InspirationExtraction> {
  try {
    const signals = preloaded ?? (await fetchPageSignals(url));
    const result = fromSignals(url, signals);
    if (result) return result;
    throw new Error("no usable metadata on page (likely login-gated)");
  } catch {
    const [extracted] = await tavilyExtract([url]).catch(() => []);
    if (extracted && (extracted.raw_content || (extracted.images && extracted.images.length))) {
      return {
        title: null,
        description: extracted.raw_content?.slice(0, 500) ?? null,
        caption: null,
        imageUrls: extracted.images ?? [],
        canonicalUrl: url,
        limited: true,
      };
    }
    return { title: null, description: null, caption: null, imageUrls: [], canonicalUrl: url, limited: true };
  }
}
