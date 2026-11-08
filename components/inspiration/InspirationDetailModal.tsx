"use client";

import { useState } from "react";
import type { Inspiration } from "@/lib/types";
import { deleteInspiration, updateInspiration } from "@/lib/client/api";
import { useProject } from "@/components/project/ProjectContext";
import { SmartImage } from "@/components/common/SmartImage";

const missingFallback = (
  <div className="flex h-full items-center justify-center text-muted">No preview available</div>
);

export function InspirationDetailModal({
  item,
  onClose,
  onChanged,
}: {
  item: Inspiration;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { projectId } = useProject();
  const [busy, setBusy] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const img = item.image_status === "stored" ? item.image_public_url : null;

  const addTag = async () => {
    const tag = tagInput.trim();
    if (!tag || item.tags.includes(tag)) return;
    setBusy(true);
    try {
      await updateInspiration(projectId, item.id, { tags: [...item.tags, tag] });
      setTagInput("");
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const removeTag = async (tag: string) => {
    setBusy(true);
    try {
      await updateInspiration(projectId, item.id, { tags: item.tags.filter((t) => t !== tag) });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm("Delete this inspiration? This can't be undone.")) return;
    setBusy(true);
    try {
      await deleteInspiration(projectId, item.id);
      onChanged();
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
          <SmartImage
            src={img}
            alt={item.title ?? "Inspiration"}
            className="object-contain p-4"
            fallback={missingFallback}
          />
          <button
            onClick={onClose}
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface/90 text-sm text-foreground transition-colors hover:border-accent/50"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">{item.platform}</p>
            <h2 className="font-serif text-2xl text-foreground">{item.title ?? "Untitled inspiration"}</h2>
          </div>

          {item.description && <p className="text-sm leading-relaxed text-foreground/90">{item.description}</p>}
          {item.caption && item.caption !== item.description && (
            <p className="text-sm italic leading-relaxed text-muted">&ldquo;{item.caption}&rdquo;</p>
          )}

          <div>
            <p className="mb-1.5 text-xs text-muted">Tags</p>
            <div className="flex flex-wrap items-center gap-2">
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-foreground"
                >
                  {tag}
                  <button onClick={() => removeTag(tag)} className="text-muted hover:text-danger">
                    ✕
                  </button>
                </span>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder="Add tag…"
                className="w-24 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground outline-none focus:border-accent"
              />
            </div>
          </div>

          <a
            href={item.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block break-all text-sm text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            View original on {item.platform} →
          </a>

          <div className="flex gap-2 pt-2">
            <button
              onClick={remove}
              disabled={busy}
              className="rounded-full border border-danger/40 px-4 py-1.5 text-xs text-danger hover:bg-danger/10"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
