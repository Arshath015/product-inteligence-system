import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import { config } from "@/lib/config";
import { classifyGroqError, getGroqKeyManager } from "./keyManager";

/**
 * Runs `fn` against a healthy Groq-backed model, rotating to another key and
 * retrying on rate-limit/quota/auth failures. Tool calls inside `fn` (search,
 * add-product, etc.) must be safe to re-run, since a retry re-executes `fn`
 * from scratch with a fresh model instance.
 */
export async function withGroqRetry<T>(
  fn: (model: LanguageModel) => Promise<T>,
  modelId: string = config.groq.textModel
): Promise<T> {
  const manager = getGroqKeyManager();
  const attempts = Math.max(1, Math.min(4, manager.size()));
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    const { key, index } = manager.acquire();
    const provider = createGroq({ apiKey: key });
    try {
      const result = await fn(provider(modelId));
      manager.reportSuccess(index);
      return result;
    } catch (err) {
      lastErr = err;
      const kind = classifyGroqError(err);
      manager.reportFailure(index, kind);
      if (kind === "other") throw err; // not a key problem — don't burn through keys
    }
  }
  throw lastErr;
}

export function groqHealthSnapshot() {
  return getGroqKeyManager().stats();
}
