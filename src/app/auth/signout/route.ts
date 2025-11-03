// src/app/auth/signout/route.ts
import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

export async function POST() {
    const supabase = await getSupabaseServerClient();
    await supabase.auth.signOut();
    return NextResponse.json({ ok: true });
}
