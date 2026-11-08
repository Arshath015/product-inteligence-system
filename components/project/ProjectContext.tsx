"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { fetchProject } from "@/lib/client/api";
import type { Project } from "@/lib/types";

interface ProjectContextValue {
  projectId: string;
  project: Project | null;
  loading: boolean;
  notFound: boolean;
  refreshProject: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const refreshProject = useCallback(async () => {
    try {
      const { project } = await fetchProject(projectId);
      setProject(project);
      setNotFound(false);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-change needs a loading flag
    setLoading(true);
    refreshProject();
  }, [refreshProject]);

  return (
    <ProjectContext.Provider value={{ projectId, project, loading, notFound, refreshProject }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used within ProjectProvider");
  return ctx;
}
