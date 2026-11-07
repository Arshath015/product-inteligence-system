"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { fetchLatestConversation, fetchProductsByIds, sendChatMessage } from "@/lib/client/api";
import type { Product } from "@/lib/types";

export interface ChatMessageVM {
  id: string;
  role: "user" | "assistant";
  content: string;
  products?: Product[];
  pending?: boolean;
}

interface ChatContextValue {
  messages: ChatMessageVM[];
  sending: boolean;
  catalogVersion: number;
  sendMessage: (text: string) => Promise<void>;
  selectedProduct: Product | null;
  openProduct: (p: Product) => void;
  closeProduct: () => void;
  bumpCatalog: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<ChatMessageVM[]>([]);
  const [sending, setSending] = useState(false);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const conversationId = useRef<string | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    (async () => {
      try {
        const { conversation, messages: history } = await fetchLatestConversation();
        if (!conversation) return;
        conversationId.current = conversation.id;
        const allIds = Array.from(
          new Set(history.flatMap((m) => m.referenced_product_ids ?? []))
        );
        const { products } = await fetchProductsByIds(allIds);
        const byId = new Map(products.map((p) => [p.id, p]));
        setMessages(
          history.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            products: (m.referenced_product_ids ?? [])
              .map((id) => byId.get(id))
              .filter(Boolean) as Product[],
          }))
        );
      } catch {
        // No conversation yet — start fresh silently.
      }
    })();
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const userMsg: ChatMessageVM = { id: `tmp-${Date.now()}`, role: "user", content: trimmed };
    const pendingMsg: ChatMessageVM = { id: `pending-${Date.now()}`, role: "assistant", content: "", pending: true };
    setMessages((prev) => [...prev, userMsg, pendingMsg]);
    setSending(true);

    try {
      const res = await sendChatMessage(trimmed, conversationId.current);
      conversationId.current = res.conversationId;
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== pendingMsg.id)
          .concat({
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: res.reply,
            products: res.products,
          })
      );
      if (res.products?.length) setCatalogVersion((v) => v + 1);
    } catch (err) {
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== pendingMsg.id)
          .concat({
            id: `error-${Date.now()}`,
            role: "assistant",
            content: `Something went wrong: ${(err as Error).message}`,
          })
      );
    } finally {
      setSending(false);
    }
  }, []);

  return (
    <ChatContext.Provider
      value={{
        messages,
        sending,
        catalogVersion,
        sendMessage,
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
