"use client";

import Image from "next/image";
import type { Product } from "@/lib/types";

function primaryImage(p: Product) {
  const img = p.images?.find((i) => i.is_primary) ?? p.images?.[0];
  return img?.status === "stored" ? img.public_url : null;
}

export function ProductCard({ product, onOpen }: { product: Product; onOpen: (p: Product) => void }) {
  const img = primaryImage(product);

  return (
    <button
      onClick={() => onOpen(product)}
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface text-left transition-shadow hover:shadow-md"
    >
      <div className="relative aspect-[4/5] w-full overflow-hidden bg-background">
        {img ? (
          <Image
            src={img}
            alt={product.name}
            fill
            unoptimized
            className="object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted">
            <span className="text-2xl">—</span>
            <span className="text-[11px]">Image unavailable</span>
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3.5">
        <p className="text-[11px] uppercase tracking-wide text-muted">{product.brand?.name ?? "Unknown brand"}</p>
        <p className="line-clamp-2 font-serif text-[15px] leading-snug text-foreground">{product.name}</p>
        {product.category?.name && <p className="text-xs text-muted">{product.category.name}</p>}
      </div>
    </button>
  );
}
