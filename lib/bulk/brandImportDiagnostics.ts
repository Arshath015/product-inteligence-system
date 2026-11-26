import { appendFile, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";

const DIAGNOSTICS_DIRECTORY = join(process.cwd(), "diagnostics");
const MAX_READ_BYTES = 2 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pendingWrites = new Map<string, Promise<void>>();
const runFiles = new Map<string, string>();

export interface BrandImportDiagnostic {
  stage: string;
  outcome?: string;
  brandName?: string;
  productName?: string;
  categoryName?: string | null;
  categoryRouteHint?: string | null;
  url?: string;
  canonicalUrl?: string;
  reason?: string;
  counts?: Record<string, number | boolean>;
  urls?: string[];
}

export function brandImportDiagnosticsEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}

function safeBrandName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "brand";
}

function runTimestamp(): string {
  return new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-") + "Z";
}

async function findRunFileNames(runId: string): Promise<string[]> {
  try {
    const names = await readdir(DIAGNOSTICS_DIRECTORY);
    return names
      .filter((name) => name.endsWith(`_${runId}.jsonl`))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function getRunFileName(runId: string, diagnostic: BrandImportDiagnostic): Promise<string> {
  const knownFile = runFiles.get(runId);
  if (knownFile) return knownFile;

  const existingFiles = await findRunFileNames(runId);
  if (existingFiles.length > 0) {
    runFiles.set(runId, existingFiles[0]);
    return existingFiles[0];
  }

  let brandName = diagnostic.brandName;
  if (!brandName && diagnostic.url) {
    try {
      brandName = new URL(diagnostic.url).hostname.replace(/^www\./, "").split(".")[0];
    } catch {
      brandName = undefined;
    }
  }
  const fileName = `${runTimestamp()}_${safeBrandName(brandName ?? "brand")}_${runId}.jsonl`;
  runFiles.set(runId, fileName);
  return fileName;
}

export async function recordBrandImportDiagnostic(
  runId: string,
  diagnostic: BrandImportDiagnostic,
): Promise<void> {
  if (!brandImportDiagnosticsEnabled() || !UUID_PATTERN.test(runId)) return;

  const record = JSON.stringify({ timestamp: new Date().toISOString(), runId, ...diagnostic }) + "\n";
  const previous = pendingWrites.get(runId) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    const fileName = await getRunFileName(runId, diagnostic);
    await mkdir(DIAGNOSTICS_DIRECTORY, { recursive: true });
    await appendFile(join(DIAGNOSTICS_DIRECTORY, fileName), record, "utf8");
  });
  pendingWrites.set(runId, write);

  try {
    await write;
  } catch (error) {
    console.error(`Could not write local brand-import diagnostics for run ${runId}:`, error);
  } finally {
    if (pendingWrites.get(runId) === write) pendingWrites.delete(runId);
  }
}

export async function readBrandImportDiagnostics(
  runId: string,
): Promise<{ records: unknown[]; truncated: boolean; fileName: string | null; fileNames: string[] }> {
  if (!brandImportDiagnosticsEnabled()) throw new Error("Local diagnostics are available only in development.");
  if (!UUID_PATTERN.test(runId)) throw new Error("Invalid brand import run ID.");

  const fileNames = await findRunFileNames(runId);
  const records: unknown[] = [];
  let truncated = false;
  for (const fileName of fileNames) {
    let handle;
    try {
      handle = await open(join(DIAGNOSTICS_DIRECTORY, fileName), "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    try {
      const { size } = await handle.stat();
      const length = Math.min(size, MAX_READ_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, size - length));
      const lines = buffer.toString("utf8").split("\n");
      if (size > MAX_READ_BYTES) {
        lines.shift();
        truncated = true;
      }
      for (const line of lines) {
        if (!line) continue;
        try {
          records.push(JSON.parse(line) as unknown);
        } catch {
          continue;
        }
      }
    } finally {
      await handle.close();
    }
  }
  return {
    records,
    truncated,
    fileName: fileNames[0] ?? null,
    fileNames,
  };
}
