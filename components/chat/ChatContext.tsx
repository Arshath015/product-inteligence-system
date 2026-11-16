"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  createConversation,
  deleteConversation as apiDeleteConversation,
  fetchConversation,
  fetchConversations,
  fetchInspirationsByIds,
  fetchProductsByIds,
  streamChatMessage,
  updateConversation,
} from "@/lib/client/api";
import type { Conversation, Inspiration, Product } from "@/lib/types";

export interface BulkProgressLineVM {
  text: string;
  status: "pending" | "success" | "duplicate" | "failed";
}

export interface ChatMessageVM {
  id: string;
  role: "user" | "assistant";
  content: string;
  products?: Product[];
  inspirations?: Inspiration[];
  pending?: boolean;
  bulk?: {
    total: number;
    lines: BulkProgressLineVM[];
    inProgress: boolean;
    failedUrls: string[];
  };
}

interface ChatContextValue {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: ChatMessageVM[];
  sending: boolean;
  catalogVersion: number;
  sendMessage: (text: string) => Promise<void>;
  stopGeneration: () => void;
  newChat: () => void;
  switchConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  archiveConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  selectedProduct: Product | null;
  openProduct: (p: Product) => void;
  closeProduct: () => void;
  bumpCatalog: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageVM[]>([]);
  const [sending, setSending] = useState(false);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const activeId = useRef<string | null>(null);
  const hydrated = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Bulk progress lines buffer — flushed to state max every 200 ms so
  // hundreds of SSE events don't trigger hundreds of re-renders.
  const bulkBufRef = useRef<{ id: string; lines: BulkProgressLineVM[] }>({ id: "", lines: [] });
  const bulkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshConversations = useCallback(async () => {
    const { conversations: list } = await fetchConversations(projectId);
    setConversations(list);
    return list;
  }, [projectId]);

  const loadConversation = useCallback(
    async (id: string) => {
      const { messages: history } = await fetchConversation(projectId, id);
      const productIds = Array.from(new Set(history.flatMap((m) => m.referenced_product_ids ?? [])));
      const inspirationIds = Array.from(new Set(history.flatMap((m) => m.referenced_inspiration_ids ?? [])));
      const [{ products }, { inspirations }] = await Promise.all([
        fetchProductsByIds(projectId, productIds),
        fetchInspirationsByIds(projectId, inspirationIds),
      ]);
      const productById = new Map(products.map((p) => [p.id, p]));
      const inspirationById = new Map(inspirations.map((i) => [i.id, i]));

      activeId.current = id;
      setActiveConversationId(id);
      setMessages(
        history.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          products: (m.referenced_product_ids ?? [])
            .map((pid) => productById.get(pid))
            .filter(Boolean) as Product[],
          inspirations: (m.referenced_inspiration_ids ?? [])
            .map((iid) => inspirationById.get(iid))
            .filter(Boolean) as Inspiration[],
        }))
      );
    },
    [projectId]
  );

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    (async () => {
      const list = await refreshConversations().catch(() => []);
      if (list.length > 0) await loadConversation(list[0].id);
    })();
  }, [refreshConversations, loadConversation]);

  const switchConversation = useCallback(
    async (id: string) => {
      if (id === activeId.current) return;
      await loadConversation(id);
    },
    [loadConversation]
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const newChat = useCallback(() => {
    stopGeneration();
    activeId.current = null;
    setActiveConversationId(null);
    setMessages([]);
  }, [stopGeneration]);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      await updateConversation(projectId, id, { title });
      await refreshConversations();
    },
    [projectId, refreshConversations]
  );

  const archiveConversation = useCallback(
    async (id: string) => {
      await updateConversation(projectId, id, { status: "archived" });
      if (activeId.current === id) newChat();
      await refreshConversations();
    },
    [projectId, refreshConversations, newChat]
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      await apiDeleteConversation(projectId, id);
      if (activeId.current === id) newChat();
      await refreshConversations();
    },
    [projectId, refreshConversations, newChat]
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // Cancel any in-flight request before starting a new one
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const userMsg: ChatMessageVM = { id: `tmp-${Date.now()}`, role: "user", content: trimmed };
      const pendingId = `pending-${Date.now()}`;
      const pendingMsg: ChatMessageVM = { id: pendingId, role: "assistant", content: "", pending: true };
      setMessages((prev) => [...prev, userMsg, pendingMsg]);
      setSending(true);

      // Reset bulk progress buffer for this message
      bulkBufRef.current = { id: pendingId, lines: [] };
      if (bulkTimerRef.current) clearTimeout(bulkTimerRef.current);

      const flushBulkBuf = () => {
        if (bulkTimerRef.current) clearTimeout(bulkTimerRef.current);
        bulkTimerRef.current = null;
        const { id, lines } = bulkBufRef.current;
        if (!lines.length || id !== pendingId) return;
        const toFlush = lines.splice(0);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId && m.bulk ? { ...m, bulk: { ...m.bulk, lines: [...m.bulk.lines, ...toFlush] } } : m
          )
        );
      };

      let streamedText = "";

      try {
        await streamChatMessage(
          projectId,
          trimmed,
          activeId.current,
          {
            onMeta: (conversationId) => {
              if (!activeId.current) {
                activeId.current = conversationId;
                setActiveConversationId(conversationId);
              }
            },
            onBulkStart: (total) => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === pendingId
                    ? { ...m, pending: false, bulk: { total, lines: [], inProgress: true, failedUrls: [] } }
                    : m
                )
              );
            },
            onBulkProgress: (line) => {
              // Buffer lines and flush at most every 200 ms to avoid per-event re-renders
              bulkBufRef.current.lines.push(line);
              if (!bulkTimerRef.current) {
                bulkTimerRef.current = setTimeout(flushBulkBuf, 200);
              }
            },
            onDelta: (delta) => {
              flushBulkBuf(); // flush any pending bulk lines before switching to text
              streamedText += delta;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === pendingId
                    ? { ...m, content: streamedText, pending: false, bulk: m.bulk ? { ...m.bulk, inProgress: false } : undefined }
                    : m
                )
              );
            },
            onDone: (data) => {
              flushBulkBuf();
              activeId.current = data.conversationId;
              setActiveConversationId(data.conversationId);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === pendingId
                    ? {
                        id: `assistant-${Date.now()}`,
                        role: "assistant",
                        content: data.reply,
                        products: data.products,
                        inspirations: data.inspirations,
                        bulk: m.bulk ? { ...m.bulk, inProgress: false, failedUrls: data.failedUrls ?? [] } : undefined,
                      }
                    : m
                )
              );
              if (data.products?.length || data.inspirations?.length) setCatalogVersion((v) => v + 1);
            },
          },
          controller.signal
        );
        await refreshConversations();
      } catch (err) {
        const isAbort = (err as Error).name === "AbortError";
        flushBulkBuf();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? {
                  ...m,
                  pending: false,
                  content: isAbort
                    ? streamedText || "Generation stopped."
                    : `Something went wrong: ${(err as Error).message}`,
                  bulk: m.bulk ? { ...m.bulk, inProgress: false } : undefined,
                }
              : m
          )
        );
        if (!isAbort) return;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setSending(false);
      }
    },
    [projectId, refreshConversations]
  );

  return (
    <ChatContext.Provider
      value={{
        conversations,
        activeConversationId,
        messages,
        sending,
        catalogVersion,
        sendMessage,
        stopGeneration,
        newChat,
        switchConversation,
        renameConversation,
        archiveConversation,
        deleteConversation,
        selectedProduct,
        openProduct: setSelectedProduct,
        closeProduct: () => setSelectedProduct(null),
        bumpCatalog: () => setCatalogVersion((v) => v + 1),
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}

export { createConversation };
