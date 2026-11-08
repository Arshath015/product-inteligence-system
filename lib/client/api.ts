import type { Brand, Category, ChatMessage, Conversation, Inspiration, Product, Project } from "@/lib/types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

// ---- Projects ----

export function fetchProjects(status?: "active" | "archived") {
  const qs = status ? `?status=${status}` : "";
  return fetch(`/api/projects${qs}`).then((r) => json<{ projects: Project[] }>(r));
}

export function fetchProject(id: string) {
  return fetch(`/api/projects/${id}`).then((r) => json<{ project: Project }>(r));
}

export interface ReusePayload {
  sourceProjectId: string;
  allProducts?: boolean;
  allBrands?: boolean;
  allInspirations?: boolean;
  productIds?: string[];
  brandIds?: string[];
  inspirationIds?: string[];
}

export function createProject(payload: { name: string; clientName?: string; description?: string; reuse?: ReusePayload }) {
  return fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => json<{ project: Project }>(r));
}

export function updateProject(id: string, payload: Record<string, unknown>) {
  return fetch(`/api/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => json<{ project: Project }>(r));
}

export function deleteProject(id: string) {
  return fetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));
}

export function reuseIntoProject(projectId: string, payload: ReusePayload) {
  return fetch(`/api/projects/${projectId}/reuse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => json<{ ok: true }>(r));
}

export function removeProjectReference(
  projectId: string,
  target: { productId?: string; brandId?: string; inspirationId?: string }
) {
  return fetch(`/api/projects/${projectId}/reuse`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
  }).then((r) => json<{ ok: true }>(r));
}

// ---- Categories / Brands / Products (project-scoped) ----

export function fetchCategories(projectId: string) {
  return fetch(`/api/categories?projectId=${projectId}`).then((r) =>
    json<{ categories: (Category & { product_count: number })[] }>(r)
  );
}

export function fetchBrands(projectId: string, q?: string) {
  const params = new URLSearchParams({ projectId });
  if (q) params.set("q", q);
  return fetch(`/api/brands?${params.toString()}`).then((r) =>
    json<{ brands: (Brand & { product_count: number; is_owner: boolean })[] }>(r)
  );
}

export function fetchBrand(projectId: string, id: string) {
  return fetch(`/api/brands/${id}?projectId=${projectId}`).then((r) =>
    json<{ brand: Brand; products: Product[] }>(r)
  );
}

export function deleteBrand(projectId: string, id: string) {
  return fetch(`/api/brands/${id}?projectId=${projectId}`, { method: "DELETE" }).then((r) =>
    json<{ ok: true; removedReferenceOnly?: boolean }>(r)
  );
}

export interface ProductQuery {
  q?: string;
  category?: string;
  brand?: string;
  sort?: "newest" | "name";
  limit?: number;
}

export function fetchProducts(projectId: string, query: ProductQuery = {}) {
  const params = new URLSearchParams({ projectId });
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.brand) params.set("brand", query.brand);
  if (query.sort) params.set("sort", query.sort);
  if (query.limit) params.set("limit", String(query.limit));
  return fetch(`/api/products?${params.toString()}`).then((r) => json<{ products: Product[]; total: number }>(r));
}

export function createProduct(projectId: string, payload: Record<string, unknown>) {
  return fetch("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, projectId }),
  }).then((r) => json<{ product: Product }>(r));
}

export function updateProduct(projectId: string, id: string, payload: Record<string, unknown>) {
  return fetch(`/api/products/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, projectId }),
  }).then((r) => json<{ product: Product }>(r));
}

export function deleteProduct(projectId: string, id: string) {
  return fetch(`/api/products/${id}?projectId=${projectId}`, { method: "DELETE" }).then((r) =>
    json<{ ok: true; removedReferenceOnly?: boolean }>(r)
  );
}

export function ingestUrl(projectId: string, url: string) {
  return fetch("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, projectId }),
  }).then((r) => json<{ status: string; product: Product | null; message: string }>(r));
}

export interface ChatStreamDone {
  conversationId: string;
  reply: string;
  products: Product[];
  inspirations: Inspiration[];
  failedUrls?: string[];
}

export interface BulkProgressLine {
  text: string;
  status: "pending" | "success" | "duplicate" | "failed";
}

/**
 * POSTs to /api/chat and parses the text/event-stream response by hand
 * (EventSource doesn't support POST bodies). Frames are separated by a
 * blank line; each has an `event:` line and a `data:` line of JSON.
 */
export async function streamChatMessage(
  projectId: string,
  message: string,
  conversationId: string | null,
  handlers: {
    onMeta?: (conversationId: string) => void;
    onDelta?: (text: string) => void;
    onDone?: (data: ChatStreamDone) => void;
    onBulkStart?: (total: number) => void;
    onBulkProgress?: (line: BulkProgressLine) => void;
  }
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, conversationId, projectId }),
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
      else if (event === "bulk_start") handlers.onBulkStart?.(data.total);
      else if (event === "bulk_progress") handlers.onBulkProgress?.(data as BulkProgressLine);
    }
  }
}

export function fetchProductsByIds(projectId: string, ids: string[]) {
  if (ids.length === 0) return Promise.resolve({ products: [] as Product[] });
  return fetch(`/api/products/by-ids?projectId=${projectId}&ids=${ids.join(",")}`).then((r) =>
    json<{ products: Product[] }>(r)
  );
}

export function fetchInspirationsByIds(projectId: string, ids: string[]) {
  if (ids.length === 0) return Promise.resolve({ inspirations: [] as Inspiration[] });
  return fetch(`/api/inspirations/by-ids?projectId=${projectId}&ids=${ids.join(",")}`).then((r) =>
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
  limit?: number;
}

export function fetchInspirations(projectId: string, query: InspirationQuery = {}) {
  const params = new URLSearchParams({ projectId });
  if (query.q) params.set("q", query.q);
  if (query.platform) params.set("platform", query.platform);
  if (query.tag) params.set("tag", query.tag);
  if (query.limit) params.set("limit", String(query.limit));
  return fetch(`/api/inspirations?${params.toString()}`).then((r) =>
    json<{ inspirations: Inspiration[]; total: number }>(r)
  );
}

export function saveInspirationLink(projectId: string, url: string) {
  return fetch("/api/inspirations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, projectId }),
  }).then((r) => json<{ status: string; inspiration: Inspiration | null; message: string }>(r));
}

export function updateInspiration(projectId: string, id: string, payload: Record<string, unknown>) {
  return fetch(`/api/inspirations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, projectId }),
  }).then((r) => json<{ inspiration: Inspiration }>(r));
}

export function deleteInspiration(projectId: string, id: string) {
  return fetch(`/api/inspirations/${id}?projectId=${projectId}`, { method: "DELETE" }).then((r) =>
    json<{ ok: true }>(r)
  );
}

export function fetchConversations(projectId: string, q?: string) {
  const params = new URLSearchParams({ projectId });
  if (q) params.set("q", q);
  return fetch(`/api/conversations?${params.toString()}`).then((r) => json<{ conversations: Conversation[] }>(r));
}

export function createConversation(projectId: string) {
  return fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
  }).then((r) => json<{ conversation: Conversation }>(r));
}

export function fetchConversation(projectId: string, id: string) {
  return fetch(`/api/conversations/${id}?projectId=${projectId}`).then((r) =>
    json<{ conversation: Conversation; messages: ChatMessage[] }>(r)
  );
}

export function updateConversation(projectId: string, id: string, payload: Record<string, unknown>) {
  return fetch(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, projectId }),
  }).then((r) => json<{ conversation: Conversation }>(r));
}

export function deleteConversation(projectId: string, id: string) {
  return fetch(`/api/conversations/${id}?projectId=${projectId}`, { method: "DELETE" }).then((r) =>
    json<{ ok: true }>(r)
  );
}
