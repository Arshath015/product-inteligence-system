import { NextRequest, NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/projects";
import { reuseFromProject } from "@/lib/projects";

export async function GET(req: NextRequest) {
  const status = (req.nextUrl.searchParams.get("status") as "active" | "archived") ?? "active";
  const projects = await listProjects(status);
  return NextResponse.json({ projects });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.name || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "Project name is required" }, { status: 400 });
  }

  const project = await createProject({
    name: body.name.trim(),
    clientName: body.clientName ?? null,
    description: body.description ?? null,
  });

  if (body.reuse && body.reuse.sourceProjectId) {
    await reuseFromProject(project.id, {
      sourceProjectId: body.reuse.sourceProjectId,
      allProducts: Boolean(body.reuse.allProducts),
      allBrands: Boolean(body.reuse.allBrands),
      allInspirations: Boolean(body.reuse.allInspirations),
      productIds: Array.isArray(body.reuse.productIds) ? body.reuse.productIds : undefined,
      brandIds: Array.isArray(body.reuse.brandIds) ? body.reuse.brandIds : undefined,
      inspirationIds: Array.isArray(body.reuse.inspirationIds) ? body.reuse.inspirationIds : undefined,
    });
  }

  return NextResponse.json({ project }, { status: 201 });
}
