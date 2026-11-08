"use client";

import { useEffect, useState } from "react";
import { fetchBrands, fetchCategories, fetchProducts } from "@/lib/client/api";
import type { Brand, Category, Product } from "@/lib/types";
import { CategoryFilterBar } from "@/components/catalog/CategoryFilterBar";
import { ProductGrid } from "@/components/catalog/ProductGrid";
import { AddProductDialog } from "@/components/catalog/AddProductDialog";
import { useChat } from "@/components/chat/ChatContext";
import { useProject } from "@/components/project/ProjectContext";

export function CatalogueView() {
  const { projectId } = useProject();
  const { catalogVersion, openProduct } = useChat();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<(Category & { product_count: number })[]>([]);
  const [brands, setBrands] = useState<(Brand & { product_count: number })[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [brand, setBrand] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    fetchCategories(projectId).then((r) => setCategories(r.categories)).catch(() => {});
    fetchBrands(projectId).then((r) => setBrands(r.brands)).catch(() => {});
  }, [projectId, catalogVersion]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced fetch-on-change needs a loading flag
    setLoading(true);
    const handle = setTimeout(() => {
      fetchProducts(projectId, { q: q || undefined, category: category || undefined, brand: brand || undefined })
        .then((r) => setProducts(r.products))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [projectId, q, category, brand, catalogVersion]);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-6">
        <div>
          <h1 className="font-serif text-2xl text-foreground">Catalogue</h1>
          <p className="text-sm text-muted">{products.length} pieces</p>
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
            {brands
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

      <CategoryFilterBar categories={categories} active={category} onSelect={setCategory} />

      <ProductGrid products={products} loading={loading} onOpen={openProduct} />

      {showAdd && <AddProductDialog onClose={() => setShowAdd(false)} />}
    </div>
  );
}
