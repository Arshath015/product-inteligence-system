import { NextRequest, NextResponse } from "next/server";
import { readBrandImportDiagnostics } from "@/lib/bulk/brandImportDiagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const runId = req.nextUrl.searchParams.get("runId") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    return NextResponse.json({ error: "Invalid brand import run ID." }, { status: 400 });
  }

  try {
    const diagnostics = await readBrandImportDiagnostics(runId);
    return NextResponse.json({ runId, ...diagnostics }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not read local brand-import diagnostics for run ${runId}:`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
