// src/app/api/user-song-measure/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { DB_SCHEMA } from "@/lib/dbSchema";

/* =========================
   Shared types
   ========================= */

type ListRequestBody = {
  userId: number;
  songId: number;
};

type UserSongMeasureRow = {
  measure_number: number;
  annotations_json: unknown;
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
   POST /api/user-song-measure
   Body: { userId: number, songId: number }
   ========================= */

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as Partial<ListRequestBody>;

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
      .rpc("user_song_measure_list", {
        p_user_id: userId,
        p_song_id: songId,
      });

    if (error) {

      console.error("user_song_measure_list error:", error);
      return serverErrorJson(error.message ?? "Failed to load annotations");
    }

    const rows = (Array.isArray(data) ? data : []) as UserSongMeasureRow[];

    return NextResponse.json(
      {
        ok: true,
        data: rows,
      },
      { status: 200 }
    );
  } catch (e: unknown) {
    const message =
      e instanceof Error
        ? e.message
        : typeof e === "string"
          ? e
          : "Unexpected error in user-song-measure endpoint";

    console.error("user-song-measure route error:", e);
    return serverErrorJson(message);
  }
}
