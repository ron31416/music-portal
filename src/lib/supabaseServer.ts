// src/lib/supabaseServer.ts
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function getSupabaseServerClient(): Promise<SupabaseClient> {
    // In newer Next versions, cookies() is async
    const cookieStore = await cookies();

    return createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
        {
            cookies: {
                get(name: string) {
                    return cookieStore.get(name)?.value;
                },
                // In the app router request context, mutation isn't supported. No-ops are fine.
                set(name: string, value: string, options: CookieOptions) {
                    // no-op in app router request context; reference args to satisfy eslint
                    void name; void value; void options;
                },
                remove(name: string, options: CookieOptions) {
                    // no-op in app router request context; reference args to satisfy eslint
                    void name; void options;
                },
            },
        }
    );
}
