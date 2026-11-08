export type LinkType = "pinterest" | "instagram" | "product";

/**
 * Deterministic (non-LLM) link classification — more reliable than asking
 * the model to guess from the URL string, and it's free.
 */
export function classifyUrl(url: string): LinkType {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "product";
  }
  if (host === "pinterest.com" || host.endsWith(".pinterest.com") || host === "pin.it") return "pinterest";
  if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") return "instagram";
  return "product";
}
