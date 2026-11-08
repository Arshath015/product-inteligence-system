"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchBrands } from "@/lib/client/api";
import type { Brand } from "@/lib/types";
import { useChat } from "@/components/chat/ChatContext";
import { useProject } from "@/components/project/ProjectContext";

export function BrandDirectory() {
  const { projectId } = useProject();
  const { catalogVersion } = useChat();
  const [brands, setBrands] = useState<(Brand & { product_count: number; is_owner?: boolean })[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-change needs a loading flag
    setLoading(true);
    fetchBrands(projectId, q || undefined)
      .then((r) => setBrands(r.brands))
      .finally(() => setLoading(false));
  }, [projectId, q, catalogVersion]);

  return (
    <div className="px-6 py-6">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl text-foreground">Brands</h1>
          <p className="text-sm text-muted">{brands.length} brands</p>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search brands…"
          className="w-56 rounded-full border border-border bg-surface px-4 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent"
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-surface" />
          ))}
        </div>
      ) : brands.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted">
          No brands yet — add a product from a URL in chat and its brand will appear here.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {brands.map((b) => (
            <Link
              key={b.id}
              href={`/p/${projectId}/brands/${b.id}`}
              className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent/50"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-serif text-base text-foreground">{b.name}</p>
                {b.is_owner === false && (
                  <span className="flex-shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted">
                    Shared
                  </span>
                )}
              </div>
              <p className="text-xs text-muted">
                {b.product_count} product{b.product_count === 1 ? "" : "s"}
                {b.country ? ` · ${b.country}` : ""}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
