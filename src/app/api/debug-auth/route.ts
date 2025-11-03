// src/app/api/debug-auth/route.ts
import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isAdminEmail } from "@/lib/isAdmin";

export async function GET() {
    const supabase = await getSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    const email = data.user?.email ?? null;
    const list = (process.env.ADMIN_EMAILS ?? "")
        .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    return NextResponse.json({
        email,
        adminByServer: isAdminEmail(email),
        adminEmailsEnv: list,
    });
}
