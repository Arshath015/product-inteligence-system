import assert from "node:assert/strict";
import test from "node:test";
import { isProductPageUrl } from "../lib/bulk/urlClassification.ts";

test("classifies localized product-category roots as listings", () => {
  assert.equal(isProductPageUrl("https://www.ditreitalia.com/en/products/sofas-en/"), false);
  assert.equal(isProductPageUrl("https://www.ditreitalia.com/en/products/armchairs/"), false);
  assert.equal(isProductPageUrl("https://www.ditreitalia.com/en/products/sofas-en/daily/"), true);
});

test("continues to recognize direct product routes on other catalogue shapes", () => {
  assert.equal(isProductPageUrl("https://pianca.com/en/prodotti/esse-petit-fauteuil/"), true);
  assert.equal(isProductPageUrl("https://example.com/products/daily/"), true);
});
