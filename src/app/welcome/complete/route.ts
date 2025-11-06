// src/app/welcome/complete/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest): Promise<Response> {
    const url = new URL(req.url);

    // 1) Parse and validate form input
    const form = await req.formData();
    const rawName = (form.get("displayName") ?? "").toString();
    const displayName = rawName.trim();

    if (displayName.length < 1 || displayName.length > 80) {
        return NextResponse.redirect(
            new URL(`/welcome?err=invalid_name`, url.origin)
        );
    }

    // 2) Read session/email via SSR-bound client (httpOnly cookies)
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

    const { data: sessData, error: sessErr } = await supabase.auth.getSession();
    if (sessErr) {
        console.warn("[welcome/complete] getSession error:", sessErr);
        return NextResponse.redirect(new URL("/login?err=session", url.origin));
    }

    const email = sessData?.session?.user?.email ?? "";
    if (!email) {
        console.warn("[welcome/complete] no email on session");
        return NextResponse.redirect(new URL("/login?err=no_email", url.origin));
    }

    // 3) Service-role client for RPCs (server-only env var)
    const admin = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // 4) If row already exists (race), just go home
    try {
        const { data: rows, error: getErr } = await admin.rpc("user_get", {
            p_user_id: null,
            p_user_email: email,
        });

        if (!getErr && Array.isArray(rows) && rows.length > 0) {
            return NextResponse.redirect(new URL("/", url.origin));
        }
    } catch (e) {
        console.warn("[welcome/complete] user_get exception:", e);
        // fall through to try upsert; worst case we show error
    }

    // 5) Insert via existing upsert (p_user_id=null) with guest role=3
    const { error: upsertErr } = await admin.rpc("user_upsert", {
        p_user_id: null,
        p_user_email: email,
        p_user_first_name: displayName,
        p_user_last_name: "",
        p_user_role_number: 3,
    });

    if (upsertErr) {
        console.warn("[welcome/complete] user_upsert error:", upsertErr);
        return NextResponse.redirect(new URL(`/welcome?err=save_failed`, url.origin));
    }

    // 6) Success → Home
    return NextResponse.redirect(new URL("/", url.origin));
}
