import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSourceUrl } from "../lib/bulk/canonicalSourceUrl.ts";

test("normalizes product canonical URLs for stable duplicate detection", () => {
  assert.equal(
    canonicalSourceUrl(
      "https://example.com/products/chair/?utm_source=menu&fbclid=tracking#gallery",
      "https://example.com/products/chair/",
    ),
    "https://example.com/products/chair/",
  );
});

test("uses the discovered product URL when the canonical URL is missing or invalid", () => {
  const fallback = "https://example.com/products/chair/";
  assert.equal(canonicalSourceUrl(null, fallback), fallback);
  assert.equal(canonicalSourceUrl("not-a-url", fallback), fallback);
});
