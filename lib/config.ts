function collectGroqKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const v = process.env[`GROQ_API_KEY_${i}`];
    if (v && v.trim()) keys.push(v.trim());
  }
  return keys;
}

export const config = {
  groq: {
    keys: collectGroqKeys(),
    textModel: process.env.GROQ_TEXT_MODEL || "llama-3.3-70b-versatile",
    visionModel:
      process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct",
  },
  tavily: {
    apiKey: process.env.TAVILY_API_KEY || "",
  },
  supabase: {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  },
  storage: {
    bucket: "product-images",
  },
};

export function assertServerConfig() {
  const missing: string[] = [];
  if (config.groq.keys.length === 0) missing.push("GROQ_API_KEY_1..12");
  if (!config.supabase.url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!config.supabase.serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) {
    throw new Error(`Missing required server configuration: ${missing.join(", ")}`);
  }
}
