"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@/components/chat/ChatContext";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ConversationList } from "@/components/chat/ConversationList";
import { analyzeImage } from "@/lib/client/api";

const MIN_TEXTAREA_HEIGHT = 36;
const MAX_TEXTAREA_HEIGHT = 200;
// How close to the bottom (px) still counts as "at the bottom" — small
// enough that a user who's deliberately scrolled up even a little keeps
// their position, generous enough to absorb sub-pixel/rounding jitter.
const NEAR_BOTTOM_PX = 120;

export function ChatPanel() {
  const { messages, activeConversationId, sending, sendMessage, openProduct, newChat } = useChat();
  const [input, setInput] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Whether new content should pull the view down with it — true while the
  // user is at (or near) the bottom, or right after they send a message;
  // false the instant they scroll up to read something earlier, so
  // streaming deltas/bulk-progress lines/new messages arriving don't yank
  // them back down.
  const followRef = useRef(true);
  const prevConversationId = useRef<string | null>(null);

  const isNearBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  const scrollToBottom = (behavior: ScrollBehavior) => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior });
  };

  const handleScroll = () => {
    const near = isNearBottom();
    followRef.current = near;
    setShowJumpToLatest(!near);
  };

  const jumpToLatest = () => {
    followRef.current = true;
    setShowJumpToLatest(false);
    scrollToBottom("smooth");
  };

  useEffect(() => {
    // Switching conversations (including the initial load) always jumps to
    // the latest message, regardless of where the previous conversation
    // had been scrolled — this is a fresh view, not a content update.
    const conversationChanged = prevConversationId.current !== activeConversationId;
    prevConversationId.current = activeConversationId;
    if (conversationChanged) {
      followRef.current = true;
      setShowJumpToLatest(false);
      scrollToBottom("auto");
      return;
    }
    if (followRef.current) {
      scrollToBottom("smooth");
      setShowJumpToLatest(false);
    } else {
      setShowJumpToLatest(true);
    }
  }, [messages, activeConversationId]);

  // Grows the composer to fit pasted/typed content (e.g. a block of URLs) up
  // to a cap, then switches to internal scrolling — the surrounding layout
  // and bottom-docked composer position never move.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, MIN_TEXTAREA_HEIGHT), MAX_TEXTAREA_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [input]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;
    // Sending a message always means "follow the response" — even if the
    // user was scrolled up reading earlier history at the time.
    followRef.current = true;
    setShowJumpToLatest(false);
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
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <p className="font-serif text-lg tracking-tight text-foreground">ALTOSSA</p>
          <p className="text-xs text-muted">Luxury design research assistant</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={newChat}
            title="New chat"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted transition-colors hover:border-accent/50 hover:text-foreground"
          >
            +
          </button>
          <button
            onClick={() => setShowHistory(true)}
            title="Conversation history"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted transition-colors hover:border-accent/50 hover:text-foreground"
          >
            ☰
          </button>
        </div>
      </div>

      {showHistory && <ConversationList onClose={() => setShowHistory(false)} />}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-w-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-4 py-4"
      >
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

      {showJumpToLatest && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-[4.5rem] left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface-raised px-3 py-1.5 text-xs text-muted shadow-lg shadow-black/30 transition-colors hover:border-accent/50 hover:text-foreground"
        >
          ↓ Jump to latest
        </button>
      )}

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
            ref={textareaRef}
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
            style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
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
