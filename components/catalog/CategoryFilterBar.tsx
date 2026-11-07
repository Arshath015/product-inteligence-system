"use client";

import type { Category } from "@/lib/types";

interface CategoryWithCount extends Category {
  product_count: number;
}

export function CategoryFilterBar({
  categories,
  active,
  onSelect,
}: {
  categories: CategoryWithCount[];
  active: string | null;
  onSelect: (slug: string | null) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto px-6 py-3">
      <button
        onClick={() => onSelect(null)}
        className={`flex-shrink-0 rounded-full border px-3.5 py-1.5 text-xs transition-colors ${
          active === null ? "border-foreground bg-foreground text-background" : "border-border text-muted hover:text-foreground"
        }`}
      >
        All
      </button>
      {categories
        .filter((c) => c.product_count > 0)
        .map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c.slug)}
            className={`flex-shrink-0 rounded-full border px-3.5 py-1.5 text-xs transition-colors ${
              active === c.slug ? "border-foreground bg-foreground text-background" : "border-border text-muted hover:text-foreground"
            }`}
          >
            {c.name} <span className="opacity-60">{c.product_count}</span>
          </button>
        ))}
    </div>
  );
}
