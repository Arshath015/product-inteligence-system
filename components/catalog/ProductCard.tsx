"use client";

import type { Product } from "@/lib/types";
import { SmartImage } from "@/components/common/SmartImage";

function primaryImage(p: Product) {
  const img = p.images?.find((i) => i.is_primary) ?? p.images?.[0];
  return img?.status === "stored" ? img.public_url : null;
}

const missingFallback = (
  <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted">
    <span className="text-2xl">—</span>
    <span className="text-[11px]">Image unavailable</span>
  </div>
);

export function ProductCard({ product, onOpen }: { product: Product; onOpen: (p: Product) => void }) {
  const img = primaryImage(product);

  return (
    <button
      onClick={() => onOpen(product)}
      className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface text-left transition-all hover:border-accent/40 hover:shadow-lg hover:shadow-black/20"
    >
      <div className="relative h-56 w-full overflow-hidden bg-background sm:h-64">
        <SmartImage
          src={img}
          alt={product.name}
          className="object-contain p-3 transition-transform duration-300 group-hover:scale-[1.04]"
          fallback={missingFallback}
        />
      </div>
      <div className="flex flex-1 flex-col gap-1 border-t border-border p-3.5">
        <p className="truncate text-[11px] uppercase tracking-wide text-muted">
          {product.brand?.name ?? "Unknown brand"}
        </p>
        <p className="line-clamp-2 font-serif text-[15px] leading-snug text-foreground">{product.name}</p>
        {product.category?.name && <p className="text-xs text-muted">{product.category.name}</p>}
      </div>
    </button>
  );
}
