"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchBrand } from "@/lib/client/api";
import type { Brand, Product } from "@/lib/types";
import { ProductGrid } from "@/components/catalog/ProductGrid";
import { useChat } from "@/components/chat/ChatContext";

export function BrandDetailView({ brandId }: { brandId: string }) {
  const { catalogVersion, openProduct } = useChat();
  const [brand, setBrand] = useState<Brand | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-change needs a loading flag
    setLoading(true);
    fetchBrand(brandId)
      .then((r) => {
        setBrand(r.brand);
        setProducts(r.products);
      })
      .finally(() => setLoading(false));
  }, [brandId, catalogVersion]);

  if (loading) return <div className="p-6 text-sm text-muted">Loading…</div>;
  if (!brand) return <div className="p-6 text-sm text-muted">Brand not found.</div>;

  return (
    <div>
      <div className="px-6 pt-6">
        <Link href="/brands" className="text-xs text-muted hover:text-foreground">
          ← All brands
        </Link>
        <h1 className="mt-2 font-serif text-2xl">{brand.name}</h1>
        {brand.description && <p className="mt-1 max-w-xl text-sm text-muted">{brand.description}</p>}
        {brand.website_url && (
          <a href={brand.website_url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-sm underline">
            {brand.website_url}
          </a>
        )}
      </div>
      <ProductGrid products={products} loading={false} onOpen={openProduct} />
    </div>
  );
}
