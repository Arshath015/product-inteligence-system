export const CATEGORY_SLUGS = [
  "sofas",
  "armchairs",
  "lounge-chairs",
  "dining-chairs",
  "desks",
  "tables",
  "dining-tables",
  "consoles",
  "coffee-tables",
  "side-tables",
  "beds",
  "lighting",
  "accessories",
  "rugs",
  "storage",
  "outdoor",
  "other",
] as const;

export type CategorySlug = (typeof CATEGORY_SLUGS)[number];

const CATEGORY_KEYWORDS: [CategorySlug, string[]][] = [
  ["sofas", ["sofa", "settee", "couch", "sectional", "divano", "divani", "canape", "canapes", "canapé", "canapés", "sofá", "sofás"]],
  ["armchairs", ["armchair", "accent chair", "easy chair"]],
  ["lounge-chairs", ["lounge chair", "recliner", "chaise"]],
  ["dining-chairs", ["dining chair", "chair"]],
  ["desks", ["desk", "writing desk", "secretary desk", "workstation"]],
  ["consoles", ["console", "entryway table", "hallway table", "entry table"]],
  ["dining-tables", ["dining table", "dinner table"]],
  ["coffee-tables", ["coffee table", "cocktail table", "low table"]],
  ["side-tables", ["side table", "end table", "nightstand", "accent table"]],
  ["tables", ["table"]],
  ["beds", ["bed", "headboard"]],
  ["lighting", ["lamp", "light", "lighting", "chandelier", "sconce", "pendant"]],
  ["rugs", ["rug", "carpet"]],
  ["storage", ["cabinet", "shelf", "shelving", "storage", "sideboard", "credenza", "bookcase"]],
  ["outdoor", ["outdoor", "patio", "garden"]],
  ["accessories", ["vase", "accessory", "decor", "mirror", "tray"]],
];

const PRODUCT_PATH_MARKERS = new Set([
  "product",
  "products",
  "prodotto",
  "prodotti",
  "produit",
  "produits",
  "producto",
  "productos",
  "produkt",
  "produkte",
]);

const LANGUAGE_SUFFIXES = new Set(["de", "en", "es", "fr", "it", "nl", "pt"]);

export function guessCategorySlug(text: string | null | undefined): CategorySlug {
  if (!text) return "other";
  const lower = text.toLowerCase();
  for (const [slug, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((keyword) => lower.includes(keyword))) return slug;
  }
  return "other";
}

export function categoryFromProductUrl(url: string | null | undefined): CategorySlug | null {
  if (!url) return null;

  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const productPathIndex = segments.findIndex((segment) =>
      PRODUCT_PATH_MARKERS.has(segment.toLowerCase()),
    );
    if (productPathIndex < 0) return null;

    const categoryPath = segments[productPathIndex + 1];
    if (!categoryPath) return null;

    const words = categoryPath.toLowerCase().split(/[-_]+/).filter(Boolean);
    if (words.includes("outdoor")) return "outdoor";
    if (words.some((word) => word === "and" || word === "or")) return null;
    while (words.length > 1 && LANGUAGE_SUFFIXES.has(words[words.length - 1])) words.pop();

    const category = guessCategorySlug(words.join(" "));
    return category === "other" ? null : category;
  } catch {
    return null;
  }
}

export function refineCategoryHint(
  primaryHint: CategorySlug,
  name: string,
  parts: (string | null | undefined)[],
): CategorySlug {
  if (primaryHint !== "other") return primaryHint;
  const fromName = guessCategorySlug(name);
  if (fromName !== "other") return fromName;
  return guessCategorySlug(parts.filter(Boolean).join(" "));
}
