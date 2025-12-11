// src/app/api/user-song/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { DB_SCHEMA } from "@/lib/dbSchema";

//=========================
// Types
//========================= */

type UserSongRequestBody = {
  // POST now only needs songId; userId comes from auth email via upsert.
  songId: number;
};

type UserSongRow = {
  user_song_id: number;
  user_id: number;
  song_id: number;
  inserted_datetime: string | null;
  updated_datetime: string | null;
};

//=========================
// Small helpers (JSON responses)
//========================= */

function badRequestJson(message: string): Response {
  return NextResponse.json(
    { ok: false, error: "bad_request", message },
    { status: 400 }
  );
}

function unauthorizedJson(message: string): Response {
  return NextResponse.json(
    { ok: false, error: "unauthorized", message },
    { status: 401 }
  );
}

function serverErrorJson(message: string): Response {
  return NextResponse.json(
    { ok: false, error: "server_error", message },
    { status: 500 }
  );
}

//=========================
// GET /api/user-song
// Query: ?userId=123&songId=456
// Calls: user_song_get(p_user_id, p_song_id)
// Returns: { ok: true, data: UserSongRow | null }
// ========================= */
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const url = new URL(req.url);
    const userIdParam = url.searchParams.get("userId");
    const songIdParam = url.searchParams.get("songId");

    if (!userIdParam || !songIdParam) {
      return badRequestJson("userId and songId query parameters are required");
    }

    const userId = Number(userIdParam);
    const songId = Number(songIdParam);

    if (!Number.isInteger(userId) || userId <= 0) {
      return badRequestJson("userId must be a positive integer");
    }
    if (!Number.isInteger(songId) || songId <= 0) {
      return badRequestJson("songId must be a positive integer");
    }

    const supabaseAdmin = getSupabaseAdmin();

    const { data, error } = await supabaseAdmin
      .schema(DB_SCHEMA)
      .rpc("user_song_get", {
        p_user_id: userId,
        p_song_id: songId,
      });

    if (error) {
      console.error("user_song_get error:", error);
      return serverErrorJson(error.message ?? "Failed to get user_song row");
    }

    const rows = Array.isArray(data) ? (data as UserSongRow[]) : [];
    const row = rows.length > 0 ? rows[0] : null;

    return NextResponse.json(
      {
        ok: true,
        data: row,
      },
      { status: 200 }
    );
  } catch (e: unknown) {
    const message =
      e instanceof Error
        ? e.message
        : typeof e === "string"
          ? e
          : "Unexpected error in user-song GET endpoint";

    console.error("user-song GET route error:", e);
    return serverErrorJson(message);
  }
}

//=========================
// POST /api/user-song
// Body: { songId: number }
// Behavior:
//   - Reads current user from Supabase auth (cookie-bound).
//   - Uses user email to call user_song_upsert(p_user_id=null, p_user_email=email, p_song_id).
//   - Upsert logic lives in the DB (including email→user_id resolution).
// Returns: { ok: true } on success (data optional / null)
//========================= */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    // 1) Parse body
    const body = (await req.json()) as Partial<UserSongRequestBody>;
    const { songId } = body;

    if (typeof songId !== "number" || !Number.isInteger(songId) || songId <= 0) {
      return badRequestJson("songId must be a positive integer");
    }

    // 2) Bind a Supabase SSR client to this request's cookie jar
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value ?? undefined;
          },
          set(name: string, value: string, options: CookieOptions) {
            cookieStore.set({ name, value, ...options });
          },
          remove(name: string, options: CookieOptions) {
            cookieStore.set({ name, value: "", ...options, maxAge: 0 });
          },
        },
      }
    );

    // 3) Read verified session/email from Supabase Auth
    const { data: sessData, error: sessErr } = await supabase.auth.getSession();
    if (sessErr) {
      console.warn("[user-song POST] getSession error:", sessErr);
      return unauthorizedJson("Session read failed");
    }

    const email = sessData?.session?.user?.email ?? null;
    if (!email) {
      return unauthorizedJson("Not signed in");
    }

    // 4) Use service-role client to run the upsert by email
    const supabaseAdmin = getSupabaseAdmin();

    const { data, error } = await supabaseAdmin
      .schema(DB_SCHEMA)
      .rpc("user_song_upsert", {
        p_user_id: null,
        p_user_email: email,
        p_song_id: songId,
      });

    if (error) {
      console.error("[user-song POST] user_song_upsert error:", error);
      return serverErrorJson(error.message ?? "Failed to upsert user_song row");
    }

    const rows = Array.isArray(data) ? (data as UserSongRow[]) : [];
    const row = rows.length > 0 ? rows[0] : null;

    return NextResponse.json(
      { ok: true, data: row },
      { status: 200 }
    );
  } catch (e: unknown) {
    const message =
      e instanceof Error
        ? e.message
        : typeof e === "string"
          ? e
          : "Unexpected error in user-song POST endpoint";

    console.error("[user-song POST] route error:", e);
    return serverErrorJson(message);
  }
}
