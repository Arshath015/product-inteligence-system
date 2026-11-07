"use client";

import { useEffect, useState } from "react";
import { fetchCategories, fetchProducts } from "@/lib/client/api";
import type { Category, Product } from "@/lib/types";
import { CategoryFilterBar } from "@/components/catalog/CategoryFilterBar";
import { ProductGrid } from "@/components/catalog/ProductGrid";
import { AddProductDialog } from "@/components/catalog/AddProductDialog";
import { useChat } from "@/components/chat/ChatContext";

export function CatalogueView() {
  const { catalogVersion, openProduct } = useChat();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<(Category & { product_count: number })[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    fetchCategories().then((r) => setCategories(r.categories)).catch(() => {});
  }, [catalogVersion]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced fetch-on-change needs a loading flag
    setLoading(true);
    const handle = setTimeout(() => {
      fetchProducts({ q: q || undefined, category: category || undefined })
        .then((r) => setProducts(r.products))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [q, category, catalogVersion]);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center justify-between gap-4 px-6 pt-6">
        <div>
          <h1 className="font-serif text-2xl">Catalogue</h1>
          <p className="text-sm text-muted">{products.length} pieces</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search products…"
            className="w-56 rounded-full border border-border bg-surface px-4 py-1.5 text-sm outline-none placeholder:text-muted"
          />
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-full bg-foreground px-4 py-1.5 text-xs text-background"
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
