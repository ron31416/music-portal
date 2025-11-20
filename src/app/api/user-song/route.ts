// src/app/api/user-song/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { DB_SCHEMA } from "@/lib/dbSchema";

/* =========================
   Types
   ========================= */

type UserSongRequestBody = {
  userId: number;
  songId: number;
};

type UserSongRow = {
  user_song_id: number;
  user_id: number;
  song_id: number;
  inserted_datetime: string | null;
  updated_datetime: string | null;
};

/* =========================
   Small helpers (JSON responses)
   ========================= */

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

/* =========================
   POST /api/user-song
   Body: { userId: number, songId: number }
   Returns: { ok: true, data: UserSongRow | null }
   ========================= */

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as Partial<UserSongRequestBody>;
    const { userId, songId } = body;

    if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) {
      return badRequestJson("userId must be a positive integer");
    }

    if (typeof songId !== "number" || !Number.isInteger(songId) || songId <= 0) {
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
          : "Unexpected error in user-song endpoint";

    console.error("user-song route error:", e);
    return serverErrorJson(message);
  }
}
