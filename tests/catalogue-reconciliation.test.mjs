import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalogueReconciliationPreview } from "../lib/bulk/catalogueReconciliation.ts";
import { categoryFromProductUrl } from "../lib/productCategory.ts";

function product(id, name, category, sourceUrl, imagePaths, duplicateOfId = null) {
  return {
    id,
    brand_id: "brand-1",
    name,
    category_name: category,
    source_url: sourceUrl,
    images: imagePaths.map((path) => `https://cdn.example.com/${path}`),
    duplicate_of_id: duplicateOfId,
  };
}

test("previews only route-obvious category corrections for active products", () => {
  const preview = buildCatalogueReconciliationPreview([
    product("sofa", "Daily", "sofas", "https://example.com/products/armchairs/daily/", []),
    product("archived", "Daily", "sofas", "https://example.com/products/armchairs/daily-copy/", [], "sofa"),
    product("mixed", "Table", "sofas", "https://example.com/products/tables-and-chairs/table/", []),
  ], categoryFromProductUrl);

  assert.deepEqual(preview.categoryCorrections.map(({ id, proposedCategory }) => ({ id, proposedCategory })), [
    { id: "sofa", proposedCategory: "armchairs" },
  ]);
});

test("flags duplicate route aliases only with matching names, route categories, slugs, and three shared images", () => {
  const sharedImages = ["daily-1.jpg", "daily-2.jpg", "daily-3.jpg"];
  const preview = buildCatalogueReconciliationPreview([
    product("alias-a", "Daily", "sofas", "https://example.com/products/sofas/daily/", [...sharedImages, "a.jpg"]),
    product("alias-b", "Daily", "sofas", "https://example.com/products/sofas-en/daily/", [...sharedImages, "b.jpg"]),
    product("low-overlap", "Daily", "sofas", "https://example.com/products/sofas/daily/", ["daily-1.jpg", "daily-2.jpg", "c.jpg"]),
    product("armchair", "Daily", "sofas", "https://example.com/products/armchairs/daily/", [...sharedImages, "d.jpg"]),
  ], categoryFromProductUrl);

  assert.equal(preview.duplicateCandidates.length, 1);
  assert.deepEqual(new Set(preview.duplicateCandidates[0].productIds), new Set(["alias-a", "alias-b"]));
});
