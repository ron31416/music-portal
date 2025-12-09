// src/app/api/whoami/route.ts
import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { DB_SCHEMA } from "@/lib/dbSchema";

// =========================
// GET /api/song/[id]
// ========================= 
export async function GET(req: Request) {
  const url = new URL(req.url);
  const isLocalHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";

  const DEV_FORCE_ADMIN =
    process.env.DEV_FORCE_ADMIN === "1" ||
    process.env.DEV_FORCE_ADMIN?.toLowerCase() === "true";

  // ---- Local-only force-admin hotkey (for UI testing without login) ----
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

    console.warn("[whoami] DEV_FORCE_ADMIN branch taken → spoofing", {
      email,
      role,
      is_admin,
    });

    return NextResponse.json({ ok: true, email, role, is_admin });
  }
  // ---------------------------------------------------------------------

  try {
    // 1) Get auth user from the SSR-bound Supabase client (cookie-aware)
    const supabaseServer = await getSupabaseServerClient();
    const { data: ures, error: uerr } = await supabaseServer.auth.getUser();
    const user = ures?.user ?? null;
    const email = (user?.email as string | null) ?? null;

    if (uerr || !user || !email) {
      return NextResponse.json({
        ok: true as const,
        email: null,
        role: null,
        is_admin: false,
      });
    }

    // 2) Look up DB role via user_get(email), using the admin client (service_role)
    const supabaseAdmin = getSupabaseAdmin();

    const { data: userRows, error: userErr } =
      await supabaseAdmin
        .schema(DB_SCHEMA)
        .rpc("user_get", {
          p_user_id: null,
          p_user_email: email,
        });

    let role: string | null = null;

    if (userErr) {
      console.warn("[whoami] user_get RPC error:", userErr);
    } else if (Array.isArray(userRows) && userRows.length > 0) {
      const row = userRows[0];
      if (row && row.user_role_name) {
        role = String(row.user_role_name);
      }
    }

    // 3) Fallback to ADMIN_EMAILS if no DB role
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

    return NextResponse.json({
      ok: true as const,
      email,
      role,
      is_admin,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
