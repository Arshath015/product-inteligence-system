"use client";

import { useEffect, useState } from "react";
import { fetchBrands, fetchCategories, fetchProducts } from "@/lib/client/api";
import { CategoryFilterBar } from "@/components/catalog/CategoryFilterBar";
import { ProductGrid } from "@/components/catalog/ProductGrid";
import { AddProductDialog } from "@/components/catalog/AddProductDialog";
import { useChat } from "@/components/chat/ChatContext";
import { useProject } from "@/components/project/ProjectContext";
import { useCachedList } from "@/components/project/CatalogCacheContext";

export function CatalogueView() {
  const { projectId } = useProject();
  const { catalogVersion, openProduct } = useChat();
  const [category, setCategory] = useState<string | null>(null);
  const [brand, setBrand] = useState("");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => setQDebounced(q), 250);
    return () => clearTimeout(handle);
  }, [q]);

  const { data: categories } = useCachedList(
    `categories:${projectId}`,
    () => fetchCategories(projectId).then((r) => r.categories),
    catalogVersion
  );
  const { data: brands } = useCachedList(
    `brands:${projectId}`,
    () => fetchBrands(projectId).then((r) => r.brands),
    catalogVersion
  );
  const { data: products, loading } = useCachedList(
    `products:${projectId}:${qDebounced}:${category ?? ""}:${brand}`,
    () => fetchProducts(projectId, { q: qDebounced || undefined, category: category || undefined, brand: brand || undefined }).then((r) => r.products),
    catalogVersion
  );

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-6">
        <div>
          <h1 className="font-serif text-2xl text-foreground">Catalogue</h1>
          <p className="text-sm text-muted">{(products ?? []).length} pieces</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search products…"
            className="w-56 rounded-full border border-border bg-surface px-4 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent"
          />
          <select
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="rounded-full border border-border bg-surface px-4 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-accent"
          >
            <option value="">All brands</option>
            {(brands ?? [])
              .filter((b) => b.product_count > 0)
              .map((b) => (
                <option key={b.id} value={b.slug}>
                  {b.name} ({b.product_count})
                </option>
              ))}
          </select>
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-hover"
          >
            + Add
          </button>
        </div>
      </div>

      <CategoryFilterBar categories={categories ?? []} active={category} onSelect={setCategory} />

      <ProductGrid products={products ?? []} loading={loading && !products} onOpen={openProduct} />

      {showAdd && <AddProductDialog onClose={() => setShowAdd(false)} />}
    </div>
  );
}
