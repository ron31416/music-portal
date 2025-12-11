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
  songId: number;
};

type UserSongMeasureRow = {
  measure_number: number;
  annotations_json: unknown;
  inserted_datetime: string | null;
  updated_datetime: string | null;
};

type SaveRequestBody = {
  songId: number;
  measureNumber: number;
  annotations: unknown; // matches annotations_json JSONB payload
};

type SaveResponseBody = {
  ok: boolean;
  error?: string;
  message?: string;
};

type WhoAmIResponse = {
  ok: boolean;
  userId: number | null;
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

// Helper: reuse /api/whoami to resolve current user from cookies.
async function getCurrentUserId(req: NextRequest): Promise<number | null> {
  const url = new URL(req.url);
  url.pathname = "/api/whoami";

  const cookieHeader = req.headers.get("cookie") ?? "";

  const res = await fetch(url.toString(), {
    headers: {
      cookie: cookieHeader,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    return null;
  }

  const json = (await res.json()) as WhoAmIResponse;
  return json.ok && json.userId !== null ? json.userId : null;
}

/* =========================
   POST /api/user-song-measure
   Body: { songId: number }
   -> lists all measures for that (user, song)
   ========================= */

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as Partial<ListRequestBody>;
    const { songId } = body;

    if (typeof songId !== "number" || !Number.isInteger(songId) || songId <= 0) {
      return badRequestJson("songId must be a positive integer");
    }

    const userId = await getCurrentUserId(req);
    if (!userId) {
      return unauthorizedJson("You must be signed in to load annotations.");
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
     songId: number;
     measureNumber: number;
     annotations: unknown;
   }
   -> upsert a single measure's annotations for that (user, song)
   ========================= */

export async function PUT(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as Partial<SaveRequestBody>;
    const { songId, measureNumber, annotations } = body;

    const userId = await getCurrentUserId(req);
    if (!userId) {
      return unauthorizedJson("You must be signed in to save annotations.");
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

    const { error } = await supabaseAdmin
      .schema(DB_SCHEMA)
      .rpc("user_song_measure_upsert", {
        p_user_id: userId,
        p_song_id: songId,
        p_measure_number: measureNumber,
        p_annotations_json: annotations,
      });

    if (error) {
      console.error("user_song_measure_upsert error:", error);
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
