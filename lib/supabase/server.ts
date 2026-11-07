/* eslint-disable @typescript-eslint/no-explicit-any -- no generated Database types yet */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "@/lib/config";

// No generated Database types yet (schema lives in supabase/migrations/*.sql
// and is applied by hand in the Supabase dashboard) — use `any` generics so
// table access isn't locked to `never`.
type AnySupabaseClient = SupabaseClient<any, any, any>;

declare global {
  var __altossaSupabaseAdmin: AnySupabaseClient | undefined;
}

/**
 * Service-role Supabase client. Server-only — never import this from a
 * client component. All reads/writes go through our own API routes, which
 * is why RLS locks every table down to the service role.
 */
export function getSupabaseAdmin(): AnySupabaseClient {
  if (!global.__altossaSupabaseAdmin) {
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
      throw new Error(
        "Supabase is not configured yet. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
      );
    }
    global.__altossaSupabaseAdmin = createClient<any, any, any>(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      { auth: { persistSession: false } }
    );
  }
  return global.__altossaSupabaseAdmin;
}
