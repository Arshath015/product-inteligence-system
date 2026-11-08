"use client";

import Image from "next/image";
import type { Inspiration } from "@/lib/types";

export function InspirationChatCard({ item }: { item: Inspiration }) {
  const img = item.image_status === "stored" ? item.image_public_url : null;
  return (
    <a
      href={item.source_url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex w-full min-w-0 max-w-full items-center gap-3 rounded-xl border border-border bg-surface p-2.5 text-left transition-colors hover:border-accent/40"
    >
      <div className="relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-background">
        {img ? (
          <Image src={img} alt={item.title ?? "Inspiration"} fill className="object-contain p-1" unoptimized />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-muted">No image</div>
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <p className="truncate text-sm font-medium text-foreground">{item.title ?? "Saved inspiration"}</p>
        <p className="truncate text-xs text-muted capitalize">{item.platform}</p>
      </div>
    </a>
  );
}
