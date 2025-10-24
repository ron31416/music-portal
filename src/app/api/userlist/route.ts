// src/app/api/userlist/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { UserListItem, UserListResponse } from "@/lib/types";
import { DB_SCHEMA } from "@/lib/dbSchema";
import { z } from "zod";

/* =========================
   Query validation (Zod)
   ========================= */

// Accept sort and dir as plain strings, no token mapping
const QuerySchema = z.object({
    sort: z.string().optional(),
    dir: z.enum(["asc", "desc"]).optional(),
});

function parseQuery(req: NextRequest): { sort: string | null; dir: "asc" | "desc" } {
    const url = new URL(req.url);
    const raw = {
        sort: url.searchParams.get("sort") ?? null,
        dir: (url.searchParams.get("dir") ?? "asc").toLowerCase(),
    };
    const parsed = QuerySchema.safeParse(raw);
    let sort: string | null = null;
    let dir: "asc" | "desc" = "asc";
    if (parsed.success) {
        const q = parsed.data;
        if (q.sort) { sort = q.sort; }
        if (q.dir === "asc" || q.dir === "desc") { dir = q.dir; }
    }
    return { sort, dir };
}

/* =========================
   GET /api/userlist
   ========================= */

export async function GET(
    req: NextRequest
): Promise<NextResponse<UserListResponse | { error: string }>> {
    try {
        const { sort, dir } = parseQuery(req);

        // 👇 Lazily initialize the Supabase admin client at request time
        const supabaseAdmin = getSupabaseAdmin();

        const { data, error } = await supabaseAdmin
            .schema(DB_SCHEMA)
            .rpc("user_list", {
                p_sort_column: sort,
                p_sort_direction: dir,
            });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        const items = (Array.isArray(data) ? data : []) as UserListItem[];
        return NextResponse.json(
            { items },
            { status: 200, headers: { "Cache-Control": "no-store" } }
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
