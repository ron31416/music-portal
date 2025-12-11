// src/app/api/user-song/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { DB_SCHEMA } from "@/lib/dbSchema";

//=========================
// Types
//========================= */

type UserSongRequestBody = {
  songId: number;
  userId: number;
};

type UserSongRow = {
  user_song_id: number;
  user_id: number;
  song_id: number;
  inserted_datetime: string | null;
  updated_datetime: string | null;
};

//=========================
// Helpers
//========================= */

function badRequestJson(message: string): Response {
  return NextResponse.json(
    { ok: false, error: "bad_request", message },
    { status: 400 }
  );
}

function serverErrorJson(message: string): Response {
  return NextResponse.json(
    { ok: false, error: "server_error", message },
    { status: 500 }
  );
}

// (GET unchanged above…)

/* ============================================================
   POST /api/user-song
   Body: { songId: number, userId: number }
   Behavior:
     - Directly runs user_song_upsert(p_user_id, p_song_id)
     - No Supabase auth lookup (ViewerClient already did that)
   Returns: { ok: true, data: row }
   ============================================================ */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    // 1) Parse body
    const body = (await req.json()) as Partial<UserSongRequestBody>;
    const { songId, userId } = body;

    if (
      typeof songId !== "number" ||
      !Number.isInteger(songId) ||
      songId <= 0
    ) {
      return badRequestJson("songId must be a positive integer");
    }

    if (
      typeof userId !== "number" ||
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      return badRequestJson("userId must be a positive integer");
    }

    // 2) Perform upsert using service role
    const supabaseAdmin = getSupabaseAdmin();

    const { data, error } = await supabaseAdmin
      .schema(DB_SCHEMA)
      .rpc("user_song_upsert", {
        p_user_id: userId,
        p_user_email: null,
        p_song_id: songId,
      });

    if (error) {
      console.error("[user-song POST] user_song_upsert error:", error);
      return serverErrorJson(error.message ?? "Failed to upsert user_song row");
    }

    const rows = Array.isArray(data) ? (data as UserSongRow[]) : [];
    const row = rows.length > 0 ? rows[0] : null;

    return NextResponse.json({ ok: true, data: row }, { status: 200 });
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
