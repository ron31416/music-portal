// src/app/auth/callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

/**
 * Minimal auth callback (no DB writes):
 *  - Validates query params
 *  - Exchanges ?code= for a Supabase session (sets auth cookies)
 *  - Redirects to ?next= (path-only) or "/"
 *  - Emits helpful logs for diagnosing failures
 */
export async function GET(req: NextRequest): Promise<Response> {
    const url = new URL(req.url);

    // Log the full incoming URL for diagnostics (sanitized)
    console.warn("[auth/callback] hit:", {
        origin: url.origin,
        pathname: url.pathname,
        search: url.search, // contains ?code=...&next=...
    });

    // If provider reported an error, surface it
    const providerErr =
        url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (providerErr) {
        console.warn("[auth/callback] provider error:", providerErr);
        return NextResponse.redirect(
            new URL(`/auth/error?message=${encodeURIComponent(providerErr)}`, url.origin)
        );
    }

    // Required authorization code
    const code = url.searchParams.get("code");
    if (!code) {
        console.warn("[auth/callback] missing ?code param");
        return NextResponse.redirect(new URL("/", url.origin));
    }

    // Path-only next (defensive: never allow origins)
    const rawNext = url.searchParams.get("next") || "/";
    const next =
        typeof rawNext === "string" && rawNext.startsWith("/") ? rawNext : "/";

    // Bind Supabase SSR client to this request's cookie jar
    const cookieStore = await cookies();
    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                get(name: string) {
                    return cookieStore.get(name)?.value ?? undefined;
                },
                set(name: string, value: string, options: CookieOptions) {
                    cookieStore.set({ name, value, ...options });
                },
                remove(name: string, options: CookieOptions) {
                    cookieStore.set({ name, value: "", ...options, maxAge: 0 });
                },
            },
        }
    );

    // Exchange the single-use code for a session (sets auth cookies)
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
        // Most common messages:
        // - "Invalid or expired refresh token"
        // - "Code verifier mismatch"
        // - "PKCE code invalid" (often host/redirect mismatch or code used twice)
        console.warn("[auth/callback] exchangeCodeForSession error:", {
            message: error.message,
            origin: url.origin,
            next,
        });

        return NextResponse.redirect(
            new URL(`/auth/error?message=${encodeURIComponent(error.message)}`, url.origin)
        );
    }

    // Success → go where caller asked
    console.warn("[auth/callback] success, redirecting to:", next);
    return NextResponse.redirect(new URL(next, url.origin));
}
