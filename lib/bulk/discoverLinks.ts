import type { PageSignals } from "@/lib/pageSignals";

const PRODUCT_PATH_WORDS = ["product", "products", "piece", "pieces", "pdp", "item", "collectible", "collectibles"];

// Store-plumbing pages that happen to share the same /products/<slug> URL
// shape but aren't actual design pieces — never worth discovering.
const NON_PRODUCT_SLUG_WORDS = [
  "gift-card", "giftcard", "gift-voucher", "voucher", "sample", "samples",
  "swatch", "swatches", "shipping", "delivery", "returns", "warranty",
];

function looksLikeSpecificSlug(segment: string | undefined): boolean {
  if (!segment) return false;
  return segment.split("-").filter(Boolean).length >= 2 || segment.length > 15;
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

/**
 * Best-effort scan of a collection/brand/gallery page's own links for
 * individual product detail pages — same-domain only (never follows a
 * collection page onto a different site), capped so one page can't explode
 * into an unbounded crawl. Returns [] when nothing product-shaped is found,
 * which is the normal, expected outcome for most brand homepages.
 */
export function discoverProductLinks(signals: PageSignals, limit = 8): string[] {
  const seen = new Set<string>();
  const found: string[] = [];

  for (const { href } of signals.links) {
    if (found.length >= limit) break;
    if (!sameHost(href, signals.finalUrl)) continue;
    if (seen.has(href)) continue;

    let segs: string[];
    try {
      segs = new URL(href).pathname.toLowerCase().split("/").filter(Boolean);
    } catch {
      continue;
    }
    const productIdx = segs.findIndex((s) => PRODUCT_PATH_WORDS.includes(s));
    if (productIdx === -1) continue;
    const last = segs[segs.length - 1];
    if (!looksLikeSpecificSlug(last) || last === segs[productIdx]) continue;
    if (NON_PRODUCT_SLUG_WORDS.some((w) => last.includes(w))) continue;

    seen.add(href);
    found.push(href);
  }

  return found;
}
