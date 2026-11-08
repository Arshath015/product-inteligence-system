"use client";

import type { Inspiration } from "@/lib/types";
import { SmartImage } from "@/components/common/SmartImage";

const PLATFORM_LABEL: Record<string, string> = {
  pinterest: "Pinterest",
  instagram: "Instagram",
  manufacturer: "Manufacturer",
  brand: "Brand",
  other: "Other",
};

const missingFallback = (
  <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted">
    <span className="text-2xl">—</span>
    <span className="text-[11px]">No preview</span>
  </div>
);

export function InspirationCard({ item, onOpen }: { item: Inspiration; onOpen: (i: Inspiration) => void }) {
  const img = item.image_status === "stored" ? item.image_public_url : null;

  return (
    <button
      onClick={() => onOpen(item)}
      className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface text-left transition-all hover:border-accent/40 hover:shadow-lg hover:shadow-black/20"
    >
      <div className="relative h-56 w-full overflow-hidden bg-background sm:h-64">
        <SmartImage
          src={img}
          alt={item.title ?? "Inspiration"}
          className="object-contain p-3 transition-transform duration-300 group-hover:scale-[1.04]"
          fallback={missingFallback}
        />
        <span className="absolute left-2 top-2 rounded-full border border-border bg-surface/90 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          {PLATFORM_LABEL[item.platform] ?? item.platform}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 border-t border-border p-3.5">
        <p className="line-clamp-2 font-serif text-[15px] leading-snug text-foreground">
          {item.title ?? "Untitled inspiration"}
        </p>
        {item.tags.length > 0 && (
          <p className="truncate text-xs text-muted">{item.tags.slice(0, 3).join(" · ")}</p>
        )}
      </div>
    </button>
  );
}
