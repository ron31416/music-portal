// src/app/api/user/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { DB_SCHEMA } from "@/lib/dbSchema";
import { z } from "zod";
import { USER_COL } from "@/lib/userCols";
import type { UserListItem, UserListResponse } from "@/lib/types";

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
  user_email: z.string().trim().min(1, "user_email is required"),
  user_first_name: z.string().trim().optional().default(""),
  user_last_name: z.string().trim().optional().default(""),
  user_role_number: z.number().int().positive({ message: "user_role_number must be a positive integer" }),
});
type CanonicalSaveInput = z.infer<typeof CanonicalSaveSchema>;

function isObjectRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

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


// =========================
// POST /api/user (create/update a user)
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
        p_user_email: input.user_email,
        p_user_first_name: input.user_first_name,
        p_user_last_name: input.user_last_name,
        p_user_role_number: input.user_role_number,
      });

    if (error) {
      if (error.code === "23505") {
        return err("conflict", 409, { message: "A user with the same email already exists." });
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


/* =========================
   GET /api/user (list users)
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
