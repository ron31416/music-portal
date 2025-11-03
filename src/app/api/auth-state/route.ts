// src/app/api/auth-state/route.ts
import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { isAdminEmail } from "@/lib/isAdmin";

export async function GET() {
    const supabase = await getSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    const user = data.user ?? null;
    const email = user?.email ?? null;
    const admin = isAdminEmail(email);
    return NextResponse.json({ email, admin });
}
