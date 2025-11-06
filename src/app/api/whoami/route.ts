// src/app/api/whoami/route.ts
import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

/**
 * Returns who is signed in and their role.
 * Shape: { ok: true, email: string|null, role: string|null, is_admin: boolean }
 * Logic:
 *  - Local dev override: when on localhost AND DEV_FORCE_ADMIN=1, return admin immediately.
 *  - Otherwise:
 *      If signed out: email=null, role=null, is_admin=false
 *      If signed in:
 *        1) Try DB role from site_user (auth_user_id == auth.uid()).
 *        2) Fallback: if email is in ADMIN_EMAILS (comma-sep), role="admin".
 */
export async function GET(req: Request) {
    const url = new URL(req.url);
    const isLocalHost =
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1";

    // Parse the flag explicitly
    const DEV_FORCE_ADMIN =
        process.env.DEV_FORCE_ADMIN === "1" ||
        process.env.DEV_FORCE_ADMIN?.toLowerCase() === "true";

    // ---- Local-only force-admin hotkey (for UI testing without login) ----
    // Debug: log what we see before deciding
    console.warn("[whoami] host:", url.hostname, {
        isLocalHost,
        DEV_FORCE_ADMIN_raw: process.env.DEV_FORCE_ADMIN,
        DEV_FORCE_ADMIN_parsed: DEV_FORCE_ADMIN,
        DEV_FORCE_EMAIL: process.env.DEV_FORCE_EMAIL,
        DEV_FORCE_ROLE: process.env.DEV_FORCE_ROLE,
    });

    if (isLocalHost && DEV_FORCE_ADMIN) {
        const email = (process.env.DEV_FORCE_EMAIL?.trim() || "dev-adminx@local");
        const role = (process.env.DEV_FORCE_ROLE?.trim() || "admin");
        const is_admin = role === "admin";

        console.warn("[whoami] DEV_FORCE_ADMIN branch taken → spoofing", { email, role, is_admin });
        return NextResponse.json({ ok: true, email, role, is_admin });
    }
    // ---------------------------------------------------------------------

    try {
        const supabase = await getSupabaseServerClient();

        // 1) Auth user
        const { data: ures, error: uerr } = await supabase.auth.getUser();
        const user = ures?.user ?? null;
        const email = (user?.email as string | null) ?? null;

        if (uerr || !user) {
            return NextResponse.json({ ok: true, email: null, role: null, is_admin: false });
        }

        // 2) DB role
        let role: string | null = null;
        const { data: srow } = await supabase
            .from("site_user")
            .select("role")
            .eq("auth_user_id", user.id)
            .single();

        if (srow?.role) { role = String(srow.role); }

        // 3) Fallback to ADMIN_EMAILS
        if (!role && email) {
            const raw = process.env.ADMIN_EMAILS ?? "";
            const list = raw
                .split(",")
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean);
            if (list.includes(email.toLowerCase())) {
                role = "admin";
            }
        }

        const is_admin = role === "admin";
        return NextResponse.json({ ok: true, email, role, is_admin });
    } catch (e) {
        return NextResponse.json(
            { ok: false, error: e instanceof Error ? e.message : String(e) },
            { status: 500 }
        );
    }
}
