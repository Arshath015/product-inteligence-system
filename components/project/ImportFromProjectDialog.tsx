"use client";

import { useEffect, useState } from "react";
import {
  fetchBrands,
  fetchCategories,
  fetchInspirations,
  fetchProducts,
  fetchProjects,
  reuseIntoProject,
} from "@/lib/client/api";
import type { Brand, Category, Inspiration, Product, Project } from "@/lib/types";
import { SmartImage } from "@/components/common/SmartImage";

type Tab = "brands" | "products" | "inspiration";

function primaryProductImage(p: Product) {
  const img = p.images?.find((i) => i.is_primary) ?? p.images?.[0];
  return img?.status === "stored" ? img.public_url : null;
}

const thumbFallback = (
  <div className="flex h-full w-full items-center justify-center text-[10px] text-muted">—</div>
);

const PLATFORMS = [
  { slug: "", label: "All platforms" },
  { slug: "pinterest", label: "Pinterest" },
  { slug: "instagram", label: "Instagram" },
  { slug: "manufacturer", label: "Manufacturer" },
  { slug: "brand", label: "Brand" },
  { slug: "other", label: "Other" },
];

export function ImportFromProjectDialog({
  projectId,
  onClose,
  onImported,
}: {
  projectId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [sourceProjects, setSourceProjects] = useState<Project[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [tab, setTab] = useState<Tab>("brands");

  const [sourceBrands, setSourceBrands] = useState<(Brand & { product_count: number })[]>([]);
  const [categories, setCategories] = useState<(Category & { product_count: number })[]>([]);
  const [brandQuery, setBrandQuery] = useState("");
  const [selectedBrandIds, setSelectedBrandIds] = useState<Set<string>>(new Set());

  const [productCategoryFilter, setProductCategoryFilter] = useState("");
  const [productBrandFilter, setProductBrandFilter] = useState("");
  const [productQuery, setProductQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());

  const [platformFilter, setPlatformFilter] = useState("");
  const [inspirationQuery, setInspirationQuery] = useState("");
  const [inspirations, setInspirations] = useState<Inspiration[]>([]);
  const [selectedInspirationIds, setSelectedInspirationIds] = useState<Set<string>>(new Set());

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects("active")
      .then((r) => setSourceProjects(r.projects.filter((p) => p.id !== projectId)))
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- resetting selection/filters on source-project change, not derived render state */
    setSelectedBrandIds(new Set());
    setSelectedProductIds(new Set());
    setSelectedInspirationIds(new Set());
    setProductCategoryFilter("");
    setProductBrandFilter("");
    setPlatformFilter("");
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!sourceId) return;
    fetchBrands(sourceId).then((r) => setSourceBrands(r.brands)).catch(() => {});
    fetchCategories(sourceId).then((r) => setCategories(r.categories)).catch(() => {});
  }, [sourceId]);

  useEffect(() => {
    if (!sourceId || tab !== "brands") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced fetch-on-change needs a loading flag
    setLoading(true);
    const handle = setTimeout(() => {
      fetchBrands(sourceId, brandQuery || undefined)
        .then((r) => setSourceBrands(r.brands))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [sourceId, tab, brandQuery]);

  useEffect(() => {
    if (!sourceId || tab !== "products") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced fetch-on-change needs a loading flag
    setLoading(true);
    const handle = setTimeout(() => {
      fetchProducts(sourceId, {
        q: productQuery || undefined,
        category: productCategoryFilter || undefined,
        brand: productBrandFilter || undefined,
        limit: 120,
      })
        .then((r) => setProducts(r.products))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [sourceId, tab, productQuery, productCategoryFilter, productBrandFilter]);

  useEffect(() => {
    if (!sourceId || tab !== "inspiration") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced fetch-on-change needs a loading flag
    setLoading(true);
    const handle = setTimeout(() => {
      fetchInspirations(sourceId, {
        q: inspirationQuery || undefined,
        platform: platformFilter || undefined,
        limit: 120,
      })
        .then((r) => setInspirations(r.inspirations))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [sourceId, tab, inspirationQuery, platformFilter]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const toggleAll = (set: Set<string>, setter: (s: Set<string>) => void, ids: string[]) => {
    const allSelected = ids.length > 0 && ids.every((id) => set.has(id));
    setter(allSelected ? new Set() : new Set(ids));
  };

  const totalSelected = selectedBrandIds.size + selectedProductIds.size + selectedInspirationIds.size;

  const submit = async () => {
    if (!sourceId || totalSelected === 0) return;
    setBusy(true);
    setError(null);
    try {
      await reuseIntoProject(projectId, {
        sourceProjectId: sourceId,
        brandIds: Array.from(selectedBrandIds),
        productIds: Array.from(selectedProductIds),
        inspirationIds: Array.from(selectedInspirationIds),
      });
      onImported();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-accent";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border p-6 pb-4">
          <h3 className="mb-1 font-serif text-lg text-foreground">Import from another project</h3>
          <p className="mb-4 text-xs text-muted">
            Reference brands, products, or inspiration from another project without copying or modifying them.
          </p>

          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className={`${inputClass} w-full`}
          >
            <option value="">Select a source project…</option>
            {sourceProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.client_name ? ` (${p.client_name})` : ""}
              </option>
            ))}
          </select>

          {sourceId && (
            <div className="mt-4 flex gap-2">
              {(["brands", "products", "inspiration"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${
                    tab === t ? "bg-accent text-accent-foreground" : "border border-border text-muted hover:text-foreground"
                  }`}
                >
                  {t}
                  {t === "brands" && selectedBrandIds.size > 0 ? ` (${selectedBrandIds.size})` : ""}
                  {t === "products" && selectedProductIds.size > 0 ? ` (${selectedProductIds.size})` : ""}
                  {t === "inspiration" && selectedInspirationIds.size > 0 ? ` (${selectedInspirationIds.size})` : ""}
                </button>
              ))}
            </div>
          )}
        </div>

        {!sourceId ? (
          <div className="flex flex-1 items-center justify-center p-10 text-sm text-muted">
            {sourceProjects.length === 0 ? "No other projects to import from yet." : "Pick a project above to browse its data."}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6 pt-4">
            {tab === "brands" && (
              <div className="space-y-3">
                <input
                  value={brandQuery}
                  onChange={(e) => setBrandQuery(e.target.value)}
                  placeholder="Search brands…"
                  className={`${inputClass} w-full`}
                />
                {loading ? (
                  <p className="py-6 text-center text-xs text-muted">Loading…</p>
                ) : sourceBrands.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted">No brands found.</p>
                ) : (
                  <div className="space-y-1">
                    <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-background">
                      <input
                        type="checkbox"
                        checked={sourceBrands.every((b) => selectedBrandIds.has(b.id))}
                        onChange={() =>
                          toggleAll(
                            selectedBrandIds,
                            setSelectedBrandIds,
                            sourceBrands.map((b) => b.id)
                          )
                        }
                        className="accent-accent"
                      />
                      Select all {sourceBrands.length}
                    </label>
                    {sourceBrands.map((b) => (
                      <label
                        key={b.id}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-background"
                      >
                        <input
                          type="checkbox"
                          checked={selectedBrandIds.has(b.id)}
                          onChange={() => toggle(selectedBrandIds, setSelectedBrandIds, b.id)}
                          className="accent-accent"
                        />
                        <span className="flex-1 text-foreground">{b.name}</span>
                        <span className="text-xs text-muted">{b.product_count} products</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === "products" && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <input
                    value={productQuery}
                    onChange={(e) => setProductQuery(e.target.value)}
                    placeholder="Search products…"
                    className={`${inputClass} flex-1`}
                  />
                  <select
                    value={productCategoryFilter}
                    onChange={(e) => setProductCategoryFilter(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">All categories</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.slug}>
                        {c.name} ({c.product_count})
                      </option>
                    ))}
                  </select>
                  <select
                    value={productBrandFilter}
                    onChange={(e) => setProductBrandFilter(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">All brands</option>
                    {sourceBrands.map((b) => (
                      <option key={b.id} value={b.slug}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
                {loading ? (
                  <p className="py-6 text-center text-xs text-muted">Loading…</p>
                ) : products.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted">No products found.</p>
                ) : (
                  <div className="space-y-1">
                    <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-background">
                      <input
                        type="checkbox"
                        checked={products.every((p) => selectedProductIds.has(p.id))}
                        onChange={() =>
                          toggleAll(
                            selectedProductIds,
                            setSelectedProductIds,
                            products.map((p) => p.id)
                          )
                        }
                        className="accent-accent"
                      />
                      Select all {products.length}
                      {productCategoryFilter ? ` in ${productCategoryFilter}` : ""}
                    </label>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {products.map((p) => {
                        const selected = selectedProductIds.has(p.id);
                        return (
                          <label
                            key={p.id}
                            className={`group flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-background transition-colors ${
                              selected ? "border-accent ring-1 ring-accent" : "border-border hover:border-accent/40"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggle(selectedProductIds, setSelectedProductIds, p.id)}
                              className="sr-only"
                            />
                            <div className="relative h-28 w-full overflow-hidden bg-surface sm:h-32">
                              <SmartImage
                                src={primaryProductImage(p)}
                                alt={p.name}
                                className="object-contain p-2"
                                fallback={thumbFallback}
                              />
                              <span
                                className={`absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border text-xs transition-colors ${
                                  selected
                                    ? "border-accent bg-accent text-accent-foreground"
                                    : "border-border bg-surface/90 text-transparent"
                                }`}
                              >
                                ✓
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5 p-2">
                              <span className="line-clamp-2 text-xs text-foreground">{p.name}</span>
                              <span className="truncate text-[11px] text-muted">{p.brand?.name ?? "Unknown brand"}</span>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === "inspiration" && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <input
                    value={inspirationQuery}
                    onChange={(e) => setInspirationQuery(e.target.value)}
                    placeholder="Search inspiration…"
                    className={`${inputClass} flex-1`}
                  />
                  <select
                    value={platformFilter}
                    onChange={(e) => setPlatformFilter(e.target.value)}
                    className={inputClass}
                  >
                    {PLATFORMS.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                {loading ? (
                  <p className="py-6 text-center text-xs text-muted">Loading…</p>
                ) : inspirations.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted">No inspiration found.</p>
                ) : (
                  <div className="space-y-1">
                    <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-background">
                      <input
                        type="checkbox"
                        checked={inspirations.every((i) => selectedInspirationIds.has(i.id))}
                        onChange={() =>
                          toggleAll(
                            selectedInspirationIds,
                            setSelectedInspirationIds,
                            inspirations.map((i) => i.id)
                          )
                        }
                        className="accent-accent"
                      />
                      Select all {inspirations.length}
                    </label>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {inspirations.map((i) => {
                        const selected = selectedInspirationIds.has(i.id);
                        return (
                          <label
                            key={i.id}
                            className={`group flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-background transition-colors ${
                              selected ? "border-accent ring-1 ring-accent" : "border-border hover:border-accent/40"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggle(selectedInspirationIds, setSelectedInspirationIds, i.id)}
                              className="sr-only"
                            />
                            <div className="relative h-28 w-full overflow-hidden bg-surface sm:h-32">
                              <SmartImage
                                src={i.image_status === "stored" ? i.image_public_url : null}
                                alt={i.title ?? "Inspiration"}
                                className="object-contain p-2"
                                fallback={thumbFallback}
                              />
                              <span
                                className={`absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border text-xs transition-colors ${
                                  selected
                                    ? "border-accent bg-accent text-accent-foreground"
                                    : "border-border bg-surface/90 text-transparent"
                                }`}
                              >
                                ✓
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5 p-2">
                              <span className="line-clamp-2 text-xs text-foreground">
                                {i.title ?? "Untitled inspiration"}
                              </span>
                              <span className="truncate text-[11px] capitalize text-muted">{i.platform}</span>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="border-t border-border p-6 pt-4">
          {error && <p className="mb-3 text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={busy || totalSelected === 0}
              className="flex-1 rounded-full bg-accent py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Importing…" : totalSelected > 0 ? `Import ${totalSelected} selected` : "Select items to import"}
            </button>
            <button
              onClick={onClose}
              className="rounded-full border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
