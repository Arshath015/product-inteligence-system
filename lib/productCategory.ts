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

const CATEGORY_KEYWORD_ENTRIES = CATEGORY_KEYWORDS
  .flatMap(([slug, keywords]) => keywords.map((keyword) => ({ slug, keyword })))
  .sort((a, b) => b.keyword.length - a.keyword.length);
const COMPARATIVE_CATEGORY_PATTERN = new RegExp(
  `\\b(?:like|unlike|similar\\s+to|compared\\s+(?:to|with)|reminiscent\\s+of|inspired\\s+by)\\s+(?:(?:the|a|an)\\s+)?(${CATEGORY_KEYWORD_ENTRIES.map(({ keyword }) => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=$|[^a-z0-9])`,
  "gi",
);

function stripComparativeCategoryMentions(text: string): {
  text: string;
  referencedCategories: Set<CategorySlug>;
} {
  const referencedCategories = new Set<CategorySlug>();
  const cleanedText = text.replace(COMPARATIVE_CATEGORY_PATTERN, (_match, keyword: string) => {
    const category = CATEGORY_KEYWORD_ENTRIES.find((entry) => entry.keyword === keyword.toLowerCase())?.slug;
    if (category) referencedCategories.add(category);
    return " ";
  });
  return { text: cleanedText, referencedCategories };
}

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

const TABLE_WORDS = new Set(["table", "tables", "tavolo", "tavoli", "tisch", "tische", "mesa", "mesas"]);
const CHAIR_WORDS = new Set([
  "chair", "chairs", "sedia", "sedie", "stuhl", "stuhle", "stühle", "chaise", "chaises", "silla", "sillas",
]);
const LANGUAGE_SUFFIXES = new Set(["de", "en", "es", "fr", "it", "nl", "pt"]);

function isMixedTableChairProductUrl(url: string): boolean {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const productPathIndex = segments.findIndex((segment) =>
      PRODUCT_PATH_MARKERS.has(segment.toLowerCase()),
    );
    if (productPathIndex < 0) return false;
    const categoryPath = segments[productPathIndex + 1];
    if (!categoryPath) return false;
    const words = categoryPath.toLowerCase().split(/[-_]+/).filter(Boolean);
    return words.some((word) => TABLE_WORDS.has(word)) && words.some((word) => CHAIR_WORDS.has(word));
  } catch {
    return false;
  }
}

export function guessCategorySlug(text: string | null | undefined): CategorySlug {
  if (!text) return "other";
  const lower = stripComparativeCategoryMentions(text.toLowerCase()).text;
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
  const context = [name, ...parts.filter(Boolean)]
    .join(" ")
    .replace(/https?:\/\/[^\s"'<>]+/gi, " ");
  const { text: contextWithoutComparisons, referencedCategories } =
    stripComparativeCategoryMentions(context);
  const mixedTableChairRoute = parts.some((part) => {
    const url = part?.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
    return url ? isMixedTableChairProductUrl(url) : false;
  });
  if (primaryHint !== "other") {
    if (referencedCategories.has(primaryHint)) {
      const contextualCategory = guessCategorySlug(contextWithoutComparisons);
      if (contextualCategory !== "other" && contextualCategory !== primaryHint) {
        return contextualCategory;
      }
    }
    if (primaryHint === "armchairs" && mixedTableChairRoute) return "other";
    return primaryHint;
  }

  const fromName = guessCategorySlug(name);
  if (fromName !== "other") return fromName;

  for (const part of parts) {
    const url = part?.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
    if (!url) continue;
    const fromUrl = categoryFromProductUrl(url);
    if (fromUrl) return fromUrl;
  }

  const contextualCategory = guessCategorySlug(contextWithoutComparisons);
  return mixedTableChairRoute && contextualCategory === "armchairs" ? "other" : contextualCategory;
}
