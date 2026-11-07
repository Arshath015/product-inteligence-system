"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@/components/chat/ChatContext";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { analyzeImage } from "@/lib/client/api";

export function ChatPanel() {
  const { messages, sending, sendMessage, openProduct } = useChat();
  const [input, setInput] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;
    sendMessage(input);
    setInput("");
  };

  const handleImage = async (file: File) => {
    setAnalyzing(true);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { description } = await analyzeImage(dataUrl);
      setInput((prev) => (prev ? `${prev}\n${description}` : description));
    } catch {
      // ignore — user can just type instead
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <p className="font-serif text-lg tracking-tight">ALTOSSA</p>
        <p className="text-xs text-muted">Luxury design research assistant</p>
      </div>

      <div ref={scrollRef} className="min-w-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="mt-6 space-y-2 text-sm text-muted">
            <p>Paste a product URL, ask for a style, or describe what you&apos;re looking for.</p>
            <p className="italic">&ldquo;Find some Italian lounge chairs&rdquo;</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} onOpenProduct={openProduct} />
        ))}
      </div>

      <form onSubmit={submit} className="border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImage(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={analyzing}
            title="Analyze an image"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted hover:bg-background disabled:opacity-50"
          >
            {analyzing ? "…" : "📷"}
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(e);
              }
            }}
            rows={1}
            placeholder="Message ALTOSSA…"
            className="min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="flex h-8 items-center rounded-full bg-accent px-3 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
