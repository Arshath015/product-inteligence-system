"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

interface CatalogCacheValue {
  get: <T>(key: string) => T | undefined;
  set: <T>(key: string, data: T) => void;
}

const CatalogCacheContext = createContext<CatalogCacheValue | null>(null);

/**
 * An in-memory cache that lives in the project layout (above the routed
 * Catalogue/Brands/Inspiration pages), so it survives switching between
 * those tabs. Each tab shows its last-fetched data instantly on remount
 * instead of a fresh loading skeleton, then silently revalidates — this is
 * what makes tab switching feel instant instead of re-fetching every time.
 * Reset automatically on project switch since AppShell is remounted with
 * `key={projectId}` there.
 */
export function CatalogCacheProvider({ children }: { children: React.ReactNode }) {
  const cacheRef = useRef(new Map<string, unknown>());

  const get = useCallback(<T,>(key: string) => cacheRef.current.get(key) as T | undefined, []);
  const set = useCallback(<T,>(key: string, data: T) => {
    cacheRef.current.set(key, data);
  }, []);

  return <CatalogCacheContext.Provider value={{ get, set }}>{children}</CatalogCacheContext.Provider>;
}

function useCatalogCache() {
  const ctx = useContext(CatalogCacheContext);
  if (!ctx) throw new Error("useCatalogCache must be used within CatalogCacheProvider");
  return ctx;
}

/**
 * Stale-while-revalidate data fetching scoped to the shared CatalogCache.
 * `revalidateOn` (e.g. catalogVersion) triggers a background refetch of the
 * same key without clearing what's currently shown.
 */
export function useCachedList<T>(key: string, fetchFn: () => Promise<T>, revalidateOn: unknown): {
  data: T | undefined;
  loading: boolean;
} {
  const cache = useCatalogCache();
  const [data, setData] = useState<T | undefined>(() => cache.get<T>(key));
  const [loading, setLoading] = useState(() => cache.get<T>(key) === undefined);

  useEffect(() => {
    let cancelled = false;
    const cached = cache.get<T>(key);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync to the cache entry for this key before revalidating
    setData(cached);
    setLoading(cached === undefined);

    fetchFn()
      .then((result) => {
        if (cancelled) return;
        cache.set(key, result);
        setData(result);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchFn is recreated each render by design; key + revalidateOn fully describe when to refetch
  }, [key, revalidateOn]);

  return { data, loading };
}
