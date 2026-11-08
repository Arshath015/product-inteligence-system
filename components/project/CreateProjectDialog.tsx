"use client";

import { useEffect, useState } from "react";
import { createProject, fetchProjects, reuseIntoProject } from "@/lib/client/api";
import type { Project } from "@/lib/types";

const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent";

export function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [existingProjects, setExistingProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [clientName, setClientName] = useState("");
  const [description, setDescription] = useState("");
  const [reuseEnabled, setReuseEnabled] = useState(false);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [reuseProducts, setReuseProducts] = useState(true);
  const [reuseBrands, setReuseBrands] = useState(true);
  const [reuseInspiration, setReuseInspiration] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects("active").then((r) => setExistingProjects(r.projects)).catch(() => {});
  }, []);

  const toggleSource = (id: string) => {
    setSourceIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await createProject({
        name: name.trim(),
        clientName: clientName.trim() || undefined,
        description: description.trim() || undefined,
      });

      if (reuseEnabled && sourceIds.length > 0 && (reuseProducts || reuseBrands || reuseInspiration)) {
        for (const sourceProjectId of sourceIds) {
          await reuseIntoProject(project.id, {
            sourceProjectId,
            allProducts: reuseProducts,
            allBrands: reuseBrands,
            allInspirations: reuseInspiration,
          });
        }
      }

      onCreated(project.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface-raised p-6 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 font-serif text-lg text-foreground">New project</h3>

        <div className="space-y-3">
          <input
            className={inputClass}
            placeholder="Project name *"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className={inputClass}
            placeholder="Client name (optional)"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
          />
          <textarea
            className={inputClass}
            placeholder="Description (optional)"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={reuseEnabled}
              onChange={(e) => setReuseEnabled(e.target.checked)}
              className="accent-accent"
            />
            Use existing project data
          </label>

          {reuseEnabled && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted">
                Reference brands/products/inspiration from other projects without copying or modifying them.
                Removing a reference later never affects the source project.
              </p>

              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                {existingProjects.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted">No other projects yet.</p>
                ) : (
                  existingProjects.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-background">
                      <input
                        type="checkbox"
                        checked={sourceIds.includes(p.id)}
                        onChange={() => toggleSource(p.id)}
                        className="accent-accent"
                      />
                      <span className="text-foreground">{p.name}</span>
                      {p.client_name && <span className="text-xs text-muted">({p.client_name})</span>}
                    </label>
                  ))
                )}
              </div>

              <div className="flex gap-4 text-sm text-foreground">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={reuseBrands}
                    onChange={(e) => setReuseBrands(e.target.checked)}
                    className="accent-accent"
                  />
                  Brands
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={reuseProducts}
                    onChange={(e) => setReuseProducts(e.target.checked)}
                    className="accent-accent"
                  />
                  Products
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={reuseInspiration}
                    onChange={(e) => setReuseInspiration(e.target.checked)}
                    className="accent-accent"
                  />
                  Inspiration
                </label>
              </div>
            </div>
          )}
        </div>

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button
            onClick={submit}
            disabled={busy || !name.trim()}
            className="flex-1 rounded-full bg-accent py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create project"}
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
  );
}
