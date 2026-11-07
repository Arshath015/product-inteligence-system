"use client";

import type { ChatMessageVM } from "@/components/chat/ChatContext";
import { ChatProductCard } from "@/components/chat/ChatProductCard";
import { LinkifiedText } from "@/components/chat/LinkifiedText";
import type { Product } from "@/lib/types";

export function MessageBubble({
  message,
  onOpenProduct,
}: {
  message: ChatMessageVM;
  onOpenProduct: (p: Product) => void;
}) {
  const isUser = message.role === "user";

  if (message.pending) {
    return (
      <div className="flex justify-start">
        <div className="flex items-center gap-1 rounded-2xl bg-surface px-4 py-3">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.2s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.1s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex w-full min-w-0 ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`min-w-0 max-w-[88%] space-y-2 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`min-w-0 overflow-hidden whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere] ${
            isUser ? "bg-accent text-accent-foreground" : "bg-surface text-foreground"
          }`}
        >
          <LinkifiedText text={message.content} isUser={isUser} />
        </div>
        {message.products && message.products.length > 0 && (
          <div className="flex min-w-0 flex-col gap-2">
            {message.products.map((p) => (
              <ChatProductCard key={p.id} product={p} onOpen={onOpenProduct} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
