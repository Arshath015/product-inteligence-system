/** Lowercased, punctuation-split word tokens, filtering out short noise and pure numbers. */
export function tokensFrom(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !/^\d+$/.test(t));
}
