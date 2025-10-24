// src/app/api/user/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { USER_COL } from "@/lib/userCols";
import { DB_SCHEMA } from "@/lib/dbSchema";
import { z } from "zod";

// =========================
// Response helpers / types
// =========================
type OkResponse = { ok: true; user_id: number | null };
type ErrResponse = { ok: false; error: string; message?: string };

function ok(body: OkResponse, status = 200): NextResponse<OkResponse> {
    return NextResponse.json<OkResponse>(body, { status });
}
function err(message: string, status = 400, extra?: { message?: string }): NextResponse<ErrResponse> {
    return NextResponse.json<ErrResponse>({ ok: false, error: message, ...(extra ?? {}) }, { status });
}

// =========================
// Validation
// =========================
const CanonicalSaveSchema = z.object({
    user_id: z.number().int().positive().optional(),
    user_name: z.string().trim().min(1, "user_name is required"),
    user_email: z.string().trim().min(1, "user_email is required"),
    user_first_name: z.string().trim().optional().default(""),
    user_last_name: z.string().trim().optional().default(""),
    user_role_number: z.number().int().positive({ message: "user_role_number must be a positive integer" }),
});
type CanonicalSaveInput = z.infer<typeof CanonicalSaveSchema>;

function isObjectRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === "object" && x !== null;
}

// =========================
// POST /api/user  (create/update a user)
// =========================
export async function POST(req: Request): Promise<NextResponse<OkResponse | ErrResponse>> {
    try {
        const raw = (await req.json()) as unknown;
        if (!isObjectRecord(raw)) {
            return err("Invalid JSON body", 400);
        }

        const candidate: CanonicalSaveInput = {
            user_id: (() => {
                const v = raw[USER_COL.userId];
                if (typeof v === "number" && Number.isInteger(v) && v > 0) { return v; }
                if (typeof v === "string" && /^\d+$/.test(v)) {
                    const n = Number(v);
                    if (Number.isInteger(n) && n > 0) { return n; }
                }
                return undefined;
            })(),
            user_name: String(raw[USER_COL.userName] ?? ""),
            user_email: String(raw[USER_COL.userEmail] ?? ""),
            user_first_name: String(raw[USER_COL.userFirstName] ?? ""),
            user_last_name: String(raw[USER_COL.userLastName] ?? ""),
            user_role_number: Number(raw[USER_COL.userRoleNumber]),
        };

        const parsed = CanonicalSaveSchema.safeParse(candidate);
        if (!parsed.success) {
            const first = parsed.error.issues[0];
            return err(first?.message ?? "Invalid request body", 400);
        }
        const input = parsed.data;

        // 👇 Lazily initialize Supabase admin here
        const supabaseAdmin = getSupabaseAdmin();

        const { data, error } = await supabaseAdmin
            .schema(DB_SCHEMA)
            .rpc("user_upsert", {
                p_user_id: input.user_id ?? null,
                p_user_name: input.user_name,
                p_user_email: input.user_email,
                p_user_first_name: input.user_first_name,
                p_user_last_name: input.user_last_name,
                p_user_role_number: input.user_role_number,
            });

        if (error) {
            if (error.code === "23505") {
                return err("conflict", 409, { message: "A user with the same username or email already exists." });
            }
            if (error.code === "P0002") {
                return err("not_found", 404, { message: "user_id not found for update." });
            }
            return err(error.message ?? "RPC user_upsert failed", 500);
        }

        const userId = typeof data === "number" ? data : null;
        return ok({ ok: true, user_id: userId }, 200);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(msg, 500);
    }
}

// =========================
// DELETE /api/user?id=<user_id>
// =========================
export async function DELETE(req: NextRequest): Promise<NextResponse<OkResponse | ErrResponse>> {
    try {
        const url = new URL(req.url);
        const idRaw = url.searchParams.get("id");
        if (!idRaw) {
            return err("missing_id", 400, { message: "Provide ?id=<user_id> in the query string." });
        }

        const idNum = Number(idRaw);
        if (!Number.isInteger(idNum) || idNum <= 0) {
            return err("invalid_id", 400, { message: "user_id must be a positive integer." });
        }

        // 👇 Lazily initialize Supabase admin here
        const supabaseAdmin = getSupabaseAdmin();

        const { data, error } = await supabaseAdmin
            .schema(DB_SCHEMA)
            .rpc("user_delete", { p_user_id: idNum });

        if (error) {
            if (error.code === "23503") {
                return err("constraint_violation", 409, {
                    message: "Cannot delete: this user is referenced by other records.",
                });
            }
            return err(error.message ?? "RPC user_delete failed", 500);
        }

        const deletedCount = typeof data === "number" ? data : Number(data ?? 0);
        if (deletedCount < 1) {
            return err("not_found", 404, { message: "user_id not found." });
        }

        return ok({ ok: true, user_id: idNum }, 200);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(msg, 500);
    }
}
