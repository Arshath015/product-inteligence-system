import type { PageSignals } from "@/lib/pageSignals";

export type ContentKind =
  | "pinterest"
  | "instagram"
  | "product"
  | "collection"
  | "brand"
  | "gallery"
  | "artisan_profile"
  | "artisan_directory"
  | "general";

const ARTISAN_PATH_WORDS = [
  "artisan", "artisans", "artigiani", "artigiano", "ateliers", "atelier",
  "mestieri", "kunsthandwerk", "craftspeople", "craftsman", "shipwright",
];
const DIRECTORY_PATH_WORDS = ["mitglieder", "members", "repertoire", "directory", "objects", "network", "annuaire"];
const COLLECTION_PATH_WORDS = [
  "collections", "collection", "product-category", "categories", "category",
  "artworks", "collectibles", "catalogue", "catalog", "all-current",
];
const PRODUCT_PATH_WORDS = ["product", "products", "piece", "pieces", "pdp", "item"];

function looksLikeSpecificSlug(segment: string | undefined): boolean {
  if (!segment) return false;
  return segment.split("-").filter(Boolean).length >= 3 || segment.length > 20;
}

/** Deterministic, no-fetch classification from the URL's domain/path shape alone. */
export function classifyFromPath(url: string): ContentKind | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "pinterest.com" || host.endsWith(".pinterest.com") || host === "pin.it") return "pinterest";
  if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") return "instagram";

  const segs = u.pathname.toLowerCase().split("/").filter(Boolean);
  const hasQuery = u.search.length > 0;

  const artisanIdx = segs.findIndex((s) => ARTISAN_PATH_WORDS.includes(s));
  if (artisanIdx !== -1) {
    const last = segs[segs.length - 1];
    return looksLikeSpecificSlug(last) ? "artisan_profile" : "artisan_directory";
  }
  if (segs.some((s) => DIRECTORY_PATH_WORDS.some((w) => s.includes(w))) || (hasQuery && segs.length <= 2)) {
    return "artisan_directory";
  }
  if (segs.some((s) => COLLECTION_PATH_WORDS.some((w) => s === w || s.includes(w)))) {
    return "collection";
  }
  const productIdx = segs.findIndex((s) => PRODUCT_PATH_WORDS.includes(s));
  if (productIdx !== -1) {
    const last = segs[segs.length - 1];
    return looksLikeSpecificSlug(last) ? "product" : "collection";
  }
  if (segs.length === 0) return null; // homepage — ambiguous, needs page signals
  // A single long hyphenated slug directly off root reads as a product detail page.
  if (segs.length === 1 && looksLikeSpecificSlug(segs[0])) return "product";
  return null; // inconclusive from the URL shape alone
}

const ARTISAN_KEYWORDS = [
  "artisan", "atelier", "craftsman", "craftsperson", "workshop",
  "métiers d'art", "metiers d'art", "mestieri d'arte", "kunsthandwerk", "shipwright", "savoir-faire",
];
const GALLERY_KEYWORDS = ["gallery", "galleries", "curated", "exhibition", "design fair"];

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

/**
 * Classifies a URL. Tries the deterministic path heuristic first (handles
 * the large majority with zero network cost); falls back to the already-
 * fetched page signals (JSON-LD type, keyword density, internal link
 * fan-out) only when the path shape alone is ambiguous — e.g. a bare
 * homepage. No LLM call anywhere in this function.
 */
export function classifyFromSignals(url: string, signals: PageSignals | null): ContentKind {
  const fromPath = classifyFromPath(url);
  if (fromPath) return fromPath;
  if (!signals) return "general";

  if (signals.jsonLdTypes.includes("Product")) return "product";
  if (signals.jsonLdTypes.includes("Person")) return "artisan_profile";
  if (signals.jsonLdTypes.some((t) => ["CollectionPage", "ItemList", "OfferCatalog"].includes(t))) return "collection";

  const text = `${signals.title ?? ""} ${signals.metaDescription ?? ""} ${signals.textSnippet.slice(0, 1200)}`.toLowerCase();
  const artisanHits = ARTISAN_KEYWORDS.filter((w) => text.includes(w)).length;
  if (artisanHits >= 2) {
    const sameHostLinks = signals.links.filter((l) => sameHost(l.href, signals.finalUrl));
    const distinctPaths = new Set(
      sameHostLinks.map((l) => {
        try {
          return new URL(l.href).pathname;
        } catch {
          return l.href;
        }
      })
    );
    return distinctPaths.size > 15 ? "artisan_directory" : "artisan_profile";
  }

  const urlSegs = (() => {
    try {
      return new URL(signals.finalUrl).pathname.split("/").filter(Boolean);
    } catch {
      return [];
    }
  })();
  if (urlSegs.length === 0) {
    const galleryHits = GALLERY_KEYWORDS.filter((w) => text.includes(w)).length;
    return galleryHits > 0 ? "gallery" : "brand";
  }

  if (/add to (cart|bag)|buy now|in stock|price/i.test(text) && signals.title) return "product";

  return "general";
}
