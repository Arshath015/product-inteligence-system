"use client";

import { useState } from "react";
import { createProduct, ingestUrl } from "@/lib/client/api";
import { useChat } from "@/components/chat/ChatContext";

export function AddProductDialog({ onClose }: { onClose: () => void }) {
  const { bumpCatalog } = useChat();
  const [mode, setMode] = useState<"url" | "manual">("url");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", brandName: "", description: "", imageUrl: "", sourceUrl: "" });

  const submitUrl = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await ingestUrl(url.trim());
      setStatus(res.message);
      bumpCatalog();
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitManual = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      await createProduct(form);
      bumpCatalog();
      onClose();
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-surface-raised p-6 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex gap-2">
          <button
            onClick={() => setMode("url")}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              mode === "url" ? "bg-accent text-accent-foreground" : "border border-border text-muted hover:text-foreground"
            }`}
          >
            From URL
          </button>
          <button
            onClick={() => setMode("manual")}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              mode === "manual" ? "bg-accent text-accent-foreground" : "border border-border text-muted hover:text-foreground"
            }`}
          >
            Manual entry
          </button>
        </div>

        {mode === "url" ? (
          <div className="space-y-3">
            <input
              className={inputClass}
              placeholder="https://brand.com/product/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button
              onClick={submitUrl}
              disabled={busy}
              className="w-full rounded-full bg-accent py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Extracting…" : "Add product"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <input
              className={inputClass}
              placeholder="Product name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <input
              className={inputClass}
              placeholder="Brand"
              value={form.brandName}
              onChange={(e) => setForm({ ...form, brandName: e.target.value })}
            />
            <textarea
              className={inputClass}
              placeholder="Description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
            />
            <input
              className={inputClass}
              placeholder="Image URL"
              value={form.imageUrl}
              onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
            />
            <input
              className={inputClass}
              placeholder="Source URL"
              value={form.sourceUrl}
              onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })}
            />
            <button
              onClick={submitManual}
              disabled={busy}
              className="w-full rounded-full bg-accent py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Saving…" : "Add product"}
            </button>
          </div>
        )}

        {status && <p className="mt-3 text-sm text-muted">{status}</p>}
      </div>
    </div>
  );
}
