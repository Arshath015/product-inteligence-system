import * as cheerio from "cheerio";
import { tavilyExtract } from "@/lib/tavily";

export interface InspirationExtraction {
  title: string | null;
  description: string | null;
  caption: string | null;
  imageUrls: string[];
  canonicalUrl: string;
  limited: boolean; // true when the source blocked/limited extraction and we fell back
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
};

function absolutize(url: string, base: string): string | null {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

/**
 * Best-effort metadata extraction for Pinterest/Instagram/other inspiration
 * links. Reads only publicly server-rendered Open Graph tags — never
 * attempts to log in or bypass any access control. If a platform blocks
 * the request or renders nothing useful server-side, falls back to Tavily
 * extract, and ultimately to just saving the bare URL (`limited: true`).
 */
export async function extractInspirationMeta(url: string): Promise<InspirationExtraction> {
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
    const finalUrl = res.url || url;
    if (!res.ok) throw new Error(`status ${res.status}`);

    const html = await res.text();
    const $ = cheerio.load(html);

    const title =
      $('meta[property="og:title"]').attr("content")?.trim() || $("title").first().text().trim() || null;
    const description =
      $('meta[property="og:description"]').attr("content")?.trim() ||
      $('meta[name="description"]').attr("content")?.trim() ||
      null;
    const canonicalRaw = $('link[rel="canonical"]').attr("href");
    const canonicalUrl = (canonicalRaw ? absolutize(canonicalRaw, finalUrl) : null) ?? finalUrl;

    const imageUrls: string[] = [];
    $('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]').each(
      (_, el) => {
        const content = $(el).attr("content");
        const abs = content ? absolutize(content, finalUrl) : null;
        if (abs) imageUrls.push(abs);
      }
    );

    if (!title && !description && imageUrls.length === 0) {
      throw new Error("no usable metadata on page (likely login-gated)");
    }

    return {
      title,
      description,
      caption: description,
      imageUrls: Array.from(new Set(imageUrls)),
      canonicalUrl,
      limited: false,
    };
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
