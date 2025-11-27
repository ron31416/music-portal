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

type SaveRequestBody = {
  userId: number;
  songId: number;
  measureNumber: number;
  annotations: unknown; // matches annotations_json JSONB payload
};

type SaveResponseBody = {
  ok: boolean;
  error?: string;
  message?: string;
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
   -> lists all measures for that (user, song)
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

    console.error("user-song-measure route POST error:", e);
    return serverErrorJson(message);
  }
}

/* =========================
   PUT /api/user-song-measure
   Body: {
     userId: number;
     songId: number;
     measureNumber: number;
     annotations: unknown;
   }
   -> upsert a single measure's annotations for that (user, song)
   ========================= */

export async function PUT(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as Partial<SaveRequestBody>;
    const { userId, songId, measureNumber, annotations } = body;

    if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) {
      return badRequestJson("userId must be a positive integer");
    }

    if (typeof songId !== "number" || !Number.isInteger(songId) || songId <= 0) {
      return badRequestJson("songId must be a positive integer");
    }

    if (
      typeof measureNumber !== "number" ||
      !Number.isInteger(measureNumber) ||
      measureNumber <= 0
    ) {
      return badRequestJson("measureNumber must be a positive integer");
    }

    if (typeof annotations === "undefined") {
      return badRequestJson("annotations field is required");
    }

    const supabaseAdmin = getSupabaseAdmin();

    // IMPORTANT: adjust RPC name and parameter names if your function differs.
    // This assumes you have a function:
    //   user_song_measure_insert(p_user_id, p_song_id, p_measure_number, p_annotations_json)
    const { error } = await supabaseAdmin
      .schema(DB_SCHEMA)
      .rpc("user_song_measure_upsert", {
        p_user_id: userId,
        p_song_id: songId,
        p_measure_number: measureNumber,
        p_annotations_json: annotations,
      });

    if (error) {
      console.error("user_song_measure_insert error:", error);
      return NextResponse.json<SaveResponseBody>(
        {
          ok: false,
          error: "supabase_error",
          message: error.message ?? "Failed to save annotations",
        },
        { status: 500 }
      );
    }

    return NextResponse.json<SaveResponseBody>(
      { ok: true },
      { status: 200 }
    );
  } catch (e: unknown) {
    const message =
      e instanceof Error
        ? e.message
        : typeof e === "string"
          ? e
          : "Unexpected error in user-song-measure PUT endpoint";

    console.error("user-song-measure route PUT error:", e);
    return serverErrorJson(message);
  }
}
