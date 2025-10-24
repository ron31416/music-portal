// src/app/api/song/[id]/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { Buffer } from "node:buffer";
import { DB_SCHEMA } from "@/lib/dbSchema";

/* =========================
   Shared constants / types
   ========================= */

const MXL_MIME = "application/vnd.recordare.musicxml+zip" as const;
// We don't cache since the MXL may be updated during admin edits
const CACHE_CONTROL_NO_STORE = "no-store" as const;

type Row = {
    song_mxl: unknown;
};

/* =========================
   Small helpers
   ========================= */

function badRequest(message: string): Response {
    return new Response(JSON.stringify({ ok: false, error: "bad_request", message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
    });
}
function notFound(message: string): Response {
    return new Response(JSON.stringify({ ok: false, error: "not_found", message }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
    });
}
function serverError(message: string): Response {
    return new Response(JSON.stringify({ ok: false, error: "server_error", message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
    });
}

/** Make a brand-new ArrayBuffer (no SharedArrayBuffer union) */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
    const out = new Uint8Array(u8.byteLength);
    out.set(u8);
    return out.buffer;
}

/** Normalize Supabase/Postgres bytea-like values to a fresh ArrayBuffer */
function normalizeToArrayBuffer(raw: unknown): ArrayBuffer {
    if (raw === null || raw === undefined) {
        throw new Error("song_mxl is null");
    }

    if (typeof raw === "string") {
        // Most common: "\x..." hex string from Postgres bytea
        if (raw.startsWith("\\x")) {
            const hex = raw.slice(2);
            if (hex.length === 0) { throw new Error("song_mxl hex payload is empty"); }
            const u8 = new Uint8Array(Buffer.from(hex, "hex"));
            return toArrayBuffer(u8);
        }
        // Fallback: base64 string
        const trimmed = raw.replace(/\s+/g, "");
        if (trimmed.length === 0) { throw new Error("song_mxl base64 payload is empty"); }
        const u8 = new Uint8Array(Buffer.from(trimmed, "base64"));
        return toArrayBuffer(u8);
    }

    if (raw instanceof Uint8Array) {
        return toArrayBuffer(raw);
    }

    if (Array.isArray(raw)) {
        return toArrayBuffer(Uint8Array.from(raw));
    }

    throw new Error(`Unsupported song_mxl type: ${typeof raw}`);
}

/* =========================
   GET /api/song/[id]
   ========================= */

export async function GET(
    req: NextRequest,
    ctx: { params: Promise<{ id: string }> } // Next.js 15
): Promise<Response> {
    try {
        const { id } = await ctx.params;

        // Guard: digits-only positive integer (reject "1e3", "-1", "abc")
        if (!/^\d+$/.test(id)) {
            return badRequest("id must be a positive integer");
        }
        const songId = Number(id);
        if (!Number.isFinite(songId) || songId <= 0) {
            return badRequest("id must be a positive integer");
        }

        // 👇 Lazily create the admin client at request time
        const supabaseAdmin = getSupabaseAdmin();

        const { data, error } = await supabaseAdmin
            .schema(DB_SCHEMA)
            .rpc("song_mxl_get", { p_song_id: songId });

        if (error) {
            // Database/permission error
            return serverError(error.message);
        }

        const row = Array.isArray(data) && data.length > 0 ? (data[0] as Row) : null;
        if (!row) {
            return notFound("Song not found");
        }

        let ab: ArrayBuffer;
        try {
            ab = normalizeToArrayBuffer(row.song_mxl);
        } catch (e) {
            const message = e instanceof Error ? e.message : "Failed to decode song_mxl";
            return serverError(message);
        }

        if (req.nextUrl.searchParams.get("debug") === "1") {
            return new Response(JSON.stringify({ ok: true, byteLength: ab.byteLength }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        return new Response(ab, {
            status: 200,
            headers: {
                "Content-Type": MXL_MIME,
                "Cache-Control": CACHE_CONTROL_NO_STORE,
            },
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
        return serverError(message);
    }
}
