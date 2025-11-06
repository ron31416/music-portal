// src/app/auth/callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";

/**
 * Auth callback with onboarding routing:
 *  - Validates query params
 *  - Exchanges ?code= for a Supabase session (sets auth cookies)
 *  - If site_user row exists -> redirect to ?next= (path-only) or "/"
 *  - If missing -> redirect to "/welcome"
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
    const { error: exchangeErr } = await supabase.auth.exchangeCodeForSession(code);

    if (exchangeErr) {
        // Most common messages:
        // - "Invalid or expired refresh token"
        // - "Code verifier mismatch"
        // - "PKCE code invalid" (often host/redirect mismatch or code used twice)
        console.warn("[auth/callback] exchangeCodeForSession error:", {
            message: exchangeErr.message,
            origin: url.origin,
            next,
        });

        return NextResponse.redirect(
            new URL(`/auth/error?message=${encodeURIComponent(exchangeErr.message)}`, url.origin)
        );
    }

    // Read verified session/email
    const { data: sessData, error: sessErr } = await supabase.auth.getSession();
    if (sessErr) {
        console.warn("[auth/callback] getSession error:", sessErr);
        return NextResponse.redirect(new URL("/auth/error?message=session_read_failed", url.origin));
    }

    const email = sessData?.session?.user?.email ?? "";
    if (!email) {
        console.warn("[auth/callback] no email on session");
        return NextResponse.redirect(new URL("/auth/error?message=no_email", url.origin));
    }

    // Use a server-side admin client to call service-role RPCs
    const admin = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY! // make sure this is set in your env (server-only)
    );

    // Check if the site_user row exists for this email
    let hasRow = false;
    try {
        const { data, error: getErr } = await admin.rpc("user_get", {
            p_user_id: null,
            p_user_email: email,
        });

        if (getErr) {
            console.warn("[auth/callback] user_get RPC error:", getErr);
        } else {
            hasRow = Array.isArray(data) && data.length > 0;
        }
    } catch (e) {
        console.warn("[auth/callback] user_get exception:", e);
    }

    // Route: existing user → next/home, first-time → welcome
    const dest = hasRow ? next : "/welcome";
    console.warn("[auth/callback] success, redirecting to:", dest);
    return NextResponse.redirect(new URL(dest, url.origin));
}
