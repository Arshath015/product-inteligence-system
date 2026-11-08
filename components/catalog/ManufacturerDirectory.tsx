"use client";

import { useEffect, useState } from "react";
import { fetchInspirations } from "@/lib/client/api";
import type { Inspiration } from "@/lib/types";
import { SmartImage } from "@/components/common/SmartImage";
import { useChat } from "@/components/chat/ChatContext";
import { useProject } from "@/components/project/ProjectContext";
import { useCachedList } from "@/components/project/CatalogCacheContext";

const KIND_LABEL: Record<string, string> = {
  artisan: "Artisan",
  "artisan-directory": "Artisan directory",
  gallery: "Gallery",
  collection: "Collection",
  brand: "Brand",
  reference: "Reference",
};

function kindFor(item: Inspiration): string {
  for (const tag of item.tags) {
    if (KIND_LABEL[tag]) return KIND_LABEL[tag];
  }
  return "Directory entry";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const missingFallback = (
  <div className="flex h-full w-full items-center justify-center text-muted">
    <span className="text-xl">—</span>
  </div>
);

export function ManufacturerDirectory() {
  const { projectId } = useProject();
  const { catalogVersion } = useChat();
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setQDebounced(q), 250);
    return () => clearTimeout(handle);
  }, [q]);

  const { data: items, loading } = useCachedList(
    `manufacturers:${projectId}:${qDebounced}`,
    () =>
      fetchInspirations(projectId, { q: qDebounced || undefined, platform: "manufacturer", limit: 120 }).then(
        (r) => r.inspirations
      ),
    catalogVersion
  );
  const list = items ?? [];

  return (
    <div className="px-6 py-6">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl text-foreground">Manufacturers & Artisans</h1>
          <p className="text-sm text-muted">{list.length} directory entries</p>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search manufacturers…"
          className="w-56 rounded-full border border-border bg-surface px-4 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent"
        />
      </div>

      {loading && !items ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl bg-surface" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted">
          No manufacturers, artisans, or galleries saved yet — bulk-import a directory or profile link in chat and it
          will appear here.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((item) => (
            <a
              key={item.id}
              href={item.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex gap-3 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-accent/40"
            >
              <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-xl bg-background">
                <SmartImage
                  src={item.image_status === "stored" ? item.image_public_url : null}
                  alt={item.title ?? "Manufacturer"}
                  className="object-cover"
                  fallback={missingFallback}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-1 font-serif text-[15px] text-foreground">
                    {item.title ?? hostOf(item.source_url)}
                  </p>
                  <span className="flex-shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    {kindFor(item)}
                  </span>
                </div>
                {item.caption && <p className="truncate text-xs text-muted">{item.caption}</p>}
                {item.description && <p className="line-clamp-2 text-xs text-muted">{item.description}</p>}
                <p className="mt-0.5 truncate text-[11px] text-muted/70 group-hover:text-accent">
                  {hostOf(item.source_url)} ↗
                </p>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
