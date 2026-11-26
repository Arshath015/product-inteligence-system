/** Path segments that mark an individual product detail page. Multilingual. */
export const PRODUCT_WORD_SET = new Set([
  "product", "products", "piece", "pieces", "pdp", "item", "items",
  "collectible", "collectibles",
  "prodotto", "prodotti",
  "produit", "produits",
  "produkt", "produkte",
  "producto", "productos",
]);

/** Path segments typical of collection / category listing pages. Multilingual. */
export const COLLECTION_WORD_SET = new Set([
  "collection", "collections", "category", "categories", "catalogue", "catalog",
  "range", "ranges", "series", "line", "lines", "furniture",
  "seating", "sofas", "sofa", "chairs", "chair", "armchair", "armchairs", "lamp", "lamps",
  "tables", "table", "beds", "bed", "storage", "bedroom", "living",
  "dining", "outdoor", "accessories", "lighting", "wardrobes", "wardrobe",
  "shelving", "shelves", "desks", "desk", "cabinets", "cabinet",
  "collezione", "collezioni", "arredamento", "divani", "poltrone",
  "tavoli", "tavolini", "letti", "armadi", "complementi", "sedute", "sedie", "librerie",
  "madie", "comodini", "cabine", "sistemi", "contenitori", "prodotti_categorie",
  "product_category", "product-category",
  "mobilier", "meubles", "canapes", "fauteuils",
  "kollektion", "kollektionen", "moebel",
  "coleccion", "colecciones", "muebles",
]);

const SKIP_SET = new Set([
  "gift-card", "giftcard", "voucher", "sample", "swatch",
  "shipping", "delivery", "returns", "warranty",
  "about", "contact", "press", "news", "blog", "career", "careers", "jobs",
  "privacy", "cookies", "terms", "login", "register", "account",
  "wishlist", "checkout", "cart", "search", "404", "sitemap",
  "dealers", "dealer", "stores", "store-locator", "find-a-store",
  "faq", "help", "support", "newsletter", "sustainability", "company",
]);
const SKIP_PREFIXES = ["notice-", "spare-parts", "about-", "contact-", "terms-", "privacy-", "faq-"];
const CATEGORY_ROUTE_PREFIXES = ["clp-", "category-", "collection-"];
export function pathSegs(url: string): string[] {
  try { return new URL(url).pathname.toLowerCase().split("/").filter(Boolean); } catch { return []; }
}

export function normalizedSegs(url: string): string[] {
  return pathSegs(url).map((segment) => segment.replace(/\.(?:html?|php)$/i, ""));
}

export function isSkippedSegment(segment: string): boolean {
  const route = segment.startsWith("clp-") ? segment.slice(4) : segment;
  return SKIP_SET.has(route) || SKIP_PREFIXES.some((prefix) => route.startsWith(prefix));
}

export function isCategoryRoute(segment: string | undefined): boolean {
  return Boolean(segment && CATEGORY_ROUTE_PREFIXES.some((prefix) => segment.startsWith(prefix)));
}

function isCollectionSlug(segment: string): boolean {
  if (COLLECTION_WORD_SET.has(segment)) return true;
  const withoutLocale = segment.replace(/-(?:[a-z]{2}(?:-[a-z]{2})?)$/i, "");
  if (COLLECTION_WORD_SET.has(withoutLocale)) return true;
  const words = segment.split(/[-_]+/);
  return words.some((word) => COLLECTION_WORD_SET.has(word) && word.length > 3 && word.endsWith("s"))
    || (words.some((word) => word === "collection" || word === "category")
      && words.some((word) => COLLECTION_WORD_SET.has(word)));
}

/** Returns true for a deep product slug under a collection hierarchy. */
export function isDeepProductUrl(segs: string[]): boolean {
  const normalized = segs.map((segment) => segment.replace(/\.(?:html?|php)$/i, ""));
  const collIdx = normalized.findIndex((s) => COLLECTION_WORD_SET.has(s));
  if (collIdx === -1) return false;
  const afterColl = normalized.slice(collIdx + 1);
  if (afterColl.length < 2) return false;
  const slug = afterColl[afterColl.length - 1];
  return (
    slug.includes("-") &&
    slug.length > 8 &&
    !COLLECTION_WORD_SET.has(slug) &&
    !isSkippedSegment(slug)
  );
}

/**
 * Returns true when a URL looks like an individual product page rather than a
 * category root. This distinguishes /products/sofas-en/ from
 * /products/sofas-en/daily/.
 */
export function isProductPageUrl(url: string): boolean {
  try {
    const segs = pathSegs(url);
    if (segs.length === 0) return false;
    const normalized = normalizedSegs(url);
    if (normalized.some(isSkippedSegment)) return false;
    const productIdx = normalized.findIndex((s) => PRODUCT_WORD_SET.has(s));
    if (productIdx !== -1 && productIdx < segs.length - 1) {
      const afterProductMarker = normalized.slice(productIdx + 1);
      if (afterProductMarker.length === 1 && isCollectionSlug(afterProductMarker[0])) return false;
      return true;
    }
    if (isDeepProductUrl(normalized)) return true;
    const leaf = normalized[normalized.length - 1];
    const hasCollectionParent = normalized.slice(0, -1).some((segment) => COLLECTION_WORD_SET.has(segment));
    return !hasCollectionParent &&
      !isCategoryRoute(leaf) &&
      /\.(?:html?|php)$/i.test(segs[segs.length - 1]) &&
      leaf.split("-").filter(Boolean).length >= 3 &&
      !COLLECTION_WORD_SET.has(leaf) &&
      !isSkippedSegment(leaf);
  } catch {
    return false;
  }
}

export function isCollectionPathSegment(segment: string): boolean {
  return isCollectionSlug(segment);
}
