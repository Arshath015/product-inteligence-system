import type { Brand, Category, ChatMessage, Conversation, Inspiration, Product } from "@/lib/types";

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

export interface ChatStreamDone {
  conversationId: string;
  reply: string;
  products: Product[];
  inspirations: Inspiration[];
}

/**
 * POSTs to /api/chat and parses the text/event-stream response by hand
 * (EventSource doesn't support POST bodies). Frames are separated by a
 * blank line; each has an `event:` line and a `data:` line of JSON.
 */
export async function streamChatMessage(
  message: string,
  conversationId: string | null,
  handlers: {
    onMeta?: (conversationId: string) => void;
    onDelta?: (text: string) => void;
    onDone?: (data: ChatStreamDone) => void;
  }
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, conversationId }),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const eventMatch = frame.match(/^event: (.+)$/m);
      const dataMatch = frame.match(/^data: (.+)$/m);
      if (!eventMatch || !dataMatch) continue;
      const event = eventMatch[1];
      const data = JSON.parse(dataMatch[1]);
      if (event === "meta") handlers.onMeta?.(data.conversationId);
      else if (event === "delta") handlers.onDelta?.(data.text);
      else if (event === "done") handlers.onDone?.(data as ChatStreamDone);
    }
  }
}

export function fetchProductsByIds(ids: string[]) {
  if (ids.length === 0) return Promise.resolve({ products: [] as Product[] });
  return fetch(`/api/products/by-ids?ids=${ids.join(",")}`).then((r) => json<{ products: Product[] }>(r));
}

export function fetchInspirationsByIds(ids: string[]) {
  if (ids.length === 0) return Promise.resolve({ inspirations: [] as Inspiration[] });
  return fetch(`/api/inspirations/by-ids?ids=${ids.join(",")}`).then((r) =>
    json<{ inspirations: Inspiration[] }>(r)
  );
}

export function analyzeImage(imageDataUrl: string, question?: string) {
  return fetch("/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageDataUrl, question }),
  }).then((r) => json<{ description: string }>(r));
}

export interface InspirationQuery {
  q?: string;
  platform?: string;
  tag?: string;
}

export function fetchInspirations(query: InspirationQuery = {}) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.platform) params.set("platform", query.platform);
  if (query.tag) params.set("tag", query.tag);
  return fetch(`/api/inspirations?${params.toString()}`).then((r) =>
    json<{ inspirations: Inspiration[]; total: number }>(r)
  );
}

export function saveInspirationLink(url: string) {
  return fetch("/api/inspirations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).then((r) => json<{ status: string; inspiration: Inspiration | null; message: string }>(r));
}

export function updateInspiration(id: string, payload: Record<string, unknown>) {
  return fetch(`/api/inspirations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => json<{ inspiration: Inspiration }>(r));
}

export function deleteInspiration(id: string) {
  return fetch(`/api/inspirations/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));
}

export function fetchConversations(q?: string) {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return fetch(`/api/conversations${qs}`).then((r) => json<{ conversations: Conversation[] }>(r));
}

export function createConversation() {
  return fetch("/api/conversations", { method: "POST" }).then((r) => json<{ conversation: Conversation }>(r));
}

export function fetchConversation(id: string) {
  return fetch(`/api/conversations/${id}`).then((r) =>
    json<{ conversation: Conversation; messages: ChatMessage[] }>(r)
  );
}

export function updateConversation(id: string, payload: Record<string, unknown>) {
  return fetch(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => json<{ conversation: Conversation }>(r));
}

export function deleteConversation(id: string) {
  return fetch(`/api/conversations/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));
}
