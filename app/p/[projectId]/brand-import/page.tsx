"use client";

import { useCallback, useRef, useState } from "react";
import { useProject } from "@/components/project/ProjectContext";
import type { CatalogueProduct, ExtractProgressEvent } from "@/lib/bulk/brandCatalogueService";

// ─── Types ──────────────────────────────────────────────────────────────────

type Phase = "idle" | "discovering" | "pre_screening" | "extracting" | "done" | "error";

interface ProgressState {
  phase: Phase;
  message: string;
  discovered: number;
  extracted: number;
  failed: number;
  total: number;
  brandId: string | null;
  brandName: string | null;
}

// ─── Catalogue product card ──────────────────────────────────────────────────

function CatalogCard({
  product,
  selected,
  alreadyInProject,
  onToggle,
}: {
  product: CatalogueProduct;
  selected: boolean;
  alreadyInProject: boolean;
  onToggle: (id: string) => void;
}) {
  const img = product.primary_image_url ?? (Array.isArray(product.images) ? product.images[0] : null);

  return (
    <button
      onClick={() => !alreadyInProject && onToggle(product.id)}
      className={`group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border text-left transition-all
        ${alreadyInProject
          ? "cursor-default border-border opacity-50"
          : selected
            ? "border-accent shadow-lg shadow-accent/20"
            : "border-border hover:border-accent/40 hover:shadow-lg hover:shadow-black/20"
        }`}
    >
      {/* Selection ring */}
      {!alreadyInProject && (
        <div className={`absolute right-2.5 top-2.5 z-10 h-5 w-5 rounded-full border-2 transition-colors
          ${selected ? "border-accent bg-accent" : "border-border bg-surface"}`}>
          {selected && (
            <svg className="h-full w-full p-0.5 text-accent-foreground" viewBox="0 0 12 12" fill="currentColor">
              <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
            </svg>
          )}
        </div>
      )}
      {alreadyInProject && (
        <div className="absolute right-2.5 top-2.5 z-10 rounded-full bg-surface/90 border border-border px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-muted">
          In project
        </div>
      )}

      {/* Image */}
      <div className="relative h-48 w-full overflow-hidden bg-background sm:h-56">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={product.name}
            className="h-full w-full object-contain p-3 transition-transform duration-300 group-hover:scale-[1.03]"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-2xl text-muted">—</div>
        )}
      </div>

      {/* Info */}
      <div className="flex flex-1 flex-col gap-0.5 border-t border-border bg-surface p-3">
        {product.category_name && (
          <p className="truncate text-[10px] uppercase tracking-wide text-muted">{product.category_name}</p>
        )}
        <p className="line-clamp-2 font-serif text-[14px] leading-snug text-foreground">{product.name}</p>
      </div>
    </button>
  );
}

// ─── Progress bar ────────────────────────────────────────────────────────────

function ProgressBar({ progress }: { progress: ProgressState }) {
  const pct = progress.total > 0 ? Math.round((progress.extracted / progress.total) * 100) : 0;

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-foreground">{progress.message}</p>
        <p className="font-serif text-sm text-foreground">
          {progress.extracted} <span className="text-muted">/ {progress.total || "?"}</span>
        </p>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-background">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.failed > 0 && (
        <p className="mt-2 text-xs text-muted">{progress.failed} pages unavailable (skipped)</p>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function BrandImportPage() {
  const { projectId } = useProject();
  const [url, setUrl] = useState("");
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [alreadyInProject, setAlreadyInProject] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ProgressState>({
    phase: "idle",
    message: "",
    discovered: 0,
    extracted: 0,
    failed: 0,
    total: 0,
    brandId: null,
    brandName: null,
  });
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<{ added: number; duplicates: number } | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  const startExtraction = useCallback(async () => {
    if (!url.trim()) return;
    try { new URL(url.trim()); } catch { return; }

    // Reset
    setProducts([]);
    setSelected(new Set());
    setAlreadyInProject(new Set());
    setAddResult(null);
    setProgress({
      phase: "discovering",
      message: "Connecting…",
      discovered: 0, extracted: 0, failed: 0, total: 0,
      brandId: null, brandName: null,
    });

    // Abort any in-progress stream
    readerRef.current?.cancel().catch(() => {});

    const res = await fetch("/api/brand-catalogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandUrl: url.trim(), projectId }),
    });

    if (!res.ok || !res.body) {
      setProgress((p) => ({ ...p, phase: "error", message: "Failed to connect. Please try again." }));
      return;
    }

    const reader = res.body.getReader();
    readerRef.current = reader;
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";

      for (const chunk of lines) {
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const event: ExtractProgressEvent = JSON.parse(dataLine.slice(6));
          handleEvent(event);
        } catch {
          // ignore malformed events
        }
      }
    }
  }, [url]);

  const handleEvent = useCallback((event: ExtractProgressEvent) => {
    switch (event.type) {
      case "phase":
        setProgress((p) => ({ ...p, phase: event.phase as Phase, message: event.message }));
        break;
      case "discovered":
        setProgress((p) => ({
          ...p,
          phase: "extracting",
          discovered: event.total,
          total: event.total,
          brandId: event.brandId,
          brandName: event.brandName,
          message: `Found ${event.total} products on ${event.brandName}`,
        }));
        break;
      case "product":
        setProducts((prev) => {
          if (prev.some((p) => p.id === event.product.id)) return prev;
          return [...prev, event.product];
        });
        setProgress((p) => ({
          ...p,
          extracted: event.extracted,
          failed: event.failed,
          total: event.total,
          message: p.brandName ? `Extracting ${p.brandName}…` : "Extracting products…",
        }));
        break;
      case "skip":
        setProgress((p) => ({
          ...p,
          extracted: event.extracted,
          failed: event.failed,
          total: event.total,
        }));
        break;
      case "done":
        setProgress((p) => ({
          ...p,
          phase: "done",
          extracted: event.extracted,
          failed: event.failed,
          total: event.total,
          message: `${event.extracted} products extracted`,
          brandId: event.brandId,
        }));
        // Auto-select all by default
        setProducts((prev) => {
          setSelected(new Set(prev.map((p) => p.id)));
          return prev;
        });
        break;
      case "error":
        setProgress((p) => ({ ...p, phase: "error", message: event.message }));
        break;
    }
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = () => setSelected(new Set(products.filter((p) => !alreadyInProject.has(p.id)).map((p) => p.id)));
  const deselectAll = () => setSelected(new Set());

  const addToProject = async () => {
    if (selected.size === 0) return;
    setAdding(true);
    setAddResult(null);
    try {
      const res = await fetch("/api/brand-catalogue/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, productIds: [...selected] }),
      });
      const data = await res.json();
      setAddResult(data);
      // Mark newly added as already in project
      setAlreadyInProject((prev) => {
        const next = new Set(prev);
        [...selected].forEach((id) => next.add(id));
        return next;
      });
      setSelected(new Set());
    } finally {
      setAdding(false);
    }
  };

  const isRunning = progress.phase === "discovering" || progress.phase === "pre_screening" || progress.phase === "extracting";
  const isDone = progress.phase === "done";
  const hasProducts = products.length > 0;
  const selectableCount = products.filter((p) => !alreadyInProject.has(p.id)).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 pb-24">
      {/* Header */}
      <div>
        <h1 className="font-serif text-2xl text-foreground">Brand Import</h1>
        <p className="mt-1 text-sm text-muted">
          Paste a brand URL to extract its entire product catalogue. Then choose which products to add to this project.
        </p>
      </div>

      {/* URL input */}
      <div className="flex gap-3">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !isRunning && startExtraction()}
          placeholder="https://pianca.com"
          disabled={isRunning}
          className="min-w-0 flex-1 rounded-full border border-border bg-surface px-4 py-2.5 text-sm text-foreground placeholder:text-muted focus:border-accent/60 focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={startExtraction}
          disabled={isRunning || !url.trim()}
          className="rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {isRunning ? "Extracting…" : "Extract"}
        </button>
      </div>

      {/* Progress */}
      {(isRunning || isDone || progress.phase === "error") && (
        <ProgressBar progress={progress} />
      )}

      {/* Add result toast */}
      {addResult && (
        <div className="rounded-2xl border border-border bg-surface p-4 text-sm">
          {addResult.added > 0 && (
            <p className="text-foreground">
              Added <strong>{addResult.added}</strong> product{addResult.added !== 1 ? "s" : ""} to your project.
            </p>
          )}
          {addResult.duplicates > 0 && (
            <p className="text-muted">{addResult.duplicates} already in project (skipped).</p>
          )}
        </div>
      )}

      {/* Products grid */}
      {hasProducts && (
        <>
          {/* Selection toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <p className="text-sm text-foreground">
                <strong>{selected.size}</strong> selected
                {selectableCount > 0 && <span className="text-muted"> of {selectableCount}</span>}
              </p>
              <button onClick={selectAll} className="text-xs text-muted underline-offset-2 hover:underline">
                Select all
              </button>
              <button onClick={deselectAll} className="text-xs text-muted underline-offset-2 hover:underline">
                None
              </button>
            </div>
            <button
              onClick={addToProject}
              disabled={selected.size === 0 || adding}
              className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {adding ? "Adding…" : `Add ${selected.size > 0 ? selected.size : ""} to project`}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {products.map((p) => (
              <CatalogCard
                key={p.id}
                product={p}
                selected={selected.has(p.id)}
                alreadyInProject={alreadyInProject.has(p.id)}
                onToggle={toggleSelect}
              />
            ))}
            {/* Loading skeleton cards while extracting */}
            {isRunning &&
              Array.from({ length: 5 }).map((_, i) => (
                <div key={`skel-${i}`} className="animate-pulse rounded-2xl border border-border bg-surface">
                  <div className="h-48 bg-background sm:h-56" />
                  <div className="border-t border-border p-3">
                    <div className="mb-1.5 h-2 w-16 rounded bg-border" />
                    <div className="h-3 w-3/4 rounded bg-border" />
                  </div>
                </div>
              ))}
          </div>
        </>
      )}

      {/* Empty state while extracting */}
      {isRunning && !hasProducts && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-2xl border border-border bg-surface">
              <div className="h-48 bg-background sm:h-56" />
              <div className="border-t border-border p-3">
                <div className="mb-1.5 h-2 w-16 rounded bg-border" />
                <div className="h-3 w-3/4 rounded bg-border" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
