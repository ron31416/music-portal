// src/app/auth/callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function GET(req: NextRequest): Promise<Response> {
    const url = new URL(req.url);

    // provider-reported error?
    const errText =
        url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (errText) {
        return NextResponse.redirect(
            new URL(`/auth/error?message=${encodeURIComponent(errText)}`, url.origin)
        );
    }

    const code = url.searchParams.get("code");
    const next = url.searchParams.get("next") || "/";
    if (!code) {
        return NextResponse.redirect(new URL("/", url.origin));
    }

    // Build SSR client for THIS request (so it can set auth cookies)
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

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
        return NextResponse.redirect(
            new URL(`/auth/error?message=${encodeURIComponent(error.message)}`, url.origin)
        );
    }

    return NextResponse.redirect(new URL(next, url.origin));
}
