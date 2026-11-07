"use client";

import type { ChatMessageVM } from "@/components/chat/ChatContext";
import { ChatProductCard } from "@/components/chat/ChatProductCard";
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
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[88%] space-y-2 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isUser ? "bg-foreground text-background" : "bg-surface text-foreground"
          }`}
        >
          {message.content}
        </div>
        {message.products && message.products.length > 0 && (
          <div className="flex flex-col gap-2">
            {message.products.map((p) => (
              <ChatProductCard key={p.id} product={p} onOpen={onOpenProduct} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
