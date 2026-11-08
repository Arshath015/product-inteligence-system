"use client";

import Link from "next/link";
import { useProject } from "@/components/project/ProjectContext";
import { AppShell } from "@/components/layout/AppShell";

export function ProjectShell({ children }: { children: React.ReactNode }) {
  const { projectId, loading, notFound } = useProject();

  if (loading) {
    return <div className="flex h-screen items-center justify-center bg-background text-sm text-muted">Loading project…</div>;
  }

  if (notFound) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-center">
        <p className="font-serif text-xl text-foreground">Project not found</p>
        <p className="max-w-sm text-sm text-muted">
          This project may have been archived or deleted, or the link is incorrect.
        </p>
        <Link
          href="/"
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover"
        >
          Back to projects
        </Link>
      </div>
    );
  }

  return <AppShell projectId={projectId}>{children}</AppShell>;
}
