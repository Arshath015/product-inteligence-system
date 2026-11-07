"use client";

import type { Product } from "@/lib/types";
import { ProductCard } from "@/components/catalog/ProductCard";

export function ProductGrid({
  products,
  loading,
  onOpen,
}: {
  products: Product[];
  loading: boolean;
  onOpen: (p: Product) => void;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="aspect-[4/5] animate-pulse rounded-2xl bg-surface" />
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-24 text-center text-muted">
        <p className="font-serif text-lg text-foreground">No products yet</p>
        <p className="max-w-sm text-sm">
          Paste a product URL in the chat, or add one manually, to start building the catalogue.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {products.map((p) => (
        <ProductCard key={p.id} product={p} onOpen={onOpen} />
      ))}
    </div>
  );
}
