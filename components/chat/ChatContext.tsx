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

  const newChat = useCallback(() => {
    activeId.current = null;
    setActiveConversationId(null);
    setMessages([]);
  }, []);

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

      const userMsg: ChatMessageVM = { id: `tmp-${Date.now()}`, role: "user", content: trimmed };
      const pendingId = `pending-${Date.now()}`;
      const pendingMsg: ChatMessageVM = { id: pendingId, role: "assistant", content: "", pending: true };
      setMessages((prev) => [...prev, userMsg, pendingMsg]);
      setSending(true);

      let streamedText = "";

      try {
        await streamChatMessage(projectId, trimmed, activeId.current, {
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
            setMessages((prev) =>
              prev.map((m) => (m.id === pendingId && m.bulk ? { ...m, bulk: { ...m.bulk, lines: [...m.bulk.lines, line] } } : m))
            );
          },
          onDelta: (delta) => {
            streamedText += delta;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === pendingId
                  ? {
                      ...m,
                      content: streamedText,
                      pending: false,
                      bulk: m.bulk ? { ...m.bulk, inProgress: false } : undefined,
                    }
                  : m
              )
            );
          },
          onDone: (data) => {
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
        });
        await refreshConversations();
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? { ...m, pending: false, content: `Something went wrong: ${(err as Error).message}` }
              : m
          )
        );
      } finally {
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
