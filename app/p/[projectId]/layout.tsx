import { ProjectProvider } from "@/components/project/ProjectContext";
import { ProjectShell } from "@/components/project/ProjectShell";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <ProjectProvider projectId={projectId}>
      <ProjectShell key={projectId}>{children}</ProjectShell>
    </ProjectProvider>
  );
}
