import assert from "node:assert/strict";
import test from "node:test";
import { refineCategoryHint } from "../lib/productCategory.ts";

test("uses localized product route category when the product has no category hint", () => {
  assert.equal(
    refineCategoryHint("other", "Daily", ["https://example.com/it/prodotti/divani/daily/"]),
    "sofas",
  );
});

test("preserves a specific category supplied by structured product data", () => {
  assert.equal(
    refineCategoryHint("outdoor", "Daily", ["https://example.com/it/prodotti/divani/daily/"]),
    "outdoor",
  );
});
