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

export interface ChatMessageVM {
  id: string;
  role: "user" | "assistant";
  content: string;
  products?: Product[];
  inspirations?: Inspiration[];
  pending?: boolean;
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

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageVM[]>([]);
  const [sending, setSending] = useState(false);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const activeId = useRef<string | null>(null);
  const hydrated = useRef(false);

  const refreshConversations = useCallback(async () => {
    const { conversations: list } = await fetchConversations();
    setConversations(list);
    return list;
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const { messages: history } = await fetchConversation(id);
    const productIds = Array.from(new Set(history.flatMap((m) => m.referenced_product_ids ?? [])));
    const inspirationIds = Array.from(new Set(history.flatMap((m) => m.referenced_inspiration_ids ?? [])));
    const [{ products }, { inspirations }] = await Promise.all([
      fetchProductsByIds(productIds),
      fetchInspirationsByIds(inspirationIds),
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
        products: (m.referenced_product_ids ?? []).map((pid) => productById.get(pid)).filter(Boolean) as Product[],
        inspirations: (m.referenced_inspiration_ids ?? [])
          .map((iid) => inspirationById.get(iid))
          .filter(Boolean) as Inspiration[],
      }))
    );
  }, []);

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
      await updateConversation(id, { title });
      await refreshConversations();
    },
    [refreshConversations]
  );

  const archiveConversation = useCallback(
    async (id: string) => {
      await updateConversation(id, { status: "archived" });
      if (activeId.current === id) newChat();
      await refreshConversations();
    },
    [refreshConversations, newChat]
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      await apiDeleteConversation(id);
      if (activeId.current === id) newChat();
      await refreshConversations();
    },
    [refreshConversations, newChat]
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
        await streamChatMessage(trimmed, activeId.current, {
          onMeta: (conversationId) => {
            if (!activeId.current) {
              activeId.current = conversationId;
              setActiveConversationId(conversationId);
            }
          },
          onDelta: (delta) => {
            streamedText += delta;
            setMessages((prev) =>
              prev.map((m) => (m.id === pendingId ? { ...m, content: streamedText, pending: false } : m))
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
    [refreshConversations]
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
