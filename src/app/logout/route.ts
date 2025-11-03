// src/app/logout/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

export async function GET(req: NextRequest): Promise<Response> {
    const supabase = await getSupabaseServerClient();
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/", req.url));
}
