import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const Module = require("node:module");
const typescript = require("typescript");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  if (path.isAbsolute(request) && !path.extname(request) && require("node:fs").existsSync(`${request}.ts`)) {
    request += ".ts";
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.extensions[".ts"] = (module, filename) => {
  const source = require("node:fs").readFileSync(filename, "utf8");
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  module._compile(output, filename);
};

const {
  collectionAncestorsFromProductUrl,
  discoverPotentialCollectionLinks,
  discoverProductLinks,
  discoverPaginationLinks,
  hasUnlinkedLoadMoreControl,
  isProductListingPage,
} = require("../lib/bulk/discoverLinks.ts");
const { classifyFromSignals } = require("../lib/bulk/classify.ts");

function signals(url, html) {
  return {
    html,
    finalUrl: url,
    title: null,
    metaDescription: null,
    canonicalUrl: null,
    ogImages: [],
    galleryImages: [],
    jsonLd: [],
    jsonLdTypes: [],
    links: [],
    textSnippet: "",
    byline: { brandName: null, designerName: null },
  };
}

test("discovers generic data-url product cards on unknown category routes", () => {
  const url = "https://example.com/en/products/sommier/";
  const page = signals(url, `
    <body><main>
      <div class="product-card" data-url="/en/products/sommier/bed-one/"><img src="/one.jpg"></div>
      <div class="product-card" data-url="/en/products/sommier/bed-two/"><img src="/two.jpg"></div>
      <div class="product-card" data-url="/en/products/sommier/bed-three/"><img src="/three.jpg"></div>
    </main></body>
  `);

  assert.equal(isProductListingPage(page), true);
  assert.equal(classifyFromSignals(url, page), "collection");
  assert.deepEqual(discoverProductLinks(page, 10), [
    "https://example.com/en/products/sommier/bed-one/",
    "https://example.com/en/products/sommier/bed-two/",
    "https://example.com/en/products/sommier/bed-three/",
  ]);
});

test("does not mistake product galleries and related product cards for category pages", () => {
  const url = "https://example.com/en/products/beds/bed-one/";
  const page = signals(url, `
    <body><main class="single-product">
      <div class="product-gallery">
        <img src="/one.jpg"><img src="/two.jpg">
      </div>
      <div class="related-products">
        <a class="product-card" href="/en/products/beds/bed-two/"><img src="/related.jpg"></a>
        <a class="product-card" href="/en/products/beds/bed-three/"><img src="/related-2.jpg"></a>
        <a class="product-card" href="/en/products/beds/bed-four/"><img src="/related-3.jpg"></a>
      </div>
    </main></body>
  `);

  assert.equal(isProductListingPage(page), false);
  assert.equal(classifyFromSignals(url, page), "product");
});

test("ignores site navigation product links while discovering cards", () => {
  const url = "https://example.com/en/products/sommier/";
  const page = signals(url, `
    <body>
      <div class="sub-menu-products"><a href="/en/products/sommier/nav-item/">Navigation item</a></div>
      <main>
        <a class="full-link" href="/en/products/sommier/card-item/"><img src="/card.jpg"></a>
      </main>
    </body>
  `);

  assert.deepEqual(discoverProductLinks(page, 10), [
    "https://example.com/en/products/sommier/card-item/",
  ]);
});

test("infers category ancestors from product URLs without known category names", () => {
  assert.deepEqual(
    collectionAncestorsFromProductUrl("https://example.com/en/products/sommier/bed-one/"),
    ["https://example.com/en/products/sommier/"],
  );
});

test("queues unrecognized catalogue routes for page-content classification", () => {
  const url = "https://example.com/en/";
  const page = signals(url, `<nav><a href="/en/products/sommier/">Sommier</a></nav>`);
  page.links = [
    { href: "https://example.com/en/products/sommier/", text: "Sommier" },
    { href: "https://example.com/en/products/armchairs/", text: "Armchairs" },
  ];

  assert.deepEqual(discoverPotentialCollectionLinks(page, 10), [
    "https://example.com/en/products/sommier/",
  ]);
});

test("follows numbered pages only inside pagination controls", () => {
  const url = "https://example.com/en/products/sommier/";
  const page = signals(url, `
    <body>
      <div class="pagination">
        <a href="?page=2">2</a>
        <a href="?page=3">3</a>
      </div>
      <a href="/en/products/sommier/unrelated/">3</a>
    </body>
  `);

  assert.deepEqual(discoverPaginationLinks(page, 5), [
    "https://example.com/en/products/sommier/?page=2",
    "https://example.com/en/products/sommier/?page=3",
  ]);
});

test("flags unlinked load-more controls rather than implying full discovery", () => {
  const url = "https://example.com/en/products/sommier/";
  const page = signals(url, `<button type="button">Load more products</button>`);

  assert.equal(hasUnlinkedLoadMoreControl(page), true);
  assert.deepEqual(discoverPaginationLinks(page, 5), []);
});
