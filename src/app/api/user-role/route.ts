// src/app/api/user-role/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { DB_SCHEMA } from "@/lib/dbSchema";

export async function GET() {
    try {
        // 👇 Lazily initialize Supabase admin client
        const supabaseAdmin = getSupabaseAdmin();

        const { data, error } = await supabaseAdmin
            .schema(DB_SCHEMA)
            .rpc("user_role_list");

        if (error) {
            return new Response(
                JSON.stringify({ error: error.message, code: error.code, hint: error.hint }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        type Row = { user_role_number: number; user_role_name: string };
        const rows = (data ?? []) as Row[];
        const roles = rows.map((r) => ({ number: r.user_role_number, name: r.user_role_name }));

        return new Response(JSON.stringify({ roles }), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            },
        });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
}
