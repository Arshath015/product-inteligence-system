"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteBrand, fetchBrand } from "@/lib/client/api";
import type { Brand, Product } from "@/lib/types";
import { ProductGrid } from "@/components/catalog/ProductGrid";
import { useChat } from "@/components/chat/ChatContext";
import { useProject } from "@/components/project/ProjectContext";

export function BrandDetailView({ brandId }: { brandId: string }) {
  const { projectId } = useProject();
  const router = useRouter();
  const { catalogVersion, openProduct } = useChat();
  const [brand, setBrand] = useState<Brand | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-change needs a loading flag
    setLoading(true);
    fetchBrand(projectId, brandId)
      .then((r) => {
        setBrand(r.brand);
        setProducts(r.products);
      })
      .finally(() => setLoading(false));
  }, [projectId, brandId, catalogVersion]);

  if (loading) return <div className="p-6 text-sm text-muted">Loading…</div>;
  if (!brand) return <div className="p-6 text-sm text-muted">Brand not found.</div>;

  const isOwner = brand.project_id === projectId;

  const removeReference = async () => {
    if (!confirm(`Remove "${brand.name}" from this project? The original stays in its source project.`)) return;
    setBusy(true);
    try {
      await deleteBrand(projectId, brand.id);
      router.push(`/p/${projectId}/brands`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="px-6 pt-6">
        <Link href={`/p/${projectId}/brands`} className="text-xs text-muted hover:text-foreground">
          ← All brands
        </Link>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="font-serif text-2xl text-foreground">{brand.name}</h1>
          {!isOwner && (
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted">
              Shared from another project
            </span>
          )}
        </div>
        {brand.description && <p className="mt-1 max-w-xl text-sm text-muted">{brand.description}</p>}
        {brand.website_url && (
          <a
            href={brand.website_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block max-w-full break-all text-sm text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            {brand.website_url}
          </a>
        )}
        {!isOwner && (
          <button
            onClick={removeReference}
            disabled={busy}
            className="mt-3 block rounded-full border border-danger/40 px-4 py-1.5 text-xs text-danger hover:bg-danger/10"
          >
            Remove from this project
          </button>
        )}
      </div>
      <ProductGrid products={products} loading={false} onOpen={openProduct} />
    </div>
  );
}
