"use client";

import { useState } from "react";
import { saveInspirationLink } from "@/lib/client/api";

export function AddInspirationDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const submit = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await saveInspirationLink(url.trim());
      setStatus(res.message);
      onSaved();
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-surface-raised p-6 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 font-serif text-lg text-foreground">Save inspiration</h3>
        <p className="mb-4 text-xs text-muted">Pinterest pins, Instagram posts, or any design reference link.</p>
        <input
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
          placeholder="https://pinterest.com/pin/... or instagram.com/p/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          onClick={submit}
          disabled={busy}
          className="mt-3 w-full rounded-full bg-accent py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {status && <p className="mt-3 text-sm text-muted">{status}</p>}
      </div>
    </div>
  );
}
