"use client";

import { useState } from "react";
import { useChat } from "@/components/chat/ChatContext";

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ConversationList({ onClose }: { onClose: () => void }) {
  const { conversations, activeConversationId, switchConversation, newChat, renameConversation, archiveConversation, deleteConversation } =
    useChat();
  const [q, setQ] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const filtered = conversations.filter((c) => (c.title ?? "Untitled").toLowerCase().includes(q.toLowerCase()));

  const startRename = (id: string, current: string) => {
    setEditingId(id);
    setEditValue(current);
  };

  const commitRename = async (id: string) => {
    const title = editValue.trim();
    setEditingId(null);
    if (title) await renameConversation(id, title);
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-chat-panel">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="font-serif text-base text-foreground">Conversations</p>
        <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface">
          ✕
        </button>
      </div>

      <div className="px-4 py-3">
        <button
          onClick={() => {
            newChat();
            onClose();
          }}
          className="w-full rounded-full bg-accent py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover"
        >
          + New chat
        </button>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search conversations…"
          className="mt-2 w-full rounded-full border border-border bg-surface px-3.5 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent"
        />
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-4">
        {filtered.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted">No conversations yet</p>}
        {filtered.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center gap-1 rounded-xl px-2.5 py-2 transition-colors ${
              c.id === activeConversationId ? "bg-surface" : "hover:bg-surface/60"
            }`}
          >
            {editingId === c.id ? (
              <input
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => commitRename(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(c.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
                className="min-w-0 flex-1 rounded border border-accent bg-background px-2 py-1 text-sm text-foreground outline-none"
              />
            ) : (
              <button
                onClick={async () => {
                  await switchConversation(c.id);
                  onClose();
                }}
                className="min-w-0 flex-1 overflow-hidden text-left"
              >
                <p className="truncate text-sm text-foreground">{c.title ?? "Untitled"}</p>
                <p className="text-[11px] text-muted">{timeAgo(c.updated_at)}</p>
              </button>
            )}
            <div className="hidden flex-shrink-0 items-center gap-0.5 group-hover:flex">
              <button
                onClick={() => startRename(c.id, c.title ?? "")}
                title="Rename"
                className="flex h-6 w-6 items-center justify-center rounded text-muted hover:text-foreground"
              >
                ✎
              </button>
              <button
                onClick={() => archiveConversation(c.id)}
                title="Archive"
                className="flex h-6 w-6 items-center justify-center rounded text-muted hover:text-foreground"
              >
                ⌄
              </button>
              <button
                onClick={() => {
                  if (confirm("Delete this conversation? This can't be undone.")) deleteConversation(c.id);
                }}
                title="Delete"
                className="flex h-6 w-6 items-center justify-center rounded text-muted hover:text-danger"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
