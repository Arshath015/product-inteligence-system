"use client";

import { useEffect, useState } from "react";
import { fetchBrands, fetchCategories, fetchProducts } from "@/lib/client/api";
import { CategoryFilterBar } from "@/components/catalog/CategoryFilterBar";
import { ProductGrid } from "@/components/catalog/ProductGrid";
import { AddProductDialog } from "@/components/catalog/AddProductDialog";
import { CopyProductsDialog } from "@/components/project/CopyProductsDialog";
import { useChat } from "@/components/chat/ChatContext";
import { useProject } from "@/components/project/ProjectContext";
import { useCachedList } from "@/components/project/CatalogCacheContext";

export function CatalogueView() {
  const { projectId } = useProject();
  const { catalogVersion, openProduct } = useChat();
  const [category, setCategory] = useState<string | null>(null);
  const [brand, setBrand] = useState("");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showCopy, setShowCopy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => setQDebounced(q), 250);
    return () => clearTimeout(handle);
  }, [q]);

  const { data: categories } = useCachedList(
    `categories:${projectId}`,
    () => fetchCategories(projectId).then((r) => r.categories),
    catalogVersion
  );
  const { data: brands } = useCachedList(
    `brands:${projectId}`,
    () => fetchBrands(projectId).then((r) => r.brands),
    catalogVersion
  );
  const { data: products, loading } = useCachedList(
    `products:${projectId}:${qDebounced}:${category ?? ""}:${brand}`,
    () => fetchProducts(projectId, { q: qDebounced || undefined, category: category || undefined, brand: brand || undefined }).then((r) => r.products),
    catalogVersion
  );

  const toggleSelected = (id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleVisible = () => {
    const visibleIds = (products ?? []).map((product) => product.id);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      const allVisible = visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
      for (const id of visibleIds) {
        if (allVisible) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const downloadPresentation = async () => {
    if (selectedIds.size === 0) return;
    setExporting(true);
    setActionMessage(null);
    try {
      const response = await fetch("/api/presentations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "project", projectId, productIds: [...selectedIds] }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Could not generate the presentation.");
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `altossa-products-${new Date().toISOString().slice(0, 10)}.pptx`;
      link.click();
      URL.revokeObjectURL(href);
      const missingImages = Number(response.headers.get("X-Missing-Images") ?? "0");
      setActionMessage(
        missingImages > 0
          ? `Presentation downloaded; ${missingImages} selected product(s) had no accessible image.`
          : "Presentation downloaded.",
      );
    } catch (error) {
      setActionMessage((error as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-6">
        <div>
          <h1 className="font-serif text-2xl text-foreground">Catalogue</h1>
          <p className="text-sm text-muted">{(products ?? []).length} pieces</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search products…"
            className="w-56 rounded-full border border-border bg-surface px-4 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent"
          />
          <select
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="rounded-full border border-border bg-surface px-4 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-accent"
          >
            <option value="">All brands</option>
            {(brands ?? [])
              .filter((b) => b.product_count > 0)
              .map((b) => (
                <option key={b.id} value={b.slug}>
                  {b.name} ({b.product_count})
                </option>
              ))}
          </select>
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-hover"
          >
            + Add
          </button>
          <button
            onClick={() => {
              setSelecting((value) => !value);
              setSelectedIds(new Set());
              setActionMessage(null);
            }}
            className={`rounded-full border px-4 py-1.5 text-xs transition-colors ${
              selecting ? "border-accent text-accent" : "border-border text-muted hover:text-foreground"
            }`}
          >
            {selecting ? "Exit selection" : "Select products"}
          </button>
        </div>
      </div>

      {selecting && (
        <div className="mx-6 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3">
          <span className="mr-auto text-sm text-foreground">{selectedIds.size} selected</span>
          <button onClick={toggleVisible} className="rounded-full border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground">
            Select visible
          </button>
          <button
            onClick={() => setShowCopy(true)}
            disabled={selectedIds.size === 0}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground disabled:opacity-40"
          >
            Copy to project
          </button>
          <button
            onClick={downloadPresentation}
            disabled={selectedIds.size === 0 || exporting}
            className="rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-40"
          >
            {exporting ? "Generating…" : "Download PPT"}
          </button>
        </div>
      )}
      {actionMessage && <p className="mx-6 mt-3 text-xs text-muted" role="status">{actionMessage}</p>}

      <CategoryFilterBar categories={categories ?? []} active={category} onSelect={setCategory} />

      <ProductGrid
        products={products ?? []}
        loading={loading && !products}
        onOpen={openProduct}
        selecting={selecting}
        selectedIds={selectedIds}
        onToggleSelected={toggleSelected}
      />

      {showAdd && <AddProductDialog onClose={() => setShowAdd(false)} />}
      {showCopy && (
        <CopyProductsDialog
          productIds={[...selectedIds]}
          sourceProjectId={projectId}
          onClose={() => setShowCopy(false)}
          onCopied={(result) => {
            setSelectedIds(new Set());
            setActionMessage(`Copied ${result.added} product(s); ${result.duplicates} duplicate(s) skipped.`);
          }}
        />
      )}
    </div>
  );
}
