"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SmartImage } from "@/components/common/SmartImage";
import { CopyProductsDialog } from "@/components/project/CopyProductsDialog";

type LibraryProduct = {
  id: string;
  name: string;
  brand_name: string | null;
  source_url: string;
  description: string | null;
  images: string[];
  primary_image_url: string | null;
  image_public_url: string | null;
  category_name: string | null;
  extracted_at: string;
};

type ImportRun = {
  id: string;
  brandName: string | null;
  discovered: number;
  processed: number;
  added: number;
  duplicates: number;
  failed: number;
  failedUrlCount: number;
  discoveryTruncated: boolean;
  hasMore: boolean;
  status: string;
};

const PAGE_SIZE = 60;
const MAX_DISCOVERED_PRODUCTS = 5000;
const missingImage = <div className="flex h-full items-center justify-center text-xs text-muted">Image unavailable</div>;

export function LibraryView() {
  const [products, setProducts] = useState<LibraryProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [brands, setBrands] = useState<string[]>([]);
  const [categories, setCategories] = useState<{ name: string; slug: string }[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showCopy, setShowCopy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (brand) params.set("brand", brand);
    if (category) params.set("category", category);
    fetch(`/api/library?${params}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load the Library.");
        if (!active) return;
        setError(null);
        setProducts(data.products);
        setTotal(data.total);
        setBrands(data.brands);
        setCategories(data.categories);
      })
      .catch((cause) => { if (active) setError((cause as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [debouncedQuery, brand, category]);

  useEffect(() => {
    const savedRunId = sessionStorage.getItem("altossa-library-run");
    if (!savedRunId) return;
    fetch(`/api/library/import?runId=${encodeURIComponent(savedRunId)}`)
      .then(async (response) => {
        const data = await response.json();
        if (response.ok) setRun(data.run);
        else sessionStorage.removeItem("altossa-library-run");
      })
      .catch(() => {});
  }, []);

  const refreshProducts = async () => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (brand) params.set("brand", brand);
    if (category) params.set("category", category);
    const response = await fetch(`/api/library?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not refresh the Library.");
    setProducts(data.products);
    setTotal(data.total);
    setBrands(data.brands);
    setCategories(data.categories);
  };

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(products.length) });
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (brand) params.set("brand", brand);
      if (category) params.set("category", category);
      const response = await fetch(`/api/library?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load more products.");
      setProducts((current) => [...current, ...data.products]);
      setTotal(data.total);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const submitImport = async (action: "start" | "process" | "retry_failed" | "discover_more") => {
    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/library/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "start" ? { action, url } : { action, runId: run?.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Library import failed.");
      setRun(data.run);
      sessionStorage.setItem("altossa-library-run", data.run.id);
      const batch = data.batch;
      setMessage(
        `Discovered ${data.run.discovered}; processed ${batch.added + batch.duplicates + batch.failed} this batch; added ${batch.added}, duplicates ${batch.duplicates}, failed ${batch.failed}.` +
        (batch.imageFailures ? ` Images unavailable for ${batch.imageFailures} product(s).` : ""),
      );
      if (action === "start") setUrl("");
      await refreshProducts();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const continueRun = () => {
    if (!run) return;
    if (run.hasMore) void submitImport("process");
    else if (run.discoveryTruncated && run.discovered < MAX_DISCOVERED_PRODUCTS) void submitImport("discover_more");
    else if (run.failedUrlCount > 0) void submitImport("retry_failed");
  };

  const toggleProduct = (id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleVisible = () => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      const visibleIds = products.map((product) => product.id);
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
      for (const id of visibleIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const downloadPresentation = async () => {
    if (selectedIds.size === 0) return;
    setExporting(true);
    setError(null);
    try {
      const response = await fetch("/api/presentations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "library", productIds: [...selectedIds] }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Could not generate the presentation.");
      }
      const href = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = href;
      link.download = `altossa-products-${new Date().toISOString().slice(0, 10)}.pptx`;
      link.click();
      URL.revokeObjectURL(href);
      const missingImages = Number(response.headers.get("X-Missing-Images") ?? "0");
      setMessage(missingImages ? `Presentation downloaded; ${missingImages} product(s) had no accessible image.` : "Presentation downloaded.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="min-h-full">
      <header className="border-b border-border bg-background px-6 py-6 sm:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <Link href="/" className="text-xs uppercase tracking-[0.16em] text-muted hover:text-foreground">← Projects</Link>
              <p className="text-xs uppercase tracking-[0.2em] text-accent">ALTOSSA / Global collection</p>
              <h1 className="mt-1 font-serif text-3xl text-foreground">Library</h1>
              <p className="mt-1 text-sm text-muted">{total} products shared across your projects</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search products…"
                aria-label="Search Library products"
                className="w-56 rounded-full border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none focus:border-accent"
              />
              <select value={brand} onChange={(event) => setBrand(event.target.value)} aria-label="Filter by brand" className="rounded-full border border-border bg-surface px-4 py-2 text-sm text-foreground">
                <option value="">All brands</option>
                {brands.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter by category" className="rounded-full border border-border bg-surface px-4 py-2 text-sm text-foreground">
                <option value="">All categories</option>
                {categories.map((item) => <option key={item.slug} value={item.name}>{item.name}</option>)}
              </select>
              <button
                onClick={() => {
                  setSelectionMode((current) => !current);
                  setSelectedIds(new Set());
                }}
                className="rounded-full border border-border px-4 py-2 text-xs text-muted hover:text-foreground"
              >
                {selectionMode ? "Exit selection" : "Select products"}
              </button>
            </div>
          </div>

          <form
            className="mt-5 flex flex-wrap gap-2"
            onSubmit={(event) => { event.preventDefault(); void submitImport("start"); }}
          >
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="Paste a brand website or individual product URL"
              aria-label="Brand or product URL"
              className="min-w-[280px] flex-1 rounded-full border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none focus:border-accent"
              type="text"
              required
            />
            <button disabled={importing} className="rounded-full bg-accent px-5 py-2 text-xs font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-50">
              {importing ? "Discovering…" : "Add to Library"}
            </button>
          </form>

          {run && (run.hasMore || run.discoveryTruncated || run.failedUrlCount > 0) && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
              <p className="mr-auto text-sm text-muted">
                {run.brandName}: {run.discovered} discovered, {run.processed} processed, {run.added} added, {run.duplicates} duplicates, {run.failed} failed.
              </p>
              {(run.hasMore || (run.discoveryTruncated && run.discovered < MAX_DISCOVERED_PRODUCTS) || run.failedUrlCount > 0) && (
                <button onClick={continueRun} disabled={importing} className="rounded-full border border-accent px-4 py-1.5 text-xs text-accent hover:bg-accent/10 disabled:opacity-50">
                  {importing ? "Working…" : run.hasMore ? "Continue extraction" : run.discoveryTruncated && run.discovered < MAX_DISCOVERED_PRODUCTS ? "Discover more products" : "Retry failed products"}
                </button>
              )}
            </div>
          )}
          {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
          {message && <p className="mt-3 text-sm text-muted" role="status">{message}</p>}
          {run?.discoveryTruncated && !run.hasMore && (
            <p className="mt-2 text-xs text-muted">
              {run.discovered >= MAX_DISCOVERED_PRODUCTS
                ? "The 5,000-product safety limit is reached. Start another import from a specific category to continue safely."
                : "The site has more catalogue pages to scan; continue discovery to extend this import."}
            </p>
          )}
        </div>
      </header>

      {selectionMode && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-surface/95 px-6 py-3 backdrop-blur sm:px-8">
          <span className="mr-auto text-sm text-foreground">{selectedIds.size} selected</span>
          <button onClick={toggleVisible} className="rounded-full border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground">Select visible</button>
          <button onClick={() => setShowCopy(true)} disabled={!selectedIds.size} className="rounded-full border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground disabled:opacity-40">Copy to project</button>
          <button onClick={downloadPresentation} disabled={!selectedIds.size || exporting} className="rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-40">
            {exporting ? "Generating…" : "Download PPT"}
          </button>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }, (_, index) => <div key={index} className="aspect-[4/5] animate-pulse rounded-2xl bg-surface" />)}
        </div>
      ) : products.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-24 text-center text-muted">
          <p className="font-serif text-lg text-foreground">Your Library is ready</p>
          <p className="max-w-md text-sm">Add a brand website to discover its catalogue, or paste a product link to add one item.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {products.map((product) => {
            const image = product.image_public_url || product.primary_image_url || product.images?.[0] || null;
            const selected = selectedIds.has(product.id);
            return (
              <article key={product.id} className={`group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-surface transition-all ${selected ? "border-accent shadow-lg shadow-accent/10" : "border-border hover:border-accent/40"}`}>
                <a href={product.source_url} target="_blank" rel="noopener noreferrer" className="flex min-h-0 flex-1 flex-col" title="Open original product page">
                  <div className="relative h-56 w-full overflow-hidden bg-background sm:h-64">
                    <SmartImage src={image} alt={product.name} className="object-contain p-3 transition-transform duration-300 group-hover:scale-[1.04]" fallback={missingImage} />
                  </div>
                  <div className="flex flex-1 flex-col gap-1 border-t border-border p-3.5">
                    <p className="truncate text-[11px] uppercase tracking-wide text-muted">{product.brand_name || "Unknown brand"}</p>
                    <p className="line-clamp-2 font-serif text-[15px] leading-snug text-foreground">{product.name}</p>
                    {product.category_name && <p className="text-xs text-muted">{product.category_name}</p>}
                  </div>
                </a>
                {selectionMode && (
                  <label className="absolute right-3 top-3 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-border bg-surface/95 shadow">
                    <input type="checkbox" checked={selected} onChange={() => toggleProduct(product.id)} aria-label={`Select ${product.name}`} className="h-4 w-4 accent-[var(--accent)]" />
                  </label>
                )}
              </article>
            );
          })}
        </div>
      )}

      {!loading && products.length < total && (
        <div className="flex justify-center pb-8">
          <button onClick={loadMore} disabled={loadingMore} className="rounded-full border border-border px-5 py-2 text-xs text-muted hover:text-foreground disabled:opacity-50">
            {loadingMore ? "Loading…" : `Load more (${products.length} of ${total})`}
          </button>
        </div>
      )}

      {showCopy && (
        <CopyProductsDialog
          productIds={[...selectedIds]}
          onClose={() => setShowCopy(false)}
          onCopied={(result) => {
            setSelectedIds(new Set());
            setMessage(`Copied ${result.added} product(s); ${result.duplicates} duplicate(s) skipped.`);
          }}
        />
      )}
    </div>
  );
}
