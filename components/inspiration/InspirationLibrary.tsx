"use client";

import { useEffect, useState } from "react";
import { fetchInspirations } from "@/lib/client/api";
import type { Inspiration } from "@/lib/types";
import { InspirationCard } from "@/components/inspiration/InspirationCard";
import { InspirationDetailModal } from "@/components/inspiration/InspirationDetailModal";
import { AddInspirationDialog } from "@/components/inspiration/AddInspirationDialog";
import { useChat } from "@/components/chat/ChatContext";
import { useProject } from "@/components/project/ProjectContext";
import { useCachedList } from "@/components/project/CatalogCacheContext";

const PLATFORMS = [
  { slug: "", label: "All" },
  { slug: "pinterest", label: "Pinterest" },
  { slug: "instagram", label: "Instagram" },
  { slug: "other", label: "Other" },
];

export function InspirationLibrary() {
  const { projectId } = useProject();
  const { catalogVersion } = useChat();
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [platform, setPlatform] = useState("");
  const [selected, setSelected] = useState<Inspiration | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [version, setVersion] = useState(0);

  const refresh = () => setVersion((v) => v + 1);

  useEffect(() => {
    const handle = setTimeout(() => setQDebounced(q), 250);
    return () => clearTimeout(handle);
  }, [q]);

  const { data: items, loading } = useCachedList(
    `inspiration:${projectId}:${qDebounced}:${platform}`,
    () =>
      fetchInspirations(projectId, {
        q: qDebounced || undefined,
        platform: platform || undefined,
        excludePlatform: platform ? undefined : "manufacturer",
      }).then((r) => r.inspirations),
    `${catalogVersion}:${version}`
  );
  const list = items ?? [];

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center justify-between gap-4 px-6 pt-6">
        <div>
          <h1 className="font-serif text-2xl text-foreground">Inspiration</h1>
          <p className="text-sm text-muted">{list.length} saved references</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search inspiration…"
            className="w-56 rounded-full border border-border bg-surface px-4 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent"
          />
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-hover"
          >
            + Save link
          </button>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto px-6 py-3">
        {PLATFORMS.map((p) => (
          <button
            key={p.slug}
            onClick={() => setPlatform(p.slug)}
            className={`flex-shrink-0 rounded-full border px-3.5 py-1.5 text-xs transition-colors ${
              platform === p.slug
                ? "border-accent bg-accent text-accent-foreground"
                : "border-border text-muted hover:border-accent/40 hover:text-foreground"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading && !items ? (
        <div className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-56 animate-pulse rounded-2xl bg-surface sm:h-64" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-24 text-center text-muted">
          <p className="font-serif text-lg text-foreground">No inspiration saved yet</p>
          <p className="max-w-sm text-sm">
            Paste a Pinterest, Instagram, or other design reference link in chat, or save one directly here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {list.map((item) => (
            <InspirationCard key={item.id} item={item} onOpen={setSelected} />
          ))}
        </div>
      )}

      {showAdd && (
        <AddInspirationDialog
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            refresh();
          }}
        />
      )}

      {selected && (
        <InspirationDetailModal
          item={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            refresh();
            fetchInspirations(projectId, {
              q: q || undefined,
              platform: platform || undefined,
              excludePlatform: platform ? undefined : "manufacturer",
            }).then((r) => {
              const updated = r.inspirations.find((i) => i.id === selected.id);
              if (updated) setSelected(updated);
            });
          }}
        />
      )}
    </div>
  );
}
