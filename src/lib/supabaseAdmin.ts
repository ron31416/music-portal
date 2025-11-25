// src/lib/supabaseAdmin.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _admin: SupabaseClient | null = null;

/** Lazily create the Supabase admin client only when actually used (not at import time). */
export function getSupabaseAdmin(): SupabaseClient {
  if (_admin) {
    return _admin;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!url || !serviceRoleKey) {
    // Throw only when a handler actually needs the client at runtime
    throw new Error(
      "Supabase admin is not configured (missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)."
    );
  }

  _admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
  return _admin;
}
