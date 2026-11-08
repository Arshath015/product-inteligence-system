"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteProject, fetchProjects, updateProject } from "@/lib/client/api";
import type { Project } from "@/lib/types";
import { CreateProjectDialog } from "@/components/project/CreateProjectDialog";

function timeAgo(iso: string | null): string {
  if (!iso) return "No activity yet";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ProjectSelectionScreen() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const { projects } = await fetchProjects(status);
      setProjects(projects);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-change needs a loading flag
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const openProject = (id: string) => router.push(`/p/${id}`);

  const commitRename = async (id: string) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (name) {
      await updateProject(id, { name });
      refresh();
    }
  };

  const archive = async (id: string) => {
    setMenuOpenId(null);
    await updateProject(id, { status: "archived" });
    refresh();
  };

  const unarchive = async (id: string) => {
    setMenuOpenId(null);
    await updateProject(id, { status: "active" });
    refresh();
  };

  const remove = async (project: Project) => {
    setMenuOpenId(null);
    if (!confirm(`Permanently delete "${project.name}"? This can't be undone.`)) return;
    setError(null);
    try {
      await deleteProject(project.id);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="min-h-screen bg-background px-6 py-10 sm:px-10">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-serif text-3xl text-foreground">ALTOSSA</p>
            <p className="mt-1 text-sm text-muted">Select a project, or create a new client workspace.</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-full border border-border p-0.5">
              {(["active", "archived"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${
                    status === s ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover"
            >
              + New Project
            </button>
          </div>
        </div>

        {error && <p className="mb-4 text-sm text-danger">{error}</p>}

        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-40 animate-pulse rounded-2xl bg-surface" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-center text-muted">
            <p className="font-serif text-lg text-foreground">
              {status === "active" ? "No projects yet" : "No archived projects"}
            </p>
            {status === "active" && (
              <p className="max-w-sm text-sm">Create your first client project to start building a catalogue.</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <div
                key={p.id}
                className="group relative flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 transition-colors hover:border-accent/40"
              >
                <div className="flex items-start justify-between gap-2">
                  {renamingId === p.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(p.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(p.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      className="min-w-0 flex-1 rounded border border-accent bg-background px-2 py-1 text-sm text-foreground outline-none"
                    />
                  ) : (
                    <button onClick={() => openProject(p.id)} className="min-w-0 flex-1 text-left">
                      <p className="font-serif text-lg text-foreground">{p.name}</p>
                      {p.client_name && <p className="text-xs text-muted">{p.client_name}</p>}
                    </button>
                  )}
                  <div className="relative flex-shrink-0">
                    <button
                      onClick={() => setMenuOpenId(menuOpenId === p.id ? null : p.id)}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-muted opacity-0 transition-opacity hover:bg-background group-hover:opacity-100"
                    >
                      ⋯
                    </button>
                    {menuOpenId === p.id && (
                      <div className="absolute right-0 top-8 z-10 w-40 overflow-hidden rounded-xl border border-border bg-surface-raised py-1 text-sm shadow-xl shadow-black/40">
                        <button
                          onClick={() => {
                            setMenuOpenId(null);
                            setRenamingId(p.id);
                            setRenameValue(p.name);
                          }}
                          className="block w-full px-3 py-1.5 text-left text-foreground hover:bg-background"
                        >
                          Rename
                        </button>
                        {p.status === "active" ? (
                          <button
                            onClick={() => archive(p.id)}
                            className="block w-full px-3 py-1.5 text-left text-foreground hover:bg-background"
                          >
                            Archive
                          </button>
                        ) : (
                          <button
                            onClick={() => unarchive(p.id)}
                            className="block w-full px-3 py-1.5 text-left text-foreground hover:bg-background"
                          >
                            Unarchive
                          </button>
                        )}
                        <button
                          onClick={() => remove(p)}
                          className="block w-full px-3 py-1.5 text-left text-danger hover:bg-danger/10"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {p.description && <p className="line-clamp-2 text-sm text-muted">{p.description}</p>}

                <div className="mt-auto flex items-center gap-3 text-xs text-muted">
                  <span>{p.stats?.product_count ?? 0} products</span>
                  <span>·</span>
                  <span>{p.stats?.brand_count ?? 0} brands</span>
                  <span>·</span>
                  <span>{p.stats?.inspiration_count ?? 0} inspiration</span>
                </div>
                <p className="text-[11px] text-muted">{timeAgo(p.stats?.last_activity ?? null)}</p>

                <button
                  onClick={() => openProject(p.id)}
                  className="mt-2 rounded-full border border-border px-4 py-1.5 text-xs text-foreground transition-colors hover:border-accent/50"
                >
                  Open →
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateProjectDialog
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            router.push(`/p/${id}`);
          }}
        />
      )}
    </div>
  );
}
