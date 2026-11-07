import { config } from "@/lib/config";

type FailureKind = "rate_limit" | "quota" | "auth" | "other";

interface KeyState {
  key: string;
  cooldownUntil: number; // epoch ms; 0 means healthy
  failures: number;
}

const RATE_LIMIT_COOLDOWN_MS = 60_000;
const QUOTA_OR_AUTH_COOLDOWN_MS = 10 * 60_000;
const GENERIC_COOLDOWN_MS = 5_000;

class GroqKeyManager {
  private states: KeyState[];
  private cursor = 0;

  constructor(keys: string[]) {
    if (keys.length === 0) {
      throw new Error("No Groq API keys configured (GROQ_API_KEY_1..12)");
    }
    this.states = keys.map((key) => ({ key, cooldownUntil: 0, failures: 0 }));
  }

  size() {
    return this.states.length;
  }

  /** Round-robins across keys that are not currently cooling down. */
  acquire(): { key: string; index: number } {
    const now = Date.now();
    for (let step = 0; step < this.states.length; step++) {
      const idx = (this.cursor + step) % this.states.length;
      if (this.states[idx].cooldownUntil <= now) {
        this.cursor = (idx + 1) % this.states.length;
        return { key: this.states[idx].key, index: idx };
      }
    }
    // Every key is cooling down — use whichever recovers soonest rather than hard-fail.
    let best = 0;
    for (let i = 1; i < this.states.length; i++) {
      if (this.states[i].cooldownUntil < this.states[best].cooldownUntil) best = i;
    }
    this.cursor = (best + 1) % this.states.length;
    return { key: this.states[best].key, index: best };
  }

  reportSuccess(index: number) {
    const s = this.states[index];
    if (!s) return;
    s.failures = 0;
    s.cooldownUntil = 0;
  }

  reportFailure(index: number, kind: FailureKind, retryAfterMs?: number) {
    const s = this.states[index];
    if (!s) return;
    s.failures += 1;
    const now = Date.now();
    if (kind === "rate_limit") {
      s.cooldownUntil = now + (retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS);
    } else if (kind === "quota" || kind === "auth") {
      s.cooldownUntil = now + QUOTA_OR_AUTH_COOLDOWN_MS;
    } else {
      s.cooldownUntil = now + GENERIC_COOLDOWN_MS;
    }
  }

  /** Non-secret health snapshot, safe to log/expose. */
  stats() {
    const now = Date.now();
    return this.states.map((s, i) => ({
      index: i,
      healthy: s.cooldownUntil <= now,
      failures: s.failures,
      cooldownRemainingMs: Math.max(0, s.cooldownUntil - now),
    }));
  }
}

declare global {
  var __altossaGroqKeyManager: GroqKeyManager | undefined;
}

export function getGroqKeyManager(): GroqKeyManager {
  if (!global.__altossaGroqKeyManager) {
    global.__altossaGroqKeyManager = new GroqKeyManager(config.groq.keys);
  }
  return global.__altossaGroqKeyManager;
}

export function classifyGroqError(err: unknown): FailureKind {
  const e = err as {
    statusCode?: number;
    status?: number;
    response?: { status?: number };
    message?: string;
  };
  const status = e?.statusCode ?? e?.status ?? e?.response?.status;
  const message = String(e?.message || "").toLowerCase();
  if (status === 429 || message.includes("rate limit")) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (message.includes("quota") || message.includes("insufficient")) return "quota";
  return "other";
}
