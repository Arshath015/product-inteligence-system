import assert from "node:assert/strict";
import test from "node:test";
import { categoryFromProductUrl, refineCategoryHint } from "../lib/productCategory.ts";

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

test("uses a product's explicit catalogue route before conflicting prose", () => {
  const sourceUrl = "https://www.ditreitalia.com/en/products/armchairs/isla-2/";
  const description = "A natural complement to the sofa, the Isla armchair has soft forms.";

  assert.equal(categoryFromProductUrl(sourceUrl), "armchairs");
  assert.equal(
    categoryFromProductUrl(sourceUrl) ?? refineCategoryHint("sofas", "Isla", [description]),
    "armchairs",
  );
});

test("recognizes localized sofa routes and leaves mixed catalogue routes unclassified", () => {
  assert.equal(categoryFromProductUrl("https://example.com/en/products/sofas-en/daily/"), "sofas");
  assert.equal(categoryFromProductUrl("https://example.com/en/products/sofa-beds/isabel/"), "sofas");
  assert.equal(categoryFromProductUrl("https://example.com/en/products/outdoor-sofas/pacific/"), "outdoor");
  assert.equal(categoryFromProductUrl("https://example.com/en/products/outdoor-armchairs-and-sunbed/nathy/"), "outdoor");
  assert.equal(categoryFromProductUrl("https://example.com/en/products/tables-and-chairs/lucy/"), null);
});
