import type { Brand, Category, ChatMessage, Product } from "@/lib/types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export function fetchCategories() {
  return fetch("/api/categories").then((r) => json<{ categories: (Category & { product_count: number })[] }>(r));
}

export function fetchBrands(q?: string) {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return fetch(`/api/brands${qs}`).then((r) => json<{ brands: (Brand & { product_count: number })[] }>(r));
}

export function fetchBrand(id: string) {
  return fetch(`/api/brands/${id}`).then((r) => json<{ brand: Brand; products: Product[] }>(r));
}

export interface ProductQuery {
  q?: string;
  category?: string;
  brand?: string;
  sort?: "newest" | "name";
}

export function fetchProducts(query: ProductQuery = {}) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.brand) params.set("brand", query.brand);
  if (query.sort) params.set("sort", query.sort);
  return fetch(`/api/products?${params.toString()}`).then((r) => json<{ products: Product[]; total: number }>(r));
}

export function createProduct(payload: Record<string, unknown>) {
  return fetch("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => json<{ product: Product }>(r));
}

export function updateProduct(id: string, payload: Record<string, unknown>) {
  return fetch(`/api/products/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => json<{ product: Product }>(r));
}

export function deleteProduct(id: string) {
  return fetch(`/api/products/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));
}

export function ingestUrl(url: string) {
  return fetch("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).then((r) => json<{ status: string; product: Product | null; message: string }>(r));
}

export function sendChatMessage(message: string, conversationId: string | null) {
  return fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, conversationId }),
  }).then((r) => json<{ conversationId: string; reply: string; products: Product[] }>(r));
}

export function fetchLatestConversation() {
  return fetch("/api/conversations").then((r) =>
    json<{ conversation: { id: string } | null; messages: ChatMessage[] }>(r)
  );
}

export function fetchProductsByIds(ids: string[]) {
  if (ids.length === 0) return Promise.resolve({ products: [] as Product[] });
  return fetch(`/api/products/by-ids?ids=${ids.join(",")}`).then((r) => json<{ products: Product[] }>(r));
}

export function analyzeImage(imageDataUrl: string, question?: string) {
  return fetch("/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageDataUrl, question }),
  }).then((r) => json<{ description: string }>(r));
}
