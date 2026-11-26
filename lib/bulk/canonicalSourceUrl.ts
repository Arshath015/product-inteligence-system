export function canonicalSourceUrl(url: string | null, fallback: string): string {
  try {
    const parsed = new URL(url || fallback);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|_ga)$/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return fallback;
  }
}
