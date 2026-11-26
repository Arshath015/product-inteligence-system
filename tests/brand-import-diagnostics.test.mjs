import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  readBrandImportDiagnostics,
  recordBrandImportDiagnostic,
} from "../lib/bulk/brandImportDiagnostics.ts";

test("stores local crawl diagnostics in a timestamped, brand-named file", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const runId = randomUUID();
  const directory = join(process.cwd(), "diagnostics");
  process.env.NODE_ENV = "development";

  try {
    await recordBrandImportDiagnostic(runId, {
      stage: "test",
      outcome: "written",
      brandName: "Test Brand",
    });

    const fileName = (await readdir(directory)).find((name) => name.endsWith(`_${runId}.jsonl`));
    assert.ok(fileName);
    assert.match(fileName, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}Z_test-brand_/);
    const continuedTimestamp = new Date(Date.now() + 1000).toISOString();
    const continuedFileTimestamp = continuedTimestamp.slice(0, 19).replace("T", "_").replace(/:/g, "-") + "Z";
    const continuedFileName = `${continuedFileTimestamp}_test-brand_${runId}.jsonl`;
    await appendFile(join(directory, continuedFileName), JSON.stringify({
      timestamp: continuedTimestamp,
      runId,
      stage: "continued",
    }) + "\n", "utf8");

    const diagnostics = await readBrandImportDiagnostics(runId);
    assert.ok(diagnostics.fileNames.includes(fileName));
    assert.ok(diagnostics.fileNames.includes(continuedFileName));
    assert.equal(diagnostics.records.length, 2);
    const record = diagnostics.records[0];
    assert.equal(record.runId, runId);
    assert.equal(record.brandName, "Test Brand");
    assert.equal(record.stage, "test");
    const stageNames = diagnostics.records.map((entry) => entry.stage).sort();
    assert.deepEqual(stageNames, ["continued", "test"]);
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    let files = [];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const fileName of files.filter((name) => name.endsWith(`_${runId}.jsonl`))) {
      await unlink(join(directory, fileName));
    }
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
