import { NextRequest, NextResponse } from "next/server";
import {
  continueLibraryDiscovery,
  getLibraryRun,
  processLibraryBatch,
  startLibraryImport,
} from "@/lib/library";

export const maxDuration = 300;

function runSummary(run: Awaited<ReturnType<typeof getLibraryRun>>) {
  return {
    id: run.id,
    sourceUrl: run.source_url,
    brandName: run.brand_name,
    discovered: run.product_urls.length,
    processed: run.processed_count,
    added: run.added_count,
    duplicates: run.duplicate_count,
    failed: run.failed_count,
    failedUrlCount: run.failed_urls.length,
    discoveryTruncated: run.discovery_truncated,
    hasMore: run.next_index < run.product_urls.length,
    status: run.status,
  };
}

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "Missing runId" }, { status: 400 });
  try {
    return NextResponse.json({ run: runSummary(await getLibraryRun(runId)) });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 404 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const action = body?.action as string | undefined;
  try {
    if (action === "start") {
      if (typeof body?.url !== "string" || !body.url.trim()) {
        return NextResponse.json({ error: "Enter a brand website or product URL." }, { status: 400 });
      }
      const run = await startLibraryImport(body.url.trim());
      const batch = await processLibraryBatch(run.id);
      return NextResponse.json({
        run: runSummary(batch.run),
        batch: {
          added: batch.added,
          duplicates: batch.duplicates,
          failed: batch.failed,
          imageFailures: batch.imageFailures,
          hasMore: batch.hasMore,
        },
      });
    }

    if (typeof body?.runId !== "string") {
      return NextResponse.json({ error: "Missing import run ID." }, { status: 400 });
    }

    if (action === "discover_more") {
      await continueLibraryDiscovery(body.runId);
      const batch = await processLibraryBatch(body.runId);
      return NextResponse.json({
        run: runSummary(batch.run),
        batch: {
          added: batch.added,
          duplicates: batch.duplicates,
          failed: batch.failed,
          imageFailures: batch.imageFailures,
          hasMore: batch.hasMore,
        },
      });
    }

    const batch = await processLibraryBatch(body.runId, { retryFailed: action === "retry_failed" });
    return NextResponse.json({
      run: runSummary(batch.run),
      batch: {
        added: batch.added,
        duplicates: batch.duplicates,
        failed: batch.failed,
        imageFailures: batch.imageFailures,
        hasMore: batch.hasMore,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
