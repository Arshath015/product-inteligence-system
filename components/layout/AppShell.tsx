"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChatProvider, useChat } from "@/components/chat/ChatContext";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ProductDetailModal } from "@/components/catalog/ProductDetailModal";

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { selectedProduct, closeProduct } = useChat();
  const [mobileView, setMobileView] = useState<"catalogue" | "chat">("catalogue");

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
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-8">
          <Link href="/" className="font-serif text-xl tracking-tight">
            ALTOSSA
          </Link>
          <nav className="hidden items-center gap-6 sm:flex">
            {navLink("/", "Catalogue")}
            {navLink("/brands", "Brands")}
          </nav>
        </div>
        <div className="flex gap-2 sm:hidden">
          <button
            onClick={() => setMobileView("catalogue")}
            className={`rounded-full px-3 py-1 text-xs ${mobileView === "catalogue" ? "bg-foreground text-background" : "text-muted"}`}
          >
            Catalogue
          </button>
          <button
            onClick={() => setMobileView("chat")}
            className={`rounded-full px-3 py-1 text-xs ${mobileView === "chat" ? "bg-foreground text-background" : "text-muted"}`}
          >
            Chat
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={`w-full border-r border-border sm:w-[380px] sm:flex-shrink-0 ${
            mobileView === "chat" ? "flex" : "hidden sm:flex"
          }`}
        >
          <ChatPanel />
        </aside>
        <main className={`min-h-0 flex-1 overflow-y-auto ${mobileView === "catalogue" ? "block" : "hidden sm:block"}`}>
          {children}
        </main>
      </div>

      {selectedProduct && <ProductDetailModal product={selectedProduct} onClose={closeProduct} />}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ChatProvider>
      <Shell>{children}</Shell>
    </ChatProvider>
  );
}
