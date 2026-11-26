"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useProject } from "@/components/project/ProjectContext";
import type { CatalogueProduct, ExtractProgressEvent } from "@/lib/bulk/brandCatalogueService";

type Phase = "idle" | "discovering" | "extracting" | "done" | "error";

interface ProgressState {
  phase: Phase;
  message: string;
  processed: number;
  added: number;
  duplicates: number;
  failed: number;
  total: number;
  hasMore: boolean;
  truncated: boolean;
  brandId: string | null;
  brandName: string | null;
  runId: string | null;
  failureDetails: Record<string, string>;
}

// ─── Catalogue product card ───────────────────────────────────────────────────

function CatalogCard({
  product, selected, alreadyInProject, onToggle,
}: {
  product: CatalogueProduct; selected: boolean; alreadyInProject: boolean; onToggle: (id: string) => void;
}) {
  const img = product.primary_image_url ?? (Array.isArray(product.images) ? product.images[0] : null);
  return (
    <div
      className={`group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border transition-all
        ${alreadyInProject
          ? "cursor-default border-border opacity-50"
          : selected
            ? "border-accent shadow-lg shadow-accent/20"
            : "border-border hover:border-accent/40 hover:shadow-lg hover:shadow-black/20"}`}
    >
      <button
        type="button"
        onClick={() => !alreadyInProject && onToggle(product.id)}
        disabled={alreadyInProject}
        aria-pressed={selected}
        aria-label={`${selected ? "Deselect" : "Select"} ${product.name}`}
        className="relative flex min-w-0 w-full flex-1 flex-col text-left disabled:cursor-default"
      >
        {!alreadyInProject && (
          <div className={`absolute right-2.5 top-2.5 z-10 h-5 w-5 rounded-full border-2 transition-colors
            ${selected ? "border-accent bg-accent" : "border-border bg-surface"}`}>
            {selected && (
              <svg className="h-full w-full p-0.5 text-accent-foreground" viewBox="0 0 12 12" fill="none">
                <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            )}
          </div>
        )}
        {alreadyInProject && (
          <div className="absolute right-2.5 top-2.5 z-10 rounded-full bg-surface/90 border border-border px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-muted">
            In project
          </div>
        )}
        <div className="relative h-48 w-full overflow-hidden bg-background sm:h-52">
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img} alt={product.name}
              className="h-full w-full object-contain p-3 transition-transform duration-300 group-hover:scale-[1.03]"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-2xl text-muted">—</div>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-0.5 border-t border-border bg-surface p-3">
          {product.category_name && (
            <p className="truncate text-[10px] uppercase tracking-wide text-muted">{product.category_name}</p>
          )}
          <p className="line-clamp-2 font-serif text-[14px] leading-snug text-foreground">{product.name}</p>
        </div>
      </button>
      <a
        href={product.source_url}
        target="_blank"
        rel="noreferrer"
        className="truncate border-t border-border bg-surface px-3 py-2 text-xs text-accent hover:underline"
        title={product.source_url}
      >
        View product page ↗
      </a>
    </div>
  );
}

const MemoCatalogCard = memo(CatalogCard);

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BrandImportPage() {
  const { projectId } = useProject();

  const [url, setUrl] = useState(() => {
    try { return sessionStorage.getItem("brand-import-url") ?? ""; } catch { return ""; }
  });

  // Per-brand buckets: brandId → products
  const [brandBuckets, setBrandBuckets] = useState<Record<string, { name: string; products: CatalogueProduct[] }>>({});
  const [activeBrandId, setActiveBrandId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [alreadyInProject, setAlreadyInProject] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState("all");

  const [progress, setProgress] = useState<ProgressState>({
    phase: "idle", message: "", processed: 0, added: 0, duplicates: 0, failed: 0, total: 0,
    hasMore: false, truncated: false, brandId: null, brandName: null, runId: null, failureDetails: {},
  });

  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<{ added: number; duplicates: number } | null>(null);
  const [categoryEdit, setCategoryEdit] = useState("");
  const [categorySaving, setCategorySaving] = useState(false);
  const [categoryResult, setCategoryResult] = useState("");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsText, setDiagnosticsText] = useState("");
  const [diagnosticsError, setDiagnosticsError] = useState("");
  const [resumeFlag, setResumeFlag] = useState(0);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const runIdRef = useRef<string | null>(null);
  const retryModeRef = useRef(false);
  // Set to true when a "done+hasMore" event has already scheduled the next
  // batch — prevents the stream-closure fallback from firing a duplicate resume.
  const hasMorePendingRef = useRef(false);

  useEffect(() => {
    try { sessionStorage.setItem("brand-import-url", url); } catch {}
  }, [url]);

  // On mount: reload previously extracted brands from DB, then auto-resume
  // any extraction that was interrupted (e.g. user navigated away mid-run).
  useEffect(() => {
    const savedUrl = (() => { try { return sessionStorage.getItem("brand-import-url") ?? ""; } catch { return ""; } })();
    fetch(`/api/brand-catalogue?projectId=${projectId}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.brands) && data.brands.length > 0) {
          setBrandBuckets((prev) => {
            const next = { ...prev };
            for (const b of data.brands) {
              if (!next[b.id]) {
                next[b.id] = { name: b.name, products: b.products };
              }
            }
            return next;
          });
          setActiveBrandId((prev) => prev ?? data.brands[0]?.id ?? null);
        }

        // Auto-resume if extraction was interrupted (flag stored in sessionStorage)
        const wasRunning = (() => { try { return sessionStorage.getItem("brand-import-running") === projectId; } catch { return false; } })();
        const savedRunId = (() => { try { return sessionStorage.getItem("brand-import-run-id"); } catch { return null; } })();
        if (savedRunId) {
          runIdRef.current = savedRunId;
          setProgress((p) => ({ ...p, runId: savedRunId }));
        }
        if (wasRunning && savedUrl) {
          runIdRef.current = savedRunId;
          setProgress((p) => ({ ...p, phase: "extracting", message: "Resuming interrupted extraction…" }));
          setResumeFlag(1);
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEvent = useCallback((event: ExtractProgressEvent) => {
    switch (event.type) {
      case "phase":
        setProgress((p) => ({
          ...p,
          phase: event.phase as Phase,
          message: event.message,
          runId: event.runId ?? p.runId,
        }));
        break;
      case "discovered":
        setActiveBrandId(event.brandId);
        runIdRef.current = event.runId;
        try { sessionStorage.setItem("brand-import-run-id", event.runId); } catch {}
        setBrandBuckets((prev) => ({
          ...prev,
          [event.brandId]: { name: event.brandName, products: prev[event.brandId]?.products ?? [] },
        }));
        setProgress((p) => ({
          ...p, phase: "extracting",
          processed: event.processed,
          added: event.added,
          duplicates: event.duplicates,
          failed: event.failed,
          total: event.total,
          hasMore: event.hasMore,
          brandId: event.brandId, brandName: event.brandName,
          runId: event.runId,
          message: `Discovered ${event.total} product pages on ${event.brandName}`,
        }));
        break;
      case "product":
        setBrandBuckets((prev) => {
          const bid = event.product.brand_id;
          const existing = prev[bid]?.products ?? [];
          if (existing.some((p) => p.id === event.product.id)) return prev;
          return { ...prev, [bid]: { name: prev[bid]?.name ?? "", products: [...existing, event.product] } };
        });
        setProgress((p) => ({
          ...p,
          processed: event.processed,
          added: event.added,
          duplicates: event.duplicates,
          failed: event.failed,
          total: event.total,
          failureDetails: Object.fromEntries(
            Object.entries(p.failureDetails).filter(([url]) => url !== event.product.source_url),
          ),
        }));
        break;
      case "skip":
        setProgress((p) => ({
          ...p,
          processed: event.processed,
          added: event.added,
          duplicates: event.duplicates,
          failed: event.failed,
          total: event.total,
          failureDetails: { ...p.failureDetails, [event.url]: event.reason },
        }));
        break;
      case "done":
        retryModeRef.current = event.retrying;
        if (event.hasMore && !event.retrying) {
          // More batches remain — resume without resetting UI.
          // Set the flag so stream-closure fallback doesn't fire a duplicate.
          hasMorePendingRef.current = true;
          setTimeout(() => {
            hasMorePendingRef.current = false;
            setResumeFlag((n) => n + 1);
          }, 400);
          setProgress((p) => ({
            ...p, phase: "extracting", processed: event.processed,
            added: event.added, duplicates: event.duplicates, failed: event.failed,
            total: event.total, hasMore: event.hasMore, truncated: event.truncated,
            message: `Processed ${event.processed} of ${event.total}; continuing…`,
          }));
        } else {
          try { sessionStorage.removeItem("brand-import-running"); } catch {}
          setProgress((p) => ({
            ...p, phase: "done", processed: event.processed, added: event.added,
            duplicates: event.duplicates, failed: event.failed,
            total: event.total, hasMore: event.hasMore, brandId: event.brandId,
            runId: event.runId, truncated: event.truncated,
            message: `Discovered ${event.total}; processed ${event.processed}; added ${event.added}; duplicates ${event.duplicates}; failed ${event.failed}.${event.truncated ? " Discovery reached a configured product, collection, or sitemap crawl limit; more products may remain." : ""}`,
          }));
          setBrandBuckets((prev) => {
            const products = prev[event.brandId]?.products ?? [];
            setSelected(new Set(products.filter((p) => !alreadyInProject.has(p.id)).map((p) => p.id)));
            return prev;
          });
        }
        break;
      case "error":
        try { sessionStorage.removeItem("brand-import-running"); } catch {}
        setProgress((p) => ({ ...p, phase: "error", message: event.message }));
        break;
    }
  }, [alreadyInProject]);

  const runStream = useCallback(async (
    brandUrl: string,
    pid: string,
    options: { runId?: string; retryFailed?: boolean } = {},
  ) => {
    const res = await fetch("/api/brand-catalogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandUrl, projectId: pid, ...options }),
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => null);
      setProgress((p) => ({
        ...p,
        phase: "error",
        message: typeof body?.error === "string" ? body.error : "Failed to connect. Please try again.",
      }));
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
        try { handleEvent(JSON.parse(dataLine.slice(6))); } catch { /* ignore */ }
      }
    }
    // Stream closed — if still running AND no hasMore resume is already
    // pending, treat as an unexpected drop and auto-resume.
    setProgress((p) => {
      if (
        !hasMorePendingRef.current &&
        (p.phase === "discovering" || p.phase === "extracting")
      ) {
        setTimeout(() => setResumeFlag((n) => n + 1), 300);
        return { ...p, phase: "idle", message: "" };
      }
      return p;
    });
  }, [handleEvent]);

  // Auto-resume when stream drops mid-extraction or user returns to page
  useEffect(() => {
    if (resumeFlag === 0 || !url.trim()) return;
    try { sessionStorage.setItem("brand-import-running", projectId); } catch {}
    const timer = setTimeout(() => {
      setProgress((p) => ({ ...p, phase: "extracting", message: "Resuming…" }));
      runStream(url.trim(), projectId, {
        runId: runIdRef.current ?? undefined,
        retryFailed: retryModeRef.current,
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [resumeFlag, url, projectId, runStream]);

  // Warn before reload/navigate-away while extraction is running
  useEffect(() => {
    const isRunningNow = ["discovering", "extracting"].includes(progress.phase);
    if (!isRunningNow) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // required by Chrome/Edge to show the dialog
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [progress.phase]);

  const startExtraction = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    try { new URL(trimmed); } catch { return; }

    readerRef.current?.cancel().catch(() => {});
    setSelected(new Set());
    setAlreadyInProject(new Set());
    setAddResult(null);
    setCategoryResult("");
    setDiagnosticsText("");
    setDiagnosticsError("");
    setDiagnosticsOpen(false);
    setCategoryFilter("all");
    runIdRef.current = null;
    retryModeRef.current = false;
    try { sessionStorage.removeItem("brand-import-run-id"); } catch {}
    setProgress({
      phase: "discovering", message: "Connecting…", processed: 0, added: 0, duplicates: 0, failed: 0,
      total: 0, hasMore: false, truncated: false, brandId: null, brandName: null,
      runId: null, failureDetails: {},
    });

    // Mark extraction as running so we can auto-resume if the user navigates away
    try { sessionStorage.setItem("brand-import-running", projectId); } catch {}
    await runStream(trimmed, projectId);
  }, [url, projectId, runStream]);

  const resumeImport = useCallback(async (retryFailed = false) => {
    const runId = runIdRef.current;
    if (!runId || !url.trim()) return;
    retryModeRef.current = retryFailed;
    try { sessionStorage.setItem("brand-import-running", projectId); } catch {}
    setProgress((p) => ({
      ...p,
      phase: "extracting",
      hasMore: true,
      message: retryFailed ? "Retrying failed product pages…" : "Continuing the saved import…",
    }));
    await runStream(url.trim(), projectId, { runId, retryFailed });
  }, [url, projectId, runStream]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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

  const changeSelectedCategory = async () => {
    const categoryName = categoryEdit.trim();
    if (selected.size === 0 || !categoryName || categorySaving) return;
    const startedAt = performance.now();
    setCategorySaving(true);
    setCategoryResult("");
    try {
      const res = await fetch("/api/brand-catalogue/category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          productIds: [...selected],
          categoryName,
          runId: progress.runId,
          brandName: progress.brandName,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : "Could not update product categories.");

      const selectedIds = new Set(selected);
      setBrandBuckets((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const [brandId, bucket] of Object.entries(prev)) {
          if (!bucket.products.some((product) => selectedIds.has(product.id))) continue;
          next[brandId] = {
            ...bucket,
            products: bucket.products.map((product) => selectedIds.has(product.id)
              ? { ...product, category_name: data.categoryName, category_id: data.categoryId }
              : product),
          };
          changed = true;
        }
        return changed ? next : prev;
      });
      setSelected(new Set());
      setCategoryFilter("all");
      const durationSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
      setCategoryResult(`Updated ${data.updated} product${data.updated === 1 ? "" : "s"} to “${data.categoryName}” in ${durationSeconds}s.`);
    } catch (error) {
      setCategoryResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCategorySaving(false);
    }
  };

  const toggleDiagnostics = async () => {
    if (diagnosticsOpen) {
      setDiagnosticsOpen(false);
      return;
    }
    if (!progress.runId) return;
    setDiagnosticsLoading(true);
    setDiagnosticsError("");
    try {
      const res = await fetch(`/api/brand-catalogue/diagnostics?runId=${encodeURIComponent(progress.runId)}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : "Could not load local diagnostics.");
      const records = Array.isArray(data?.records) ? data.records : [];
      const fileNames = Array.isArray(data?.fileNames) ? data.fileNames.filter((name: unknown): name is string => typeof name === "string") : [];
      const savedFiles = fileNames.map((fileName: string) => `diagnostics/${fileName}`).join(", ");
      setDiagnosticsText(
        `${savedFiles ? `Saved locally: ${savedFiles}\n\n` : ""}${JSON.stringify(records, null, 2)}${data?.truncated ? "\n\nOlder log entries were omitted; showing the most recent records." : ""}`,
      );
      setDiagnosticsOpen(true);
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  const isRunning = progress.phase === "discovering" || progress.phase === "extracting";
  const isDone = progress.phase === "done";
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  // Active brand's products
  const activeBrand = activeBrandId ? brandBuckets[activeBrandId] : null;
  const allProducts = activeBrand?.products ?? [];

  // Category pills
  const categories = Array.from(new Set(allProducts.map((p) => p.category_name).filter(Boolean) as string[])).sort();
  const visibleProducts = categoryFilter === "all" ? allProducts : allProducts.filter((p) => p.category_name === categoryFilter);
  const selectableCount = visibleProducts.filter((p) => !alreadyInProject.has(p.id)).length;

  const selectAll = () => setSelected(new Set(visibleProducts.filter((p) => !alreadyInProject.has(p.id)).map((p) => p.id)));
  const deselectAll = () => setSelected(new Set());

  // Brand tabs (all extracted brands this session)
  const brandIds = Object.keys(brandBuckets);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6 pb-24">
      {/* Header */}
      <div>
        <h1 className="font-serif text-2xl text-foreground">Brand Import</h1>
        <p className="mt-1 text-sm text-muted">
          Paste a brand URL to discover its public catalogue and extract the products found. Results, failures, and continuation status are shown below.
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
        {isRunning ? (
          <button
            onClick={() => {
              readerRef.current?.cancel().catch(() => {});
              readerRef.current = null;
              setProgress((p) => ({ ...p, phase: "idle", message: "" }));
            }}
            className="rounded-full border border-border px-6 py-2.5 text-sm font-medium text-muted transition-colors hover:border-accent/50 hover:text-foreground"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={startExtraction}
            disabled={!url.trim()}
            className="rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            Extract
          </button>
        )}
      </div>
      {!isRunning && progress.runId && progress.hasMore && (
        <button
          onClick={() => resumeImport(false)}
          className="rounded-full border border-border px-4 py-2 text-sm text-foreground transition-colors hover:border-accent/50"
        >
          Continue import
        </button>
      )}

      {/* Progress bar */}
      {(isRunning || isDone || progress.phase === "error") && (
        <div className="rounded-2xl border border-border bg-surface p-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-foreground">{progress.message}</p>
            {progress.total > 0 && (
              <p className="font-serif text-sm text-foreground">
                {progress.processed} <span className="text-muted">/ {progress.total}</span>
              </p>
            )}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-background">
            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          {progress.failed > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <p className="text-xs text-muted">{progress.failed} failed; failures are saved for retry.</p>
              {!isRunning && progress.runId && (
                <button
                  onClick={() => resumeImport(true)}
                  className="text-xs font-medium text-accent hover:underline"
                >
                  Retry failed pages
                </button>
              )}
            </div>
          )}
          {Object.entries(progress.failureDetails).length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-muted">
              {Object.entries(progress.failureDetails).slice(0, 5).map(([failedUrl, reason]) => (
                <li key={failedUrl} className="break-all">
                  <a href={failedUrl} target="_blank" rel="noreferrer" className="underline">{failedUrl}</a>
                  {" — "}{reason}
                </li>
              ))}
            </ul>
          )}
          {progress.truncated && (
            <p className="mt-2 text-xs text-muted">
              Discovery reached a configured product, collection, or sitemap crawl limit; more products may remain. Import a specific public category page to continue discovery.
            </p>
          )}
          {process.env.NODE_ENV !== "production" && progress.runId && (
            <div className="mt-3">
              <button
                type="button"
                onClick={toggleDiagnostics}
                disabled={diagnosticsLoading}
                className="text-xs text-accent underline-offset-2 hover:underline disabled:opacity-50"
              >
                {diagnosticsLoading ? "Loading local diagnostics…" : diagnosticsOpen ? "Hide local diagnostics" : "View local diagnostics"}
              </button>
              {diagnosticsError && <p role="alert" className="mt-2 text-xs text-red-400">{diagnosticsError}</p>}
              {diagnosticsOpen && (
                <pre className="mt-2 max-h-96 overflow-auto rounded-xl border border-border bg-background p-3 text-[10px] leading-relaxed text-muted">
                  {diagnosticsText || "No diagnostic events were recorded for this run."}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add result */}
      {addResult && (
        <div className="rounded-2xl border border-border bg-surface p-4 text-sm">
          {addResult.added > 0 && (
            <p className="text-foreground">Added <strong>{addResult.added}</strong> product{addResult.added !== 1 ? "s" : ""} to your project.</p>
          )}
          {addResult.duplicates > 0 && (
            <p className="text-muted">{addResult.duplicates} already in project (skipped).</p>
          )}
        </div>
      )}

      {/* Brand tabs — only shown when multiple brands extracted */}
      {brandIds.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {brandIds.map((bid) => (
            <button
              key={bid}
              onClick={() => { setActiveBrandId(bid); setCategoryFilter("all"); setSelected(new Set()); }}
              className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                activeBrandId === bid
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border text-muted hover:border-accent/50 hover:text-foreground"
              }`}
            >
              {brandBuckets[bid].name}
              <span className="ml-1.5 text-xs text-muted">({brandBuckets[bid].products.length})</span>
            </button>
          ))}
        </div>
      )}

      {/* Products section */}
      {allProducts.length > 0 && (
        <>
          {/* Brand heading + category filter */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {activeBrand?.name && (
                <span className="font-serif text-base text-foreground">{activeBrand.name}</span>
              )}
              {categories.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => setCategoryFilter("all")}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      categoryFilter === "all" ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    All ({allProducts.length})
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setCategoryFilter(cat)}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        categoryFilter === cat ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
                      }`}
                    >
                      {cat} ({allProducts.filter((p) => p.category_name === cat).length})
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Selection toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <p className="text-sm text-foreground">
                <strong>{selected.size}</strong> selected
                {selectableCount > 0 && <span className="text-muted"> of {selectableCount}</span>}
              </p>
              <button onClick={selectAll} className="text-xs text-muted underline-offset-2 hover:underline">Select all</button>
              <button onClick={deselectAll} className="text-xs text-muted underline-offset-2 hover:underline">None</button>
            </div>
            <button
              onClick={addToProject}
              disabled={selected.size === 0 || adding}
              className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {adding ? "Adding…" : `Add ${selected.size > 0 ? selected.size : ""} to project`}
            </button>
          </div>
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3">
              <label htmlFor="brand-import-category" className="text-xs text-muted">Change category for selection</label>
              <input
                id="brand-import-category"
                list={`brand-import-categories-${activeBrandId ?? "active"}`}
                value={categoryEdit}
                onChange={(event) => setCategoryEdit(event.target.value)}
                placeholder="e.g. armchair, Sommier"
                className="min-w-40 flex-1 rounded-full border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent/60 focus:outline-none"
              />
              <datalist id={`brand-import-categories-${activeBrandId ?? "active"}`}>
                {categories.map((category) => <option key={category} value={category} />)}
              </datalist>
              <button
                type="button"
                onClick={changeSelectedCategory}
                disabled={!categoryEdit.trim() || categorySaving}
                className="rounded-full border border-border px-4 py-2 text-sm text-foreground transition-colors hover:border-accent/50 disabled:opacity-50"
              >
                {categorySaving ? "Updating…" : "Change category"}
              </button>
            </div>
          )}
          {categoryResult && (
            <p
              role={categoryResult.startsWith("Error:") ? "alert" : "status"}
              className={`text-xs ${categoryResult.startsWith("Error:") ? "text-red-400" : "text-muted"}`}
            >
              {categoryResult}
            </p>
          )}

          {/* Grid */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {visibleProducts.map((p) => (
              <MemoCatalogCard
                key={p.id}
                product={p}
                selected={selected.has(p.id)}
                alreadyInProject={alreadyInProject.has(p.id)}
                onToggle={toggleSelect}
              />
            ))}
            {isRunning && Array.from({ length: 4 }).map((_, i) => (
              <div key={`skel-${i}`} className="animate-pulse rounded-2xl border border-border bg-surface">
                <div className="h-48 bg-background sm:h-52" />
                <div className="border-t border-border p-3">
                  <div className="mb-1.5 h-2 w-16 rounded bg-border" />
                  <div className="h-3 w-3/4 rounded bg-border" />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Empty skeleton while discovering */}
      {isRunning && allProducts.length === 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-2xl border border-border bg-surface">
              <div className="h-48 bg-background sm:h-52" />
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
