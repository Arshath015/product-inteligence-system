"use client";

import Image from "next/image";
import type { Product } from "@/lib/types";

function primaryImage(p: Product) {
  return p.images?.find((i) => i.is_primary && i.status === "stored")?.public_url ?? null;
}

export function ChatProductCard({ product, onOpen }: { product: Product; onOpen?: (p: Product) => void }) {
  const img = primaryImage(product);
  return (
    <button
      onClick={() => onOpen?.(product)}
      className="flex w-full min-w-0 max-w-full items-center gap-3 rounded-xl border border-border bg-surface p-2.5 text-left transition-colors hover:border-accent/40"
    >
      <div className="relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-background">
        {img ? (
          <Image src={img} alt={product.name} fill className="object-contain p-1" unoptimized />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-muted">No image</div>
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <p className="truncate text-sm font-medium text-foreground">{product.name}</p>
        <p className="truncate text-xs text-muted">
          {product.brand?.name ?? "Unknown brand"}
          {product.category?.name ? ` · ${product.category.name}` : ""}
        </p>
      </div>
    </button>
  );
}
