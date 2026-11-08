const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** Trailing punctuation a human sentence tends to leave stuck to a pasted URL. */
function trimTrailingPunctuation(raw: string): string {
  let url = raw;
  while (url.length > 0 && /[.,;:!?)\]}>'"]$/.test(url)) {
    // Keep a closing paren if there's a matching opening one inside the URL.
    if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
    url = url.slice(0, -1);
  }
  return url;
}

/**
 * Deterministically finds every URL in free text — no LLM involved, so this
 * never misses or silently drops one because a model's attention ran out.
 * Order-preserving, exact-string deduped after trimming trailing
 * punctuation a sentence would leave stuck to a pasted link.
 */
export function extractAllUrls(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of matches) {
    const url = trimTrailingPunctuation(raw);
    try {
      new URL(url); // validates it actually parses
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}
