// src/app/api/skill-level/route.ts
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
            .rpc("skill_level_list");

        if (error) {
            return new Response(
                JSON.stringify({ error: error.message, code: error.code, hint: error.hint }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            );
        }

        type Row = { skill_level_number: number; skill_level_name: string };
        const rows = (data ?? []) as Row[];
        const levels = rows.map((r) => ({
            number: r.skill_level_number,
            name: r.skill_level_name,
        }));

        return new Response(JSON.stringify({ levels }), {
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
