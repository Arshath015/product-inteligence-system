"use client";

import { useState } from "react";
import { useChat, type BulkProgressLineVM } from "@/components/chat/ChatContext";

const STATUS_CLASS: Record<BulkProgressLineVM["status"], string> = {
  pending: "text-muted/50 italic",
  success: "text-muted/80",
  duplicate: "text-muted/60",
  failed: "text-danger/70",
};

export function BulkProgressCard({
  total,
  lines,
  inProgress,
  failedUrls,
}: {
  total: number;
  lines: BulkProgressLineVM[];
  inProgress: boolean;
  failedUrls: string[];
}) {
  const { sendMessage } = useChat();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="w-full min-w-0 rounded-xl border border-border bg-surface/60">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted transition-colors hover:text-foreground"
      >
        {inProgress && (
          <span className="flex gap-0.5">
            <span className="h-1 w-1 animate-bounce rounded-full bg-muted [animation-delay:-0.2s]" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-muted [animation-delay:-0.1s]" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-muted" />
          </span>
        )}
        <span className="flex-1">
          {inProgress ? `Processing ${total} link${total === 1 ? "" : "s"}…` : `${total} link${total === 1 ? "" : "s"} processed`}
        </span>
        <span className={`transition-transform ${expanded ? "rotate-180" : ""}`}>⌄</span>
      </button>

      {expanded && (
        <div className="max-h-56 overflow-y-auto border-t border-border px-3 py-2">
          {lines.length === 0 ? (
            <p className="text-xs italic text-muted/50">Starting…</p>
          ) : (
            <div className="space-y-1">
              {lines.map((line, i) => (
                <p key={i} className={`whitespace-pre-wrap break-words text-[11px] leading-relaxed ${STATUS_CLASS[line.status]}`}>
                  {line.text}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {!inProgress && failedUrls.length > 0 && (
        <div className="border-t border-border px-3 py-2">
          <button
            onClick={() => sendMessage(failedUrls.join(" "))}
            className="rounded-full border border-danger/40 px-3 py-1 text-xs text-danger transition-colors hover:bg-danger/10"
          >
            Retry {failedUrls.length} failed link{failedUrls.length === 1 ? "" : "s"}
          </button>
        </div>
      )}
    </div>
  );
}
