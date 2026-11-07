"use client";

import Image from "next/image";
import { useState } from "react";
import type { Product } from "@/lib/types";
import { deleteProduct, updateProduct } from "@/lib/client/api";
import { useChat } from "@/components/chat/ChatContext";

function primaryImage(p: Product) {
  const img = p.images?.find((i) => i.is_primary) ?? p.images?.[0];
  return img?.status === "stored" ? img.public_url : null;
}

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative aspect-[16/10] w-full bg-background">
          {img ? (
            <Image src={img} alt={product.name} fill unoptimized className="object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-muted">Image unavailable</div>
          )}
          <button
            onClick={onClose}
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-background/90 text-sm"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 p-6">
          {editing ? (
            <div className="space-y-3">
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Name"
              />
              <textarea
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Description"
                rows={3}
              />
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={form.materials}
                onChange={(e) => setForm({ ...form, materials: e.target.value })}
                placeholder="Materials"
              />
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={form.dimensions}
                onChange={(e) => setForm({ ...form, dimensions: e.target.value })}
                placeholder="Dimensions"
              />
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={form.priceText}
                onChange={(e) => setForm({ ...form, priceText: e.target.value })}
                placeholder="Price"
              />
              <div className="flex gap-2">
                <button
                  onClick={save}
                  disabled={busy}
                  className="rounded-full bg-foreground px-4 py-1.5 text-xs text-background disabled:opacity-50"
                >
                  Save
                </button>
                <button onClick={() => setEditing(false)} className="rounded-full border border-border px-4 py-1.5 text-xs">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted">{product.brand?.name ?? "Unknown brand"}</p>
                <h2 className="font-serif text-2xl">{product.name}</h2>
                {product.designer?.name && <p className="text-sm text-muted">Designed by {product.designer.name}</p>}
              </div>

              {product.description && <p className="text-sm leading-relaxed">{product.description}</p>}

              <dl className="grid grid-cols-2 gap-3 text-sm">
                {product.category?.name && (
                  <div>
                    <dt className="text-xs text-muted">Category</dt>
                    <dd>{product.category.name}</dd>
                  </div>
                )}
                {product.materials && (
                  <div>
                    <dt className="text-xs text-muted">Materials</dt>
                    <dd>{product.materials}</dd>
                  </div>
                )}
                {product.dimensions && (
                  <div>
                    <dt className="text-xs text-muted">Dimensions</dt>
                    <dd>{product.dimensions}</dd>
                  </div>
                )}
                {product.price_text && (
                  <div>
                    <dt className="text-xs text-muted">Price</dt>
                    <dd>{product.price_text}</dd>
                  </div>
                )}
              </dl>

              {product.source_url && (
                <a
                  href={product.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-sm underline underline-offset-2"
                >
                  View original source →
                </a>
              )}

              <div className="flex gap-2 pt-2">
                <button onClick={() => setEditing(true)} className="rounded-full border border-border px-4 py-1.5 text-xs">
                  Edit
                </button>
                <button onClick={archive} disabled={busy} className="rounded-full border border-border px-4 py-1.5 text-xs">
                  Archive
                </button>
                <button
                  onClick={remove}
                  disabled={busy}
                  className="rounded-full border border-red-200 px-4 py-1.5 text-xs text-red-600"
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
