import { appendFile, mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIAGNOSTICS_DIRECTORY = join(tmpdir(), "altossa-brand-import-diagnostics");
const MAX_READ_BYTES = 2 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pendingWrites = new Map<string, Promise<void>>();

export interface BrandImportDiagnostic {
  stage: string;
  outcome?: string;
  url?: string;
  reason?: string;
  counts?: Record<string, number | boolean>;
  urls?: string[];
}

export function brandImportDiagnosticsEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}

export async function recordBrandImportDiagnostic(
  runId: string,
  diagnostic: BrandImportDiagnostic,
): Promise<void> {
  if (!brandImportDiagnosticsEnabled() || !UUID_PATTERN.test(runId)) return;

  const record = JSON.stringify({ timestamp: new Date().toISOString(), ...diagnostic }) + "\n";
  const previous = pendingWrites.get(runId) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    await mkdir(DIAGNOSTICS_DIRECTORY, { recursive: true });
    await appendFile(join(DIAGNOSTICS_DIRECTORY, `${runId}.jsonl`), record, "utf8");
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
): Promise<{ records: unknown[]; truncated: boolean }> {
  if (!brandImportDiagnosticsEnabled()) throw new Error("Local diagnostics are available only in development.");
  if (!UUID_PATTERN.test(runId)) throw new Error("Invalid brand import run ID.");

  const file = join(DIAGNOSTICS_DIRECTORY, `${runId}.jsonl`);
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], truncated: false };
    throw error;
  }

  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    if (size > MAX_READ_BYTES) lines.shift();
    const records = lines.filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
    return { records, truncated: size > MAX_READ_BYTES };
  } finally {
    await handle.close();
  }
}
