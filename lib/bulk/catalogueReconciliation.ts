export interface ReconciliationProduct {
  id: string;
  brand_id: string;
  name: string;
  category_name: string | null;
  source_url: string;
  images: unknown;
  primary_image_url?: string | null;
  duplicate_of_id?: string | null;
}

export interface CategoryCorrection {
  id: string;
  name: string;
  sourceUrl: string;
  currentCategory: string | null;
  proposedCategory: string;
}

export interface DuplicateCandidate {
  id: string;
  brandId: string;
  name: string;
  category: string;
  productIds: string[];
  products: Array<Pick<ReconciliationProduct, "id" | "name" | "category_name" | "source_url">>;
}

export interface CatalogueReconciliationPreview {
  categoryCorrections: CategoryCorrection[];
  duplicateCandidates: DuplicateCandidate[];
}

function normalizedName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function productPathSlug(sourceUrl: string): string | null {
  try {
    const segments = new URL(sourceUrl).pathname.split("/").filter(Boolean);
    return segments.at(-1)?.toLocaleLowerCase() ?? null;
  } catch {
    return null;
  }
}

function productImagePaths(product: ReconciliationProduct): Set<string> {
  const rawImages = Array.isArray(product.images) ? product.images : [];
  const imageUrls = [
    ...(product.primary_image_url ? [product.primary_image_url] : []),
    ...rawImages.map((image) => {
      if (typeof image === "string") return image;
      if (image && typeof image === "object" && "url" in image && typeof image.url === "string") {
        return image.url;
      }
      return null;
    }).filter((url): url is string => url !== null),
  ];

  return new Set(imageUrls.flatMap((imageUrl) => {
    try {
      const path = new URL(imageUrl).pathname.toLocaleLowerCase();
      const fileName = path.split("/").at(-1) ?? "";
      if (!fileName || /^(logo|placeholder|ditre-italia-1)\b/i.test(fileName)) return [];
      return [path];
    } catch {
      return [];
    }
  }));
}

function hasStrongImageOverlap(left: ReconciliationProduct, right: ReconciliationProduct): boolean {
  const leftImages = productImagePaths(left);
  const rightImages = productImagePaths(right);
  let sharedImages = 0;
  for (const image of leftImages) {
    if (rightImages.has(image) && ++sharedImages >= 3) return true;
  }
  return false;
}

function duplicateComponents(
  products: ReconciliationProduct[],
  resolveCategory: (url: string) => string | null,
): ReconciliationProduct[][] {
  const buckets = new Map<string, ReconciliationProduct[]>();
  for (const product of products) {
    if (product.duplicate_of_id) continue;
    const category = resolveCategory(product.source_url);
    const slug = productPathSlug(product.source_url);
    if (!category || !slug || !normalizedName(product.name)) continue;
    const key = [product.brand_id, normalizedName(product.name), category, slug].join("\u0000");
    const bucket = buckets.get(key) ?? [];
    bucket.push(product);
    buckets.set(key, bucket);
  }

  const components: ReconciliationProduct[][] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const parents = bucket.map((_, index) => index);
    const find = (index: number): number => {
      if (parents[index] !== index) parents[index] = find(parents[index]);
      return parents[index];
    };
    const union = (left: number, right: number) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
    };

    for (let left = 0; left < bucket.length; left++) {
      for (let right = left + 1; right < bucket.length; right++) {
        if (hasStrongImageOverlap(bucket[left], bucket[right])) union(left, right);
      }
    }

    const groups = new Map<number, ReconciliationProduct[]>();
    bucket.forEach((product, index) => {
      const root = find(index);
      const group = groups.get(root) ?? [];
      group.push(product);
      groups.set(root, group);
    });
    components.push(...[...groups.values()].filter((group) => group.length > 1));
  }
  return components;
}

export function buildCatalogueReconciliationPreview(
  products: ReconciliationProduct[],
  resolveCategory: (url: string) => string | null,
): CatalogueReconciliationPreview {
  const activeProducts = products.filter((product) => !product.duplicate_of_id);
  const categoryCorrections = activeProducts.flatMap((product) => {
    const proposedCategory = resolveCategory(product.source_url);
    if (!proposedCategory || product.category_name?.trim().toLocaleLowerCase() === proposedCategory) return [];
    return [{
      id: product.id,
      name: product.name,
      sourceUrl: product.source_url,
      currentCategory: product.category_name,
      proposedCategory,
    }];
  });

  const duplicateCandidates = duplicateComponents(activeProducts, resolveCategory).map((group) => {
    const category = resolveCategory(group[0].source_url);
    if (!category) return null;
    const productIds = group.map((product) => product.id);
    return {
      id: [...productIds].sort().join(":"),
      brandId: group[0].brand_id,
      name: group[0].name,
      category,
      productIds,
      products: group.map(({ id, name, category_name, source_url }) => ({
        id,
        name,
        category_name,
        source_url,
      })),
    };
  }).filter((candidate): candidate is DuplicateCandidate => candidate !== null);

  return { categoryCorrections, duplicateCandidates };
}
