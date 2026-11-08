"use client";

import { useState } from "react";
import type { Product } from "@/lib/types";
import { deleteProduct, updateProduct } from "@/lib/client/api";
import { useChat } from "@/components/chat/ChatContext";
import { SmartImage } from "@/components/common/SmartImage";

const missingFallback = (
  <div className="flex h-full items-center justify-center text-muted">Image unavailable</div>
);

function primaryImage(p: Product) {
  const img = p.images?.find((i) => i.is_primary) ?? p.images?.[0];
  return img?.status === "stored" ? img.public_url : null;
}

const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent";

export function ProductDetailModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const { bumpCatalog } = useChat();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: product.name,
    description: product.description ?? "",
    materials: product.materials ?? "",
    dimensions: product.dimensions ?? "",
    priceText: product.price_text ?? "",
  });
  const [busy, setBusy] = useState(false);
  const img = primaryImage(product);

  const save = async () => {
    setBusy(true);
    try {
      await updateProduct(product.id, form);
      bumpCatalog();
      setEditing(false);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      await updateProduct(product.id, { status: "archived" });
      bumpCatalog();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${product.name}"? This can't be undone.`)) return;
    setBusy(true);
    try {
      await deleteProduct(product.id);
      bumpCatalog();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-surface-raised shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative h-80 w-full bg-background sm:h-96">
          <SmartImage src={img} alt={product.name} className="object-contain p-4" fallback={missingFallback} />
          <button
            onClick={onClose}
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface/90 text-sm text-foreground transition-colors hover:border-accent/50"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 p-6">
          {editing ? (
            <div className="space-y-3">
              <input
                className={inputClass}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Name"
              />
              <textarea
                className={inputClass}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Description"
                rows={3}
              />
              <input
                className={inputClass}
                value={form.materials}
                onChange={(e) => setForm({ ...form, materials: e.target.value })}
                placeholder="Materials"
              />
              <input
                className={inputClass}
                value={form.dimensions}
                onChange={(e) => setForm({ ...form, dimensions: e.target.value })}
                placeholder="Dimensions"
              />
              <input
                className={inputClass}
                value={form.priceText}
                onChange={(e) => setForm({ ...form, priceText: e.target.value })}
                placeholder="Price"
              />
              <div className="flex gap-2">
                <button
                  onClick={save}
                  disabled={busy}
                  className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="rounded-full border border-border px-4 py-1.5 text-xs text-muted hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted">{product.brand?.name ?? "Unknown brand"}</p>
                <h2 className="font-serif text-2xl text-foreground">{product.name}</h2>
                {product.designer?.name && <p className="text-sm text-muted">Designed by {product.designer.name}</p>}
              </div>

              {product.description && (
                <p className="text-sm leading-relaxed text-foreground/90">{product.description}</p>
              )}

              <dl className="grid grid-cols-2 gap-3 text-sm">
                {product.category?.name && (
                  <div>
                    <dt className="text-xs text-muted">Category</dt>
                    <dd className="text-foreground">{product.category.name}</dd>
                  </div>
                )}
                {product.materials && (
                  <div>
                    <dt className="text-xs text-muted">Materials</dt>
                    <dd className="text-foreground">{product.materials}</dd>
                  </div>
                )}
                {product.dimensions && (
                  <div>
                    <dt className="text-xs text-muted">Dimensions</dt>
                    <dd className="text-foreground">{product.dimensions}</dd>
                  </div>
                )}
                {product.price_text && (
                  <div>
                    <dt className="text-xs text-muted">Price</dt>
                    <dd className="text-foreground">{product.price_text}</dd>
                  </div>
                )}
              </dl>

              {product.source_url && (
                <a
                  href={product.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-sm text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
                >
                  View original source →
                </a>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => setEditing(true)}
                  className="rounded-full border border-border px-4 py-1.5 text-xs text-muted hover:border-accent/50 hover:text-foreground"
                >
                  Edit
                </button>
                <button
                  onClick={archive}
                  disabled={busy}
                  className="rounded-full border border-border px-4 py-1.5 text-xs text-muted hover:border-accent/50 hover:text-foreground"
                >
                  Archive
                </button>
                <button
                  onClick={remove}
                  disabled={busy}
                  className="rounded-full border border-danger/40 px-4 py-1.5 text-xs text-danger hover:bg-danger/10"
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
