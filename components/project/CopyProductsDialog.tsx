"use client";

import { useEffect, useState } from "react";
import { createProject, fetchProjects } from "@/lib/client/api";
import type { Project } from "@/lib/types";

export function CopyProductsDialog({
  productIds,
  sourceProjectId,
  onClose,
  onCopied,
}: {
  productIds: string[];
  sourceProjectId?: string;
  onClose: () => void;
  onCopied: (result: { added: number; duplicates: number }) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [targetId, setTargetId] = useState("");
  const [newProject, setNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects("active")
      .then((result) => setProjects(result.projects.filter((project) => project.id !== sourceProjectId)))
      .catch((err) => setError((err as Error).message));
  }, [sourceProjectId]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let projectId = targetId;
      if (newProject) {
        if (!newProjectName.trim()) throw new Error("Enter a name for the new project.");
        const result = await createProject({ name: newProjectName.trim() });
        projectId = result.project.id;
      }
      if (!projectId) throw new Error("Choose an existing project or create a new one.");

      const endpoint = sourceProjectId ? "/api/products/copy" : "/api/library/copy";
      const payload = sourceProjectId
        ? { targetProjectId: projectId, sourceProjectId, productIds }
        : { projectId, productIds };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not copy the selected products.");
      onCopied({ added: result.added, duplicates: result.duplicates });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-surface-raised p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="font-serif text-xl text-foreground">Copy {productIds.length} selected product{productIds.length === 1 ? "" : "s"}</h2>
        <p className="mt-1 text-sm text-muted">Product details and stored images are copied into the destination project.</p>

        <label className="mt-5 flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={newProject} onChange={(event) => setNewProject(event.target.checked)} />
          Create a new project
        </label>
        {newProject ? (
          <input
            autoFocus
            className={`${inputClass} mt-3`}
            value={newProjectName}
            onChange={(event) => setNewProjectName(event.target.value)}
            placeholder="Project name"
          />
        ) : (
          <select className={`${inputClass} mt-3`} value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            <option value="">Choose a project…</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}{project.client_name ? ` (${project.client_name})` : ""}
              </option>
            ))}
          </select>
        )}

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-full border border-border px-4 py-2 text-xs text-muted hover:text-foreground">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || (!newProject && !targetId)}
            className="rounded-full bg-accent px-4 py-2 text-xs font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Copying…" : "Copy products"}
          </button>
        </div>
      </div>
    </div>
  );
}
