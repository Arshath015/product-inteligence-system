"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatProvider, useChat } from "@/components/chat/ChatContext";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ProductDetailModal } from "@/components/catalog/ProductDetailModal";
import { useProject } from "@/components/project/ProjectContext";
import { ImportFromProjectDialog } from "@/components/project/ImportFromProjectDialog";
import { CatalogCacheProvider } from "@/components/project/CatalogCacheContext";

const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 400;
const STORAGE_KEY = "altossa-chat-width";
const COLLAPSED_KEY = "altossa-chat-collapsed";

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { projectId, project } = useProject();
  const { selectedProduct, closeProduct, bumpCatalog } = useChat();
  const [mobileView, setMobileView] = useState<"catalogue" | "chat">("catalogue");
  const [chatWidth, setChatWidth] = useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const dragging = useRef(false);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- one-time hydration from a browser-only API (localStorage), not available during SSR */
    const storedWidth = Number(localStorage.getItem(STORAGE_KEY));
    if (storedWidth >= MIN_WIDTH && storedWidth <= MAX_WIDTH) setChatWidth(storedWidth);
    setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, String(chatWidth));
  }, [chatWidth, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed, hydrated]);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (collapsed) return;
      dragging.current = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX));
        setChatWidth(next);
      };
      const onUp = () => {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [collapsed]
  );

  const navLink = (href: string, label: string) => (
    <Link
      href={href}
      className={`text-sm transition-colors ${
        pathname === href ? "text-foreground" : "text-muted hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-border bg-header px-6 py-3">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-3">
            <Link href={`/p/${projectId}`} className="font-serif text-xl tracking-tight text-foreground">
              ALTOSSA
            </Link>
            {project && (
              <>
                <span className="text-muted">/</span>
                <span className="text-sm text-foreground">{project.name}</span>
              </>
            )}
          </div>
          <nav className="hidden items-center gap-6 sm:flex">
            {navLink(`/p/${projectId}`, "Catalogue")}
            {navLink(`/p/${projectId}/brands`, "Brands")}
            {navLink(`/p/${projectId}/manufacturers`, "Manufacturers")}
            {navLink(`/p/${projectId}/inspiration`, "Inspiration")}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="hidden items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground sm:flex"
            title="Import brands, products, or inspiration from another project"
          >
            Import from project
          </button>
          <Link
            href="/"
            className="hidden items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground sm:flex"
            title="Switch project"
          >
            Switch project
          </Link>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="hidden items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground sm:flex"
            title={collapsed ? "Show chat" : "Hide chat"}
          >
            {collapsed ? "Show chat ›" : "‹ Hide chat"}
          </button>
          <div className="flex gap-2 sm:hidden">
            <button
              onClick={() => setMobileView("catalogue")}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                mobileView === "catalogue" ? "bg-accent text-accent-foreground" : "text-muted"
              }`}
            >
              Catalogue
            </button>
            <button
              onClick={() => setMobileView("chat")}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                mobileView === "chat" ? "bg-accent text-accent-foreground" : "text-muted"
              }`}
            >
              Chat
            </button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          style={{ width: collapsed ? 0 : chatWidth }}
          className={`min-w-0 flex-shrink-0 overflow-hidden border-r border-border bg-chat-panel transition-[width] duration-200 ease-out ${
            mobileView === "chat" ? "!w-full flex" : "hidden sm:flex"
          }`}
        >
          <div style={{ width: collapsed ? chatWidth : "100%" }} className="h-full min-w-0 flex-shrink-0 sm:h-full">
            <ChatPanel />
          </div>
        </aside>

        {!collapsed && (
          <div
            onMouseDown={onDragStart}
            className="hidden w-1.5 flex-shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent/30 sm:block"
            title="Drag to resize"
          />
        )}

        <main
          className={`min-h-0 min-w-0 flex-1 overflow-y-auto bg-background ${
            mobileView === "catalogue" ? "block" : "hidden sm:block"
          }`}
        >
          {children}
        </main>
      </div>

      {selectedProduct && <ProductDetailModal product={selectedProduct} onClose={closeProduct} />}
      {showImport && (
        <ImportFromProjectDialog
          projectId={projectId}
          onClose={() => setShowImport(false)}
          onImported={bumpCatalog}
        />
      )}
    </div>
  );
}

export function AppShell({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  return (
    <ChatProvider projectId={projectId}>
      <CatalogCacheProvider>
        <Shell>{children}</Shell>
      </CatalogCacheProvider>
    </ChatProvider>
  );
}
